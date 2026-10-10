// Thin read-only JSON-RPC adapter (fetch, no dependencies). It never signs or sends anything:
// only eth_blockNumber, eth_getLogs, eth_call, eth_getBalance, eth_getTransactionByHash,
// eth_getTransactionReceipt.
import { keccak256 } from './keccak.ts';
import type { RawLog } from './events.ts';
import type { LogFilter, LogSource } from './scan.ts';
import type { OwnTx } from './ledger.ts';
import type { ChainOrder, ChainState } from './reconcile.ts';
import { NATIVE, type Market } from './units.ts';

const hex = (n: number | bigint): string => '0x' + n.toString(16);
const word = (x: bigint): string => x.toString(16).padStart(64, '0');
const addrWord = (a: string): string => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const selector = (sig: string): string => keccak256(sig).slice(0, 10);
const words = (data: string): bigint[] => (data.slice(2).match(/.{64}/g) ?? []).map((w) => BigInt('0x' + w));
const asAddr = (w: bigint): string => '0x' + w.toString(16).padStart(40, '0');

export class JsonRpc implements LogSource {
  private id = 1;
  readonly url: string;
  readonly opts: { retries?: number; fetch?: typeof fetch };
  constructor(url: string, opts: { retries?: number; fetch?: typeof fetch } = {}) {
    this.url = url;
    this.opts = opts;
  }

  async call<T>(method: string, params: unknown[]): Promise<T> {
    const f = this.opts.fetch ?? fetch;
    const retries = this.opts.retries ?? 6;
    for (let i = 0; ; i++) {
      try {
        const res = await f(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: this.id++, method, params }),
        });
        const j = (await res.json()) as { result?: T; error?: unknown };
        if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
        return j.result as T;
      } catch (e) {
        if (i >= retries) throw e;
        await new Promise((r) => setTimeout(r, 300 * 2 ** Math.min(i, 5)));
      }
    }
  }

  async blockNumber(): Promise<number> {
    return Number(BigInt(await this.call<string>('eth_blockNumber', [])));
  }

  getLogs(f: LogFilter): Promise<RawLog[]> {
    return this.call<RawLog[]>('eth_getLogs', [{ address: f.address, topics: f.topics, fromBlock: hex(f.fromBlock), toBlock: hex(f.toBlock) }]);
  }

  private ethCall(to: string, data: string, block: number | 'latest'): Promise<string> {
    return this.call<string>('eth_call', [{ to, data }, block === 'latest' ? 'latest' : hex(block)]);
  }

  async marketParams(address: string, block: number | 'latest' = 'latest'): Promise<Market> {
    const w = words(await this.ethCall(address, selector('getMarketParams()'), block));
    return {
      address: address.toLowerCase(),
      pricePrecision: w[0],
      sizePrecision: w[1],
      baseAsset: asAddr(w[2]),
      baseDecimals: Number(w[3]),
      quoteAsset: asAddr(w[4]),
      quoteDecimals: Number(w[5]),
      tickSize: w[6],
      minSize: w[7],
      maxSize: w[8],
      takerFeeBps: w[9],
      makerFeeBps: w[10],
    };
  }

  // Best bid / ask in order-price units (bestBidAsk() is 1e18-scaled).
  async bestBidAsk(m: Market, block: number | 'latest' = 'latest'): Promise<{ bestBid: bigint; bestAsk: bigint }> {
    const w = words(await this.ethCall(m.address, selector('bestBidAsk()'), block));
    const f = 10n ** 18n / m.pricePrecision;
    return { bestBid: w[0] / f, bestAsk: w[1] / f };
  }

  async order(market: string, id: bigint, block: number | 'latest' = 'latest'): Promise<ChainOrder> {
    const w = words(await this.ethCall(market, selector('s_orders(uint40)') + word(id), block));
    // (ownerAddress, size, prev, next, flippedId, price, flippedPrice, isBuy)
    return { market: market.toLowerCase(), id, owner: asAddr(w[0]), size: w[1], price: w[5], isBuy: w[7] === 1n };
  }

  async marginBalance(marginAccount: string, user: string, token: string, block: number | 'latest' = 'latest'): Promise<bigint> {
    const w = words(await this.ethCall(marginAccount, selector('getBalance(address,address)') + addrWord(user) + addrWord(token), block));
    return w[0];
  }

  async walletBalance(user: string, token: string, block: number | 'latest' = 'latest'): Promise<bigint> {
    const tag = block === 'latest' ? 'latest' : hex(block);
    if (token.toLowerCase() === NATIVE) return BigInt(await this.call<string>('eth_getBalance', [user, tag]));
    const w = words(await this.ethCall(token, selector('balanceOf(address)') + addrWord(user), block));
    return w[0];
  }

  // Gas actually charged: Monad bills gasLimit × effectiveGasPrice (verified 2026-10-10).
  async ownTxs(account: string, hashes: string[]): Promise<OwnTx[]> {
    const out: OwnTx[] = [];
    for (const h of hashes) {
      const [tx, rc] = await Promise.all([
        this.call<Record<string, string>>('eth_getTransactionByHash', [h]),
        this.call<Record<string, string>>('eth_getTransactionReceipt', [h]),
      ]);
      if (!tx || !rc || rc.from.toLowerCase() !== account.toLowerCase()) continue;
      out.push({
        hash: h.toLowerCase(),
        block: Number(BigInt(rc.blockNumber)),
        from: rc.from.toLowerCase(),
        gasLimit: BigInt(tx.gas),
        gasUsed: BigInt(rc.gasUsed),
        effectiveGasPrice: BigInt(rc.effectiveGasPrice),
        status: Number(BigInt(rc.status)),
      });
    }
    return out;
  }

  // Everything the reconciler compares against, at one block.
  async chainState(o: {
    account: string;
    marginAccount: string;
    markets: Market[];
    orderIds: Array<{ market: string; id: bigint }>;
    block: number;
    wallet?: boolean;
  }): Promise<ChainState> {
    const tokens = [...new Set(o.markets.flatMap((m) => [m.baseAsset, m.quoteAsset]).concat(NATIVE))];
    const margin: Record<string, bigint> = {};
    const wallet: Record<string, bigint> = {};
    for (const t of tokens) {
      margin[t] = await this.marginBalance(o.marginAccount, o.account, t, o.block);
      if (o.wallet) wallet[t] = await this.walletBalance(o.account, t, o.block);
    }
    const orders: ChainOrder[] = [];
    for (const { market, id } of o.orderIds) orders.push(await this.order(market, id, o.block));
    return { block: o.block, margin, orders, wallet: o.wallet ? wallet : undefined };
  }
}
