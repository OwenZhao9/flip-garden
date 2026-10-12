// Reads what the Gardener needs from the chain (read-only): the book, this account's live orders, balances, gas price and,
// when the mandate allows hedging, the Perpl account. Order ids are learned from the account's own flip-order events,
// scanned incrementally (the public RPC allows 100 blocks per eth_getLogs), plus any ids the page already knows.
import { decodeLog, TOPICS } from '../events.ts';
import { keccak256 } from '../keccak.ts';
import { readSnapshot, type Env } from '../flow.ts';
import { CHAIN, sameAddress } from '../plant.ts';
import { readPerplState } from '../perpl/hedgeflow.ts';
import type { GOrder, HedgeView, Observation } from './policy.ts';

const word = (x: bigint): string => x.toString(16).padStart(64, '0');
const words = (data: string): bigint[] => (data.slice(2).match(/.{64}/g) ?? []).map((w) => BigInt('0x' + w));
const S_ORDERS = keccak256('s_orders(uint40)').slice(0, 10);

// One order with its flip price (src/rpc.ts `order` omits it).
export async function readOrder(rpc: Env['rpc'], id: bigint, block: number | 'latest' = 'latest'): Promise<{ owner: string; size: bigint; price: bigint; flipPrice: bigint; isBuy: boolean }> {
  const tag = block === 'latest' ? 'latest' : '0x' + block.toString(16);
  const w = words(await rpc.call<string>('eth_call', [{ to: CHAIN.market, data: S_ORDERS + word(id) }, tag]));
  return { owner: '0x' + w[0].toString(16).padStart(40, '0'), size: w[1], price: w[5], flipPrice: w[6], isBuy: w[7] === 1n };
}

export const MAX_LOG_RANGE = 100;

export type ObserverOptions = { hedge: () => boolean; knownIds?: () => bigint[]; now?: () => number; maxScanPerRead?: number };

export class Observer {
  private ids = new Set<bigint>();
  private scannedTo: number;
  private mids: bigint[] = [];
  private readonly env: Env;
  private readonly o: ObserverOptions;
  constructor(env: Env, startBlock: number, o: ObserverOptions) {
    this.env = env;
    this.o = o;
    this.scannedTo = startBlock - 1;
  }

  addIds(ids: bigint[]): void {
    ids.forEach((i) => this.ids.add(i));
  }

  // New order ids of this account since the last read (FlipOrderCreated and FlippedOrderCreated carry the owner).
  private async scan(head: number): Promise<void> {
    const limit = this.o.maxScanPerRead ?? 20;
    let n = 0;
    while (this.scannedTo < head && n++ < limit) {
      const from = this.scannedTo + 1;
      const to = Math.min(head, from + MAX_LOG_RANGE - 1);
      const logs = await this.env.rpc.getLogs({ address: CHAIN.market, topics: [[TOPICS.FlipOrderCreated, TOPICS.FlippedOrderCreated]], fromBlock: from, toBlock: to });
      for (const l of logs) {
        const e = decodeLog(l);
        if (e && (e.name === 'FlipOrderCreated' || e.name === 'FlippedOrderCreated') && sameAddress(e.owner, this.env.account)) this.ids.add(e.orderId);
      }
      this.scannedTo = to;
    }
  }

  async read(): Promise<Observation> {
    const now = this.o.now ?? (() => Date.now());
    const rpc = this.env.rpc;
    const snap = await readSnapshot(rpc, this.env.account);
    await this.scan(snap.block);
    for (const id of this.o.knownIds?.() ?? []) this.ids.add(id);
    const orders: GOrder[] = [];
    for (const id of [...this.ids]) {
      const x = await readOrder(rpc, id);
      if (sameAddress(x.owner, this.env.account) && x.size > 0n) orders.push({ id, isBuy: x.isBuy, price: x.price, flipPrice: x.flipPrice, size: x.size });
      else this.ids.delete(id); // filled or cancelled: a flipped order comes back under a new id through the scan
    }
    let hedge: HedgeView | null = null;
    if (this.o.hedge()) {
      try {
        const st = await readPerplState(rpc, this.env.account);
        const short = st.position && st.position.positionType === 1 ? st.position.lotLNS : 0n;
        hedge = {
          hasAccount: st.account !== null && st.account.frozen === 0,
          freeCNS: st.account?.balanceCNS ?? 0n,
          shortLot: short,
          otherExposure: st.otherPositions.length > 0 || st.restingOrders > 0 || (st.position !== null && st.position.positionType !== 1),
        };
      } catch {
        hedge = null; // unreadable: the hedge question is not asked this time
      }
    }
    const gasPriceWei = BigInt(await rpc.call<string>('eth_gasPrice', []));
    if (snap.book.bestBid > 0n && snap.book.bestAsk > snap.book.bestBid) this.mids = [...this.mids, (snap.book.bestBid + snap.book.bestAsk) / 2n].slice(-20);
    return {
      block: snap.block,
      readAtMs: now(),
      market: snap.market,
      book: snap.book,
      mids: [...this.mids],
      orders,
      walletMon: snap.walletMon,
      marginUsdc: snap.marginUsdc,
      marginMon: snap.marginMon,
      hedge,
      gasPriceWei,
    };
  }
}

