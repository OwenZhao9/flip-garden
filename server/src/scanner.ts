// Resumable, bounded scan of one registered wallet, then the figures from the ledger core.
//
// Stored per wallet in KV: the record `w:<address>` (address, start block, cursor, figures) and the scan state
// `s:<address>` (the wallet's own Kuru event logs as returned by the chain, which the ledger needs to be recomputed).
// Both are public chain data of a public address; no IP, no key, no personal data.
import { newScanState, sync, eventsOf, type ScanState } from '../../src/scan.ts';
import { buildLedger } from '../../src/ledger.ts';
import type { Market } from '../../src/units.ts';
import { firstBlockOf, makeFigures, roundTripsOf } from './figures.ts';
import type { Chain, Config, KV, WalletRecord } from './types.ts';

export const CONFIRMATIONS = 2;
export const MAX_WINDOW_BLOCKS = 90; // the public RPC rejects eth_getLogs ranges above about 100 blocks

// Counts outgoing RPC requests so one run never exceeds the platform's per-invocation limit.
export class Budget {
  left: number;
  constructor(n: number) {
    this.left = n;
  }
  take(n = 1): void {
    if (this.left < n) throw new Error('RPC budget exhausted');
    this.left -= n;
  }
}

function metered(chain: Chain, budget: Budget): Chain {
  return {
    blockNumber: () => (budget.take(), chain.blockNumber()),
    getLogs: (f) => (budget.take(), chain.getLogs(f)),
    marketParams: (a) => (budget.take(), chain.marketParams(a)),
    blockTimestamp: (b) => (budget.take(), chain.blockTimestamp(b)),
  };
}

const stateKey = (a: string): string => `s:${a}`;
export const recordKey = (a: string): string => `w:${a}`;

export async function loadState(kv: KV, rec: WalletRecord, cfg: Config): Promise<ScanState> {
  const s = await kv.get(stateKey(rec.address));
  if (s) return JSON.parse(s) as ScanState;
  return newScanState({ account: rec.address, markets: [cfg.market], marginAccount: cfg.marginAccount, startBlock: rec.startBlock });
}

// Scans as much as the budget allows from the stored cursor, saves, and recomputes the figures. Returns the new record.
// A failure leaves the previous record and state untouched except for windows already merged (the cursor only moves after
// a window is merged, so the next run resumes exactly there).
export async function scanWallet(kv: KV, rawChain: Chain, cfg: Config, market: Market, rec: WalletRecord, budget: Budget, now: string): Promise<WalletRecord> {
  const chain = metered(rawChain, budget);
  const state = await loadState(kv, rec, cfg);
  // 1 block number + up to 2 timestamps are reserved; each window costs 2 getLogs calls (market + MarginAccount).
  const maxWindows = Math.floor((budget.left - 3) / 2);
  if (maxWindows < 1) return rec;
  let r;
  try {
    r = await sync(state, chain, { maxBlocks: MAX_WINDOW_BLOCKS, confirmations: CONFIRMATIONS, maxWindows });
  } catch (e) {
    // Windows merged before the failure are kept: the cursor only moved past windows that were merged.
    if (state.nextBlock > rec.nextBlock) {
      await kv.put(stateKey(rec.address), JSON.stringify(state));
      await kv.put(recordKey(rec.address), JSON.stringify({ ...rec, nextBlock: state.nextBlock }));
    }
    throw e;
  }
  await kv.put(stateKey(rec.address), JSON.stringify(state));
  const catchingUp = r.scannedTo < r.head - CONFIRMATIONS;
  let out: WalletRecord = { ...rec, nextBlock: state.nextBlock, catchingUp };
  if (r.added > 0 || out.figures === null) {
    const ledger = buildLedger({ account: rec.address, markets: [market], events: eventsOf(state) });
    const firstBlock = firstBlockOf(ledger, cfg.market);
    out = { ...out, figures: makeFigures({ completedRoundTrips: roundTripsOf(ledger, cfg.market), firstBlock, ageSeconds: null, now }) };
  }
  const f = out.figures!;
  // Age: timestamps of two chain blocks, never an assumed block time.
  if (f.firstBlock !== null && budget.left >= 2) {
    const firstTs = out.firstTs ?? (await chain.blockTimestamp(f.firstBlock));
    const lastTs = await chain.blockTimestamp(state.nextBlock - 1);
    out = { ...out, firstTs, figures: makeFigures({ completedRoundTrips: f.completedRoundTrips, firstBlock: f.firstBlock, ageSeconds: Math.max(0, lastTs - firstTs), now }) };
  } else if (f.firstBlock === null) {
    out = { ...out, figures: makeFigures({ completedRoundTrips: f.completedRoundTrips, firstBlock: null, ageSeconds: null, now }) };
  }
  return out;
}
