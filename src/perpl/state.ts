// Read model for the Perpl exchange: a wallet's account, positions, open orders and fills, read
// from the public Monad RPC with eth_call and eth_getLogs only. Nothing here can write.
//
// Decoders take raw return data (hex), so tests can feed them fixtures captured from live
// read-only calls and compare against ethers.
import { addressWord, call, splitWords, uintWord, wordToAddress, wordToBool, wordToInt, wordToUint } from './abi.ts';
import { EVENT_TOPICS, decodePerplLog, fieldOf, type PerplEvent, type RawLog } from './events.ts';
import type { LogSource } from '../scan.ts';
import { planWindows } from '../scan.ts';

export interface EthCall {
  call<T>(method: string, params: unknown[]): Promise<T>;
}

const u = wordToUint;

// ---- decoders ----

export type Account = {
  accountId: bigint;
  balanceCNS: bigint; // free collateral (AUSD, 6 decimals)
  lockedBalanceCNS: bigint; // collateral locked by resting orders
  frozen: number;
  address: string;
  positionBanks: bigint[]; // bitmap: bit p of bank b set = a position in perpetual b*256+p
};

export function decodeAccount(data: string): Account {
  const w = splitWords(data);
  if (w.length !== 9) throw new Error(`getAccount*: expected 9 words, got ${w.length}`);
  return { accountId: u(w[0]), balanceCNS: u(w[1]), lockedBalanceCNS: u(w[2]), frozen: Number(u(w[3])), address: wordToAddress(w[4]), positionBanks: w.slice(5, 9).map(u) };
}

export function perpIdsWithPosition(a: Pick<Account, 'positionBanks'>): number[] {
  const out: number[] = [];
  a.positionBanks.forEach((bank, b) => {
    for (let p = 0; p < 256; p++) if ((bank >> BigInt(p)) & 1n) out.push(b * 256 + p);
  });
  return out;
}

export type Position = {
  accountId: bigint;
  positionType: number; // 0 = long, 1 = short (PositionOpened events: type 1 for an OpenShort)
  depositCNS: bigint; // collateral posted into this position
  pricePNS: bigint; // entry price
  lotLNS: bigint;
  entryBlock: bigint;
  pnlCNS: bigint;
  deltaPnlCNS: bigint;
  premiumPnlCNS: bigint; // accumulated funding
  priceResiduePNSQ16: bigint;
  markPricePNS: bigint;
  markPriceValid: boolean;
};

export function decodePosition(data: string): Position {
  const w = splitWords(data);
  if (w.length !== 14) throw new Error(`getPositionV2: expected 14 words, got ${w.length}`);
  return {
    accountId: u(w[0]),
    // w[1], w[2]: neighbours in the exchange's linked list of positions
    positionType: Number(u(w[3])),
    depositCNS: u(w[4]),
    pricePNS: u(w[5]),
    lotLNS: u(w[6]),
    entryBlock: u(w[7]),
    pnlCNS: wordToInt(w[8]),
    deltaPnlCNS: wordToInt(w[9]),
    premiumPnlCNS: wordToInt(w[10]),
    priceResiduePNSQ16: u(w[11]),
    markPricePNS: u(w[12]),
    markPriceValid: wordToBool(w[13]),
  };
}

export type PerpetualInfo = {
  priceDecimals: number;
  lotDecimals: number;
  priceTolPer100K: bigint;
  positionBalanceCNS: bigint;
  insuranceBalanceCNS: bigint;
  markPNS: bigint;
  markTimestamp: bigint;
  lastPNS: bigint;
  oraclePNS: bigint;
  oracleTimestampSec: bigint;
  longOpenInterestLNS: bigint;
  shortOpenInterestLNS: bigint;
  fundingStartBlock: bigint;
  fundingRatePct100k: bigint; // per funding interval (about one hour), in hundred-thousandths of a percent
  absFundingClampPctPer100K: bigint;
  status: number;
  basePricePNS: bigint;
  maxBidPriceONS: bigint; // best bid on the book (order-price units; add basePricePNS for a price)
  minBidPriceONS: bigint; // lowest bid price the exchange accepts
  maxAskPriceONS: bigint; // highest ask price the exchange accepts
  minAskPriceONS: bigint; // best ask on the book
  numOrders: bigint;
};

// getPerpetualInfoV2 returns a dynamic tuple whose first two members are strings. The tuple head
// holds one slot per member (31 slots); a string slot is an offset, every other slot is the value.
const PERP_SLOTS = [
  'name', 'symbol', 'priceDecimals', 'lotDecimals', 'linkFeedId', 'priceTolPer100K', 'marginTol', 'marginTolDecimals', 'refPriceMaxAgeSec',
  'positionBalanceCNS', 'insuranceBalanceCNS', 'markPNS', 'markTimestamp', 'lastPNS', 'lastTimestamp', 'oraclePNS', 'oracleTimestampSec',
  'longOpenInterestLNS', 'shortOpenInterestLNS', 'fundingStartBlock', 'fundingRatePct100k', 'absFundingClampPctPer100K', 'status', 'basePricePNS',
  'maxBidPriceONS', 'minBidPriceONS', 'maxAskPriceONS', 'minAskPriceONS', 'numOrders', 'ignOracle', 'fundingSumScalingExp',
] as const;

export function decodePerpetualInfo(data: string): PerpetualInfo {
  const w = splitWords(data);
  if (u(w[0]) !== 0x20n) throw new Error('getPerpetualInfoV2: unexpected head');
  const at = (name: (typeof PERP_SLOTS)[number]): string => w[1 + PERP_SLOTS.indexOf(name)];
  const n = (name: (typeof PERP_SLOTS)[number]): bigint => u(at(name));
  return {
    priceDecimals: Number(n('priceDecimals')),
    lotDecimals: Number(n('lotDecimals')),
    priceTolPer100K: n('priceTolPer100K'),
    positionBalanceCNS: n('positionBalanceCNS'),
    insuranceBalanceCNS: n('insuranceBalanceCNS'),
    markPNS: n('markPNS'),
    markTimestamp: n('markTimestamp'),
    lastPNS: n('lastPNS'),
    oraclePNS: n('oraclePNS'),
    oracleTimestampSec: n('oracleTimestampSec'),
    longOpenInterestLNS: n('longOpenInterestLNS'),
    shortOpenInterestLNS: n('shortOpenInterestLNS'),
    fundingStartBlock: n('fundingStartBlock'),
    fundingRatePct100k: wordToInt(at('fundingRatePct100k')), // int16, sign-extended to a full word
    absFundingClampPctPer100K: n('absFundingClampPctPer100K'),
    status: Number(n('status')),
    basePricePNS: n('basePricePNS'),
    maxBidPriceONS: n('maxBidPriceONS'),
    minBidPriceONS: n('minBidPriceONS'),
    maxAskPriceONS: n('maxAskPriceONS'),
    minAskPriceONS: n('minAskPriceONS'),
    numOrders: n('numOrders'),
  };
}

export type OrderLock = { orderLockId: number; perpId: number; orderId: number; orderType: number; lotLNS: bigint; amountCNS: bigint };

// getOrderLocks / getPerpOrderLocks: dynamic array of 6-word tuples. The lock id packs the perpetual
// and the order: id = perpId * 65536 + orderId (observed on live data, see docs/PERPL-ONCHAIN.md).
export function decodeOrderLocks(data: string): OrderLock[] {
  const w = splitWords(data);
  if (u(w[0]) !== 0x20n) throw new Error('getOrderLocks: unexpected head');
  const len = Number(u(w[1]));
  if (w.length !== 2 + 6 * len) throw new Error(`getOrderLocks: expected ${2 + 6 * len} words, got ${w.length}`);
  const out: OrderLock[] = [];
  for (let i = 0; i < len; i++) {
    const t = w.slice(2 + 6 * i, 8 + 6 * i);
    const id = Number(u(t[0]));
    out.push({ orderLockId: id, perpId: id >>> 16, orderId: id & 0xffff, orderType: Number(u(t[3])), lotLNS: u(t[4]), amountCNS: u(t[5]) });
  }
  return out;
}

export type RestingOrder = {
  accountId: bigint;
  orderType: number;
  priceONS: bigint;
  lotLNS: bigint;
  recycleFeeRaw: bigint;
  expiryBlock: bigint;
  leverageHdths: bigint;
  orderId: bigint;
  maxNegPnlCollatBPS: bigint;
};

export function decodeOrder(data: string): RestingOrder {
  const w = splitWords(data);
  if (w.length !== 13) throw new Error(`getOrderV2: expected 13 words, got ${w.length}`);
  return {
    accountId: u(w[0]), orderType: Number(u(w[1])), priceONS: u(w[2]), lotLNS: u(w[3]), recycleFeeRaw: u(w[4]), expiryBlock: u(w[5]),
    leverageHdths: u(w[6]), orderId: u(w[7]), maxNegPnlCollatBPS: u(w[10]),
  };
}

export type MarginFractions = { initHdths: bigint; maintHdths: bigint; dynamicInitHdths: bigint; oiMaxLNS: bigint };
export function decodeMarginFractions(data: string): MarginFractions {
  const w = splitWords(data);
  if (w.length !== 6) throw new Error(`getMarginFractions: expected 6 words, got ${w.length}`);
  return { initHdths: u(w[0]), maintHdths: u(w[1]), dynamicInitHdths: u(w[2]), oiMaxLNS: u(w[3]) };
}

// ---- reading ----

export class PerplReader {
  readonly rpc: EthCall;
  readonly exchange: string;
  constructor(rpc: EthCall, exchange: string) {
    this.rpc = rpc;
    this.exchange = exchange;
  }

  private async view(data: string, block: string | number = 'latest'): Promise<string | null> {
    const tag = typeof block === 'number' ? '0x' + block.toString(16) : block;
    try {
      return await this.rpc.call<string>('eth_call', [{ to: this.exchange, data }, tag]);
    } catch (e) {
      // A view that reverts (no such account, no such position) is "not found", not a failure; anything
      // else (network, rate limit) is rethrown by the adapter before it gets here as a revert.
      if (/execution reverted|"code":3/.test(String((e as Error).message))) return null;
      throw e;
    }
  }

  async account(address: string, block?: string | number): Promise<Account | null> {
    const r = await this.view(call('getAccountByAddr(address)', addressWord(address)), block);
    return r === null ? null : decodeAccount(r);
  }

  async position(perpId: number, accountId: bigint, block?: string | number): Promise<Position | null> {
    const r = await this.view(call('getPositionV2(uint256,uint256)', uintWord(perpId), uintWord(accountId)), block);
    return r === null ? null : decodePosition(r);
  }

  async perpetual(perpId: number, block?: string | number): Promise<PerpetualInfo> {
    const r = await this.view(call('getPerpetualInfoV2(uint256)', uintWord(perpId)), block);
    if (r === null) throw new Error(`perpetual ${perpId} not found`);
    return decodePerpetualInfo(r);
  }

  async orderLocks(accountId: bigint, perpId: number, block?: string | number): Promise<OrderLock[]> {
    const r = await this.view(call('getPerpOrderLocks(uint256,uint256)', uintWord(accountId), uintWord(perpId)), block);
    return r === null ? [] : decodeOrderLocks(r);
  }

  async order(perpId: number, orderId: number, block?: string | number): Promise<RestingOrder | null> {
    const r = await this.view(call('getOrderV2(uint256,uint256)', uintWord(perpId), uintWord(orderId)), block);
    return r === null ? null : decodeOrder(r);
  }

  async minAccountOpenCNS(block?: string | number): Promise<bigint> {
    const r = await this.view(call('getMinAccountOpenCNS()'), block);
    if (r === null) throw new Error('getMinAccountOpenCNS reverted');
    return u(splitWords(r)[0]);
  }

  async marginFractions(perpId: number, lotLNS: bigint, block?: string | number): Promise<MarginFractions> {
    const r = await this.view(call('getMarginFractions(uint256,uint256)', uintWord(perpId), uintWord(lotLNS)), block);
    if (r === null) throw new Error('getMarginFractions reverted');
    return decodeMarginFractions(r);
  }

  // Fees come from the exchange itself, in millionths of notional since contract v1.7.5
  // (v1.7.4 and earlier: hundred-thousandths). Pass the version you read so the unit is explicit.
  async takerFee(perpId: number, block?: string | number): Promise<bigint> {
    const r = await this.view(call('getTakerFee(uint256)', uintWord(perpId)), block);
    if (r === null) throw new Error('getTakerFee reverted');
    return u(splitWords(r)[0]);
  }

  async makerFee(perpId: number, block?: string | number): Promise<bigint> {
    const r = await this.view(call('getMakerFee(uint256)', uintWord(perpId)), block);
    if (r === null) throw new Error('getMakerFee reverted');
    return u(splitWords(r)[0]);
  }

  async contractVersion(block?: string | number): Promise<[bigint, bigint, bigint]> {
    const r = await this.view(call('getContractVersion()'), block);
    if (r === null) throw new Error('getContractVersion reverted');
    const w = splitWords(r).map(u);
    return [w[0], w[1], w[2]];
  }

  // Cumulative funding sum at a block and the block of the funding event it belongs to (int48 sum, scaling 10^2).
  async fundingSum(perpId: number, atBlock: number, block?: string | number): Promise<{ sum: bigint; eventBlock: bigint }> {
    const r = await this.view(call('getFundingSumAtBlock(uint256,uint256)', uintWord(perpId), uintWord(atBlock)), block);
    if (r === null) throw new Error('getFundingSumAtBlock reverted');
    const w = splitWords(r);
    return { sum: wordToInt(w[0]), eventBlock: u(w[1]) };
  }

  async isHalted(block?: string | number): Promise<boolean> {
    const r = await this.view(call('isHalted()'), block);
    return r !== null && wordToBool(splitWords(r)[0]);
  }
}

// Fee units: millionths of notional per fill from contract v1.7.5 (dex-sdk version.rs `PPM_FEE_UNIT`),
// hundred-thousandths before. Returns the fee as a fraction numerator over 1e6.
export function feePpm(rawFee: bigint, version: [bigint, bigint, bigint]): bigint {
  const [major, minor, patch] = version;
  const ppm = major > 1n || (major === 1n && (minor > 7n || (minor === 7n && patch >= 5n)));
  return ppm ? rawFee : rawFee * 10n;
}

// ---- fills and other events of one account ----

export type AccountEvents = { account: bigint; nextBlock: number; events: PerplEvent[] };

export function newAccountEvents(account: bigint, startBlock: number): AccountEvents {
  return { account, nextBlock: startBlock, events: [] };
}

// Events that belong to the account: those carrying its id, plus the taker-side events
// (TakerOrderFilledV2, PositionOpenedV2 ... carry no order owner) that share a transaction with one of
// its OrderRequestV2 events. Attribution inside one transaction is by position: an event follows the
// most recent OrderRequestV2 before it. A transaction with several accounts' orders is split correctly
// only when each request's events are contiguous, which is how the exchange emits them.
export function eventsOfAccount(logs: RawLog[], account: bigint): PerplEvent[] {
  const byTx = new Map<string, RawLog[]>();
  for (const l of logs) {
    if (l.removed) continue;
    const arr = byTx.get(l.transactionHash) ?? [];
    arr.push(l);
    byTx.set(l.transactionHash, arr);
  }
  const out: PerplEvent[] = [];
  for (const arr of byTx.values()) {
    arr.sort((a, b) => Number(BigInt(a.logIndex) - BigInt(b.logIndex)));
    let current: bigint | null = null;
    for (const l of arr) {
      const ev = decodePerplLog(l);
      if (!ev) continue;
      if (ev.name === 'OrderRequestV2') current = fieldOf(ev, 'accountId');
      const own = typeof ev.fields.accountId === 'bigint' ? ev.fields.accountId === account : false;
      const taker = ev.name === 'TakerOrderFilledV2' || ev.name === 'OrderPlaced' || ev.name === 'OrderCancelled' || ev.name === 'OrderChanged' || ev.name === 'OrderBatchCompleted';
      if (own || (taker && current === account)) out.push(ev);
    }
  }
  return out;
}

// Scans [state.nextBlock, head - confirmations] in windows of at most maxBlocks, merging as it goes. The
// cursor moves only after a window is merged, so a failure resumes where it stopped; events are keyed by
// (tx, logIndex) so re-scanning never duplicates. Every call returns all exchange events of the window (no
// account filter exists on chain), so a long history is slow: about one request per 90 blocks.
export async function scanAccountEvents(
  src: LogSource,
  exchange: string,
  state: AccountEvents,
  o: { maxBlocks: number; confirmations?: number; toBlock?: number },
): Promise<AccountEvents> {
  const head = o.toBlock ?? (await src.blockNumber()) - (o.confirmations ?? 2);
  const topics = [Object.values(EVENT_TOPICS)];
  const seen = new Set(state.events.map((e) => `${e.log.transactionHash}:${e.log.logIndex}`));
  for (const [a, b] of planWindows(state.nextBlock, head, o.maxBlocks)) {
    const logs = await src.getLogs({ address: exchange, topics, fromBlock: a, toBlock: b });
    for (const ev of eventsOfAccount(logs, state.account)) {
      const k = `${ev.log.transactionHash}:${ev.log.logIndex}`;
      if (!seen.has(k)) {
        seen.add(k);
        state.events.push(ev);
      }
    }
    state.nextBlock = b + 1;
  }
  return state;
}
