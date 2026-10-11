// Incremental, resumable, idempotent log scanning. The I/O is behind `LogSource` (see rpc.ts);
// this file only decides which ranges to ask for and how to merge what comes back.
//
// - Each eth_getLogs call covers at most `maxBlocks` blocks (public Monad RPC: about 100; we use 90).
// - The cursor moves only after a window is merged, so a crash or Ctrl+C resumes where it stopped.
// - Logs are keyed by (tx, logIndex): re-scanning a range never duplicates anything.
// - `confirmations` keeps the newest blocks out until they are that deep (reorg safety margin;
//   Monad's finality makes a small number enough — the exact depth is a choice, not a verified fact).
import { MARKET_TOPICS, MARGIN_TOPICS, decodeLog, type KuruEvent, type RawLog } from './events.ts';

export type LogFilter = { address: string; topics: string[][]; fromBlock: number; toBlock: number };

export interface LogSource {
  blockNumber(): Promise<number>;
  getLogs(f: LogFilter): Promise<RawLog[]>;
}

export type ScanState = {
  version: 1;
  account: string;
  markets: string[];
  marginAccount: string;
  startBlock: number;
  nextBlock: number; // first block not yet scanned
  logs: Record<string, RawLog>; // key `${tx}:${logIndex}`; only logs that concern `account`
};

export function newScanState(o: { account: string; markets: string[]; marginAccount: string; startBlock: number }): ScanState {
  return {
    version: 1,
    account: o.account.toLowerCase(),
    markets: o.markets.map((m) => m.toLowerCase()),
    marginAccount: o.marginAccount.toLowerCase(),
    startBlock: o.startBlock,
    nextBlock: o.startBlock,
    logs: {},
  };
}

export function planWindows(from: number, to: number, maxBlocks: number): Array<[number, number]> {
  if (maxBlocks < 1) throw new Error('maxBlocks must be >= 1');
  const out: Array<[number, number]> = [];
  for (let a = from; a <= to; a += maxBlocks) out.push([a, Math.min(to, a + maxBlocks - 1)]);
  return out;
}

const keyOf = (l: RawLog): string => `${l.transactionHash.toLowerCase()}:${Number(BigInt(l.logIndex))}`;

// Keep a log if it concerns the account. FlipOrderUpdated has no owner: keep it when it names one
// of the account's known order ids, or when it shares a tx with a fill of ours (the order may be ours).
export function relevant(state: ScanState, logs: RawLog[]): RawLog[] {
  const decoded = logs.filter((l) => !l.removed).map((l) => ({ l, e: decodeLog(l) }));
  const ourTxs = new Set<string>();
  const ourIds = new Set<string>();
  for (const old of Object.values(state.logs)) {
    const e = decodeLog(old);
    if (e && 'owner' in e && e.owner === state.account && 'orderId' in e) ourIds.add(`${e.address}:${e.orderId}`);
  }
  const mine = (e: KuruEvent | null): boolean => {
    if (!e) return false;
    if (e.name === 'Trade') return e.maker === state.account;
    if (e.name === 'FlipOrderUpdated') return false;
    return e.owner === state.account;
  };
  for (const { e } of decoded) {
    if (!mine(e)) continue;
    ourTxs.add(e!.tx);
    if ('orderId' in e! && e!.name !== 'Trade') ourIds.add(`${e!.address}:${e!.orderId}`);
  }
  return decoded
    .filter(({ e }) => mine(e) || (e?.name === 'FlipOrderUpdated' && (ourTxs.has(e.tx) || ourIds.has(`${e.address}:${e.orderId}`))))
    .map(({ l }) => l);
}

export type SyncResult = { scannedTo: number; windows: number; added: number; head: number };

// Scans [state.nextBlock, head − confirmations] in windows and merges as it goes.
export async function sync(
  state: ScanState,
  src: LogSource,
  opts: { maxBlocks?: number; confirmations?: number; maxWindows?: number; toBlock?: number; onWindow?: (s: ScanState) => void } = {},
): Promise<SyncResult> {
  const maxBlocks = opts.maxBlocks ?? 90;
  const head = await src.blockNumber();
  const safe = head - (opts.confirmations ?? 2);
  const to = opts.toBlock !== undefined && opts.toBlock < safe ? opts.toBlock : safe;
  let windows = 0;
  let added = 0;
  for (const [a, b] of planWindows(state.nextBlock, to, maxBlocks)) {
    if (opts.maxWindows !== undefined && windows >= opts.maxWindows) break;
    const batches = await Promise.all([
      ...state.markets.map((address) => src.getLogs({ address, topics: [MARKET_TOPICS], fromBlock: a, toBlock: b })),
      src.getLogs({ address: state.marginAccount, topics: [MARGIN_TOPICS], fromBlock: a, toBlock: b }),
    ]);
    for (const l of relevant(state, batches.flat())) {
      const k = keyOf(l);
      if (state.logs[k]) continue;
      state.logs[k] = { address: l.address, topics: l.topics, data: l.data, blockNumber: l.blockNumber, transactionHash: l.transactionHash, logIndex: l.logIndex };
      added++;
    }
    state.nextBlock = b + 1; // only after the window is merged
    windows++;
    opts.onWindow?.(state);
  }
  return { scannedTo: state.nextBlock - 1, windows, added, head };
}

export function eventsOf(state: ScanState): KuruEvent[] {
  return Object.values(state.logs)
    .map((l) => decodeLog(l))
    .filter((e): e is KuruEvent => e !== null)
    .sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
}

// Transactions the account itself may have sent (gas): every tx with one of its own events,
// except fills (those are the taker's transactions).
export function candidateOwnTxs(state: ScanState): string[] {
  const out = new Set<string>();
  for (const e of eventsOf(state)) {
    if (e.name === 'Trade' || e.name === 'FlippedOrderCreated' || e.name === 'FlipOrderUpdated') continue;
    out.add(e.tx);
  }
  return [...out];
}
