// Resumable, bounded scan of one registered wallet, then the figures from the ledger core.
//
// Stored per wallet in KV: the record `w:<address>` (address, start block, cursor, figures) and the scan state
// `s:<address>` (the wallet's own Kuru event logs as returned by the chain, which the ledger needs to be recomputed).
// Both are public chain data of a public address; no IP, no key, no personal data.
import { newScanState, sync, eventsOf, type LogSource, type ScanState } from '../../src/scan.ts';
import { keccak256 } from '../../src/keccak.ts';
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
export async function scanWallet(kv: KV, rawChain: Chain, cfg: Config, market: Market, rec: WalletRecord, budget: Budget, now: string, fallbackChain?: Chain): Promise<WalletRecord> {
  let chain = metered(rawChain, budget);
  let windowBlocks = rawChain.windowBlocks ?? MAX_WINDOW_BLOCKS;
  const state = await loadState(kv, rec, cfg);
  // 1 block number + up to 2 timestamps are reserved; each window costs 2 getLogs calls (market + MarginAccount).
  const maxWindows = Math.floor((budget.left - 3) / 2);
  if (maxWindows < 1) return rec;
  let r;
  try {
    try {
      r = await sync(state, chain, { maxBlocks: windowBlocks, confirmations: CONFIRMATIONS, maxWindows });
    } catch (e) {
      // The fast source failed: finish this run on the public RPC in windows it accepts (the cursor sits before the failed window).
      if (!fallbackChain || /budget exhausted/.test(String((e as Error)?.message))) throw e;
      chain = metered(fallbackChain, budget);
      windowBlocks = fallbackChain.windowBlocks ?? MAX_WINDOW_BLOCKS;
      r = await sync(state, chain, { maxBlocks: windowBlocks, confirmations: CONFIRMATIONS, maxWindows: Math.floor((budget.left - 3) / 2) });
    }
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


// ---- History slice for the page (GET /history) ----
// The page cannot hold the Envio token, so it asks the Worker for a bounded slice of one wallet's Kuru logs and keeps its own
// cursor. Nothing is stored: the slice is computed from the chain and returned.
const APPROVAL_TOPIC = keccak256('Approval(address,address,uint256)');
const pad = (a: string): string => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

export type HistorySlice = { from: number; nextBlock: number; head: number; logs: ScanState['logs']; approvals: Record<string, number> };

export async function historySlice(rawChain: Chain, fallbackChain: Chain | undefined, cfg: Config, quoteToken: string, account: string, from: number, budget: Budget): Promise<HistorySlice> {
  const approvals: Record<string, number> = {};
  const withApprovals = (c: Chain): LogSource => ({
    blockNumber: () => c.blockNumber(),
    async getLogs(f) {
      if (f.address.toLowerCase() !== cfg.marginAccount) return c.getLogs(f);
      const [margin, appr] = await Promise.all([c.getLogs(f), c.getLogs({ address: quoteToken, topics: [[APPROVAL_TOPIC], [pad(account)], [pad(cfg.marginAccount)]], fromBlock: f.fromBlock, toBlock: f.toBlock })]);
      for (const l of appr) approvals[l.transactionHash.toLowerCase()] = Number(BigInt(l.blockNumber));
      return margin;
    },
  });
  const state = newScanState({ account, markets: [cfg.market], marginAccount: cfg.marginAccount, startBlock: from });
  // Each window costs 3 getLogs calls here (market, MarginAccount, Approval); 1 more for the block number.
  const run = (c: Chain) => sync(state, withApprovals(metered(c, budget)), { maxBlocks: c.windowBlocks ?? MAX_WINDOW_BLOCKS, confirmations: CONFIRMATIONS, maxWindows: Math.max(1, Math.floor((budget.left - 1) / 3)) });
  let head: number;
  try {
    head = (await run(rawChain)).head;
  } catch (e) {
    if (!fallbackChain || /budget exhausted/.test(String((e as Error)?.message))) throw e;
    head = (await run(fallbackChain)).head;
  }
  return { from, nextBlock: state.nextBlock, head, logs: state.logs, approvals };
}
