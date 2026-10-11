// Reconciliation: does what the ledger derived from events match what the chain says now?
// Output is a list of structured differences, each with a reason a UI can show as is.
//
// Checks (docs/LEDGER.md):
//   ORDER_SIZE   every order the ledger knows: remaining size == s_orders(id).size
//   EQUITY       per token: ledger equity == chain free margin + chain locked
//                (independent of how proceeds split between free and locked)
//   FREE         per token: ledger free == chain free margin (needs every order size known)
//   WALLET       per token, between two snapshots: Δ(wallet + margin + locked) ==
//                Δ(fills − fees − gas)   (deposits and withdrawals cancel out)
// Tolerance is the ledger's own rounding count (one raw unit per inexact conversion), so an
// exact history must reconcile to exactly zero.
import type { Issue, Ledger } from './ledger.ts';
import { orderKey } from './ledger.ts';
import { baseForSize, quoteForSize, NATIVE } from './units.ts';

export type ChainOrder = { market: string; id: bigint; size: bigint; isBuy: boolean; price: bigint; owner?: string };

export type ChainState = {
  block: number;
  margin: Record<string, bigint>; // MarginAccount.getBalance(account, token): free margin
  orders?: ChainOrder[]; // s_orders(id) for the ledger's orders; size 0 once gone
  locked?: Record<string, bigint>; // optional: locked per token if already computed
  wallet?: Record<string, bigint>; // wallet balances (native = 0x000…0)
};

export type Diff = {
  check: 'ORDER_SIZE' | 'EQUITY' | 'FREE' | 'WALLET';
  ok: boolean;
  token?: string;
  market?: string;
  orderId?: bigint;
  expected: bigint; // from the ledger
  actual: bigint; // from the chain
  diff: bigint; // actual − expected
  tolerance: bigint;
  en: string;
  zh: string;
  hints: string[]; // machine-readable possible causes when !ok
};

export type Report = {
  ok: boolean;
  block: number;
  diffs: Diff[];
  blocking: Issue[]; // ledger issues that make numbers untrustworthy (error)
  unknowns: Issue[]; // ledger issues about unverified semantics
};

const abs = (x: bigint): bigint => (x < 0n ? -x : x);
const lc = (s: string): string => s.toLowerCase();

function lockedFromChain(ledger: Ledger, chain: ChainState): Map<string, bigint> | null {
  if (chain.locked) return new Map(Object.entries(chain.locked).map(([k, v]) => [lc(k), v]));
  if (!chain.orders) return null;
  const out = new Map<string, bigint>();
  for (const o of chain.orders) {
    const m = ledger.markets.get(lc(o.market));
    if (!m || o.size === 0n) continue;
    const tok = o.isBuy ? m.quoteAsset : m.baseAsset;
    const a = o.isBuy ? quoteForSize(o.size, o.price, m, 'up') : baseForSize(o.size, m, 'up');
    out.set(tok, (out.get(tok) ?? 0n) + a.value);
  }
  return out;
}

export function reconcile(ledger: Ledger, chain: ChainState, baseline?: { ledger: Ledger; chain: ChainState }): Report {
  const diffs: Diff[] = [];

  // ORDER_SIZE
  if (chain.orders) {
    const byKey = new Map(chain.orders.map((o) => [orderKey(o.market, o.id), o]));
    for (const o of ledger.orders.values()) {
      const c = byKey.get(orderKey(o.market, o.id));
      if (!c) continue;
      if (o.remaining === null) continue; // unknown on our side: the chain value is the answer
      const ok = c.size === o.remaining;
      diffs.push({
        check: 'ORDER_SIZE',
        ok,
        market: o.market,
        orderId: o.id,
        expected: o.remaining,
        actual: c.size,
        diff: c.size - o.remaining,
        tolerance: 0n,
        en: ok ? `Order ${o.id}: size matches (${c.size}).` : `Order ${o.id}: ledger says ${o.remaining} left, chain says ${c.size}.`,
        zh: ok ? `订单 ${o.id}：剩余量一致（${c.size}）。` : `订单 ${o.id}：账本剩余 ${o.remaining}，链上是 ${c.size}。`,
        hints: ok ? [] : ['missing-event', 'partial-fill-semantics'],
      });
    }
  }

  const chainLocked = lockedFromChain(ledger, chain);
  const tokens = new Set<string>([...ledger.balances.keys(), ...Object.keys(chain.margin).map(lc)]);

  for (const t of tokens) {
    const b = ledger.balances.get(t);
    const margin = chain.margin[t] ?? chain.margin[Object.keys(chain.margin).find((k) => lc(k) === t) ?? ''] ?? 0n;
    const eq = b?.equity ?? 0n;
    const tolEq = (b?.roundingEquity ?? 0n) + (b?.roundingLocked ?? 0n);

    // EQUITY: free + locked on chain vs ledger equity.
    if (chainLocked) {
      const actual = margin + (chainLocked.get(t) ?? 0n);
      const d = actual - eq;
      const ok = abs(d) <= tolEq;
      diffs.push({
        check: 'EQUITY',
        ok,
        token: t,
        expected: eq,
        actual,
        diff: d,
        tolerance: tolEq,
        en: ok ? `Kuru balance of ${t} (free + locked) matches the ledger.` : `Kuru balance of ${t} (free + locked) is ${actual}, the ledger expects ${eq} (difference ${d}).`,
        zh: ok ? `${t} 在 Kuru 的余额（可用＋锁定）与账本一致。` : `${t} 在 Kuru 的余额（可用＋锁定）是 ${actual}，账本算的是 ${eq}（差 ${d}）。`,
        hints: ok ? [] : equityHints(ledger, t, d),
      });
    }

    // FREE: only meaningful when every open order's size is known.
    if (b && !b.lockedUncertain) {
      const d = margin - b.free;
      const ok = abs(d) <= tolEq;
      diffs.push({
        check: 'FREE',
        ok,
        token: t,
        expected: b.free,
        actual: margin,
        diff: d,
        tolerance: tolEq,
        en: ok ? `Free margin of ${t} matches the ledger.` : `Free margin of ${t} is ${margin}, the ledger expects ${b.free} (difference ${d}).`,
        zh: ok ? `${t} 的可用保证金与账本一致。` : `${t} 的可用保证金是 ${margin}，账本算的是 ${b.free}（差 ${d}）。`,
        hints: ok ? [] : [...equityHints(ledger, t, d), 'free-locked-split'],
      });
    }
  }

  // WALLET: whole-wallet equity between two snapshots.
  if (baseline && chain.wallet && baseline.chain.wallet) {
    const l0 = lockedFromChain(baseline.ledger, baseline.chain);
    if (l0 && chainLocked) {
      const all = new Set<string>([...tokens, ...Object.keys(chain.wallet).map(lc)]);
      for (const t of all) {
        const get = (r: Record<string, bigint>): bigint => r[t] ?? r[Object.keys(r).find((k) => lc(k) === t) ?? ''] ?? 0n;
        const e0 = get(baseline.chain.wallet) + get(baseline.chain.margin) + (l0.get(t) ?? 0n);
        const e1 = get(chain.wallet) + get(chain.margin) + (chainLocked.get(t) ?? 0n);
        const expected = tradingDelta(ledger, t, baseline.chain.block, chain.block);
        const actual = e1 - e0;
        const d = actual - expected;
        const tol = abs((ledger.balances.get(t)?.roundingEquity ?? 0n) - (baseline.ledger.balances.get(t)?.roundingEquity ?? 0n));
        const ok = abs(d) <= tol;
        diffs.push({
          check: 'WALLET',
          ok,
          token: t,
          expected,
          actual,
          diff: d,
          tolerance: tol,
          en: ok
            ? `Wallet + Kuru change of ${t} equals fills − fees − gas.`
            : `Wallet + Kuru change of ${t} is ${actual}; fills − fees − gas say ${expected} (difference ${d}).`,
          zh: ok
            ? `${t} 的「钱包＋Kuru」变化等于 成交 − 手续费 − gas。`
            : `${t} 的「钱包＋Kuru」变化是 ${actual}；按 成交 − 手续费 − gas 应为 ${expected}（差 ${d}）。`,
          hints: ok ? [] : [...equityHints(ledger, t, d), 'external-transfer', t === NATIVE ? 'gas-model' : ''].filter(Boolean),
        });
      }
    }
  }

  const blocking = ledger.issues.filter((i) => i.severity === 'error');
  const unknowns = ledger.issues.filter((i) => i.severity === 'unknown');
  return { ok: diffs.every((d) => d.ok) && blocking.length === 0, block: chain.block, diffs, blocking, unknowns };
}

// Ledger change of a token from trading and gas in (from, to]: fills, fees, gas. Deposits and
// withdrawals only move value between wallet and Kuru, so they are excluded.
export function tradingDelta(ledger: Ledger, token: string, from: number, to: number): bigint {
  let s = 0n;
  for (const f of ledger.flows) {
    if (f.token !== token || f.block <= from || f.block > to) continue;
    if (f.kind === 'fill' || f.kind === 'fee' || f.kind === 'gas') s += f.amount;
  }
  return s;
}

// Possible causes, most specific first.
function equityHints(ledger: Ledger, token: string, d: bigint): string[] {
  const hints: string[] = [];
  const fillFlow = ledger.flows.filter((f) => f.token === token && f.kind === 'fill').reduce((s, f) => s + f.amount, 0n);
  if (fillFlow !== 0n && d === -2n * fillFlow) hints.push('trade-side-reversed');
  if (ledger.issues.some((i) => i.code === 'ORDER_NOT_SEEN' || i.code === 'CANCEL_UNKNOWN_ORDER')) hints.push('scan-range-too-short');
  hints.push('missing-event', 'other-market-same-token');
  const m = [...ledger.markets.values()].find((x) => x.baseAsset === token || x.quoteAsset === token);
  if (m && m.makerFeeBps !== 0n) hints.push('fee-model-unverified');
  return hints;
}
