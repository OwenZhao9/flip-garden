// The Gardener's mandate: what the user authorises once, and the running totals it is checked against.
// Pure functions, integers for money (BigInt), no I/O. Nothing here can raise a cap: every amount is bounded by the
// existing per-transaction caps in src/plant.ts and src/perpl/guard.ts, and the guard still checks every transaction.
import { LIMITS } from '../plant.ts';
import { PERPL } from '../perpl/guard.ts';
import { BPS, formatUnits } from '../units.ts';

// requote: cancel a resting bid that left the user's range and plant it again near the market (also: prune it).
// replant: plant money that is free at Kuru again after a failed or interrupted move or plant.
// hedge:   keep the Perpl short inside the user's hedge-ratio range (reduce it, or open one when there is none).
// harvest: withdraw money that has sat idle at Kuru to the wallet.
// refuel:  withdraw MON that is free at Kuru to the wallet when the wallet runs low on MON for network fees.
export type ActionKind = 'requote' | 'replant' | 'hedge' | 'harvest' | 'refuel';
export const ACTION_KINDS: readonly ActionKind[] = ['requote', 'replant', 'hedge', 'harvest', 'refuel'];

export type Mandate = {
  account: string; // lower-case
  startMs: number;
  expiresMs: number;
  usdcBudget: bigint; // raw USDC: the most the Gardener keeps locked in its bids at once (it never deposits new money)
  ausdBudget: bigint; // raw AUSD: the most collateral it commits to a hedge it opens (from an existing Perpl account)
  priceMin: bigint; // order-price units (1e8): it never plants a bid outside [priceMin, priceMax]
  priceMax: bigint;
  bandBps: bigint; // a bid more than this far under the best bid has "left the range"
  hedgeMinBps: bigint; // hedge ratio range: short MON / garden MON
  hedgeMaxBps: bigint;
  actions: ActionKind[];
  maxTxPerHour: number;
  maxFeeWeiPerHour: bigint; // network fees, MON wei
  actAt: number; // confidence at or above which an allowed choice is carried out alone
  askAt: number; // between askAt and actAt the user is asked; below askAt nothing happens
};

export const MANDATE_LIMITS = {
  defaultHours: 1,
  maxHours: 24,
  maxTxPerHour: 30,
  maxFeeWeiPerHour: 2_000_000_000_000_000_000n, // 2 MON
  maxBandBps: 500n,
  minBandBps: 2n,
} as const;

export const DEFAULTS = {
  usdcBudget: 6_000_000n,
  ausdBudget: 5_000_000n,
  rangeBps: 500n, // default price range: 5% either side of the mid price when the mandate is made
  bandBps: 20n,
  hedgeMinBps: 3000n,
  hedgeMaxBps: 7000n,
  maxTxPerHour: 12,
  maxFeeWeiPerHour: 500_000_000_000_000_000n, // 0.5 MON
  actAt: 0.85,
  askAt: 0.6,
  actions: ['requote', 'replant', 'harvest', 'refuel'] as ActionKind[],
} as const;

const HOUR_MS = 3_600_000;

export function defaultMandate(account: string, nowMs: number, book: { bestBid: bigint; bestAsk: bigint }, tick: bigint): Mandate {
  const mid = (book.bestBid + book.bestAsk) / 2n;
  const down = (x: bigint): bigint => x - (x % tick);
  return {
    account: account.toLowerCase(),
    startMs: nowMs,
    expiresMs: nowMs + MANDATE_LIMITS.defaultHours * HOUR_MS,
    usdcBudget: DEFAULTS.usdcBudget,
    ausdBudget: DEFAULTS.ausdBudget,
    priceMin: down((mid * (BPS - DEFAULTS.rangeBps)) / BPS),
    priceMax: down((mid * (BPS + DEFAULTS.rangeBps)) / BPS),
    bandBps: DEFAULTS.bandBps,
    hedgeMinBps: DEFAULTS.hedgeMinBps,
    hedgeMaxBps: DEFAULTS.hedgeMaxBps,
    actions: [...DEFAULTS.actions],
    maxTxPerHour: DEFAULTS.maxTxPerHour,
    maxFeeWeiPerHour: DEFAULTS.maxFeeWeiPerHour,
    actAt: DEFAULTS.actAt,
    askAt: DEFAULTS.askAt,
  };
}

// Every problem with a mandate, in plain words. An empty list means the mandate may be confirmed.
export function validateMandate(m: Mandate, nowMs: number): string[] {
  const e: string[] = [];
  if (!/^0x[0-9a-f]{40}$/.test(m.account)) e.push('The mandate must name the connected account.');
  if (!(m.expiresMs > nowMs)) e.push('The expiry must be in the future.');
  if (m.expiresMs - m.startMs > MANDATE_LIMITS.maxHours * HOUR_MS) e.push(`A mandate lasts at most ${MANDATE_LIMITS.maxHours} hours.`);
  if (m.usdcBudget < 0n || m.usdcBudget > LIMITS.maxNotionalUsdc) e.push(`The USDC budget must be between 0 and ${formatUnits(LIMITS.maxNotionalUsdc, 6)} USDC (the planting cap).`);
  if (m.ausdBudget < 0n || m.ausdBudget > PERPL.maxDepositCNS) e.push(`The AUSD budget must be between 0 and ${formatUnits(PERPL.maxDepositCNS, 6)} AUSD (the hedge deposit cap).`);
  if (!(m.priceMin > 0n && m.priceMax > m.priceMin)) e.push('The price range must have a lower bound above 0 and an upper bound above it.');
  if (m.bandBps < MANDATE_LIMITS.minBandBps || m.bandBps > MANDATE_LIMITS.maxBandBps) e.push(`The re-place distance must be between ${bps(MANDATE_LIMITS.minBandBps)} and ${bps(MANDATE_LIMITS.maxBandBps)}.`);
  if (!(m.hedgeMinBps >= 0n && m.hedgeMaxBps >= m.hedgeMinBps && m.hedgeMaxBps <= BPS)) e.push('The hedge range must lie between 0% and 100%, lower bound first.');
  if (!m.actions.every((a) => ACTION_KINDS.includes(a))) e.push('Unknown action kind.');
  if (!(Number.isInteger(m.maxTxPerHour) && m.maxTxPerHour >= 1 && m.maxTxPerHour <= MANDATE_LIMITS.maxTxPerHour)) e.push(`Between 1 and ${MANDATE_LIMITS.maxTxPerHour} transactions per hour.`);
  if (m.maxFeeWeiPerHour <= 0n || m.maxFeeWeiPerHour > MANDATE_LIMITS.maxFeeWeiPerHour) e.push(`The network-fee budget must be above 0 and at most ${formatUnits(MANDATE_LIMITS.maxFeeWeiPerHour, 18)} MON per hour.`);
  if (!(m.askAt > 0 && m.askAt <= m.actAt && m.actAt <= 1)) e.push('Confidence thresholds must satisfy 0 < ask ≤ act ≤ 1.');
  return e;
}

export const bps = (x: bigint): string => `${formatUnits(x, 2)}%`;

// ---------------------------------------------------------------- running totals --------------------------------------

export type SpendEvent = { atMs: number; kind: string; feeWei: bigint; ok: boolean };
export type Spend = SpendEvent[];

export function lastHour(spend: Spend, nowMs: number): { txs: number; feeWei: bigint; failures: number } {
  const recent = spend.filter((s) => s.atMs > nowMs - HOUR_MS);
  return { txs: recent.length, feeWei: recent.reduce((a, s) => a + s.feeWei, 0n), failures: recent.filter((s) => !s.ok).length };
}

export const failuresSince = (spend: Spend, sinceMs: number): number => spend.filter((s) => !s.ok && s.atMs >= sinceMs).length;

export type Remaining = { txs: number; feeWei: bigint; msLeft: number };
export function remaining(m: Mandate, spend: Spend, nowMs: number): Remaining {
  const h = lastHour(spend, nowMs);
  const fee = m.maxFeeWeiPerHour - h.feeWei;
  return { txs: Math.max(0, m.maxTxPerHour - h.txs), feeWei: fee > 0n ? fee : 0n, msLeft: Math.max(0, m.expiresMs - nowMs) };
}

// Room for `txs` more transactions costing up to `feeWei` in the current hour.
export function hasRoom(m: Mandate, spend: Spend, nowMs: number, txs: number, feeWei: bigint): boolean {
  const r = remaining(m, spend, nowMs);
  return r.txs >= txs && r.feeWei >= feeWei;
}

// --- serialisation (the mandate lives in the page's memory; this is for display and tests) ---------------------------

export function mandateToJson(m: Mandate): Record<string, unknown> {
  return JSON.parse(JSON.stringify(m, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}
