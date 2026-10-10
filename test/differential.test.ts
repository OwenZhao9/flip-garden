// Randomized differential test: thousands of random place / partial fill / full fill / flip /
// cancel / deposit / withdraw steps on a reference chain (test/helpers/sim.ts). After EVERY step
// the ledger is rebuilt from the emitted events and must agree with the chain's real balances
// within its own rounding budget (one raw unit per inexact conversion) — and exactly when no
// conversion is inexact.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Chain, rng, randBig, type SimMarket } from './helpers/sim.ts';
import { buildLedger } from '../src/ledger.ts';
import { reconcile, type ChainState } from '../src/reconcile.ts';
import { marketPnl } from '../src/pnl.ts';
import { add, mul, q, sub, cmp, type Q } from '../src/rational.ts';
import { priceRaw, NATIVE, type Market } from '../src/units.ts';

const QUOTE = '0x00000000000000000000000000000000000000c0';
const BASE_ERC20 = '0x00000000000000000000000000000000000000b0';
const MARKET = '0x00000000000000000000000000000000000000ee';

const pick = <T,>(r: () => number, xs: T[]): T => xs[Math.floor(r() * xs.length)];
const json = (x: unknown): string => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v));

function randomMarket(r: () => number): SimMarket {
  const ppExp = 2 + Math.floor(r() * 7); // 1e2 … 1e8
  return {
    address: MARKET,
    baseAsset: r() < 0.5 ? NATIVE : BASE_ERC20,
    quoteAsset: QUOTE,
    baseDecimals: pick(r, [6, 8, 18]),
    quoteDecimals: pick(r, [2, 6, 18]),
    pricePrecision: 10n ** BigInt(ppExp),
    sizePrecision: 10n ** BigInt(Math.floor(r() * 12)),
    tickSize: 10n ** BigInt(Math.floor(r() * ppExp)),
    minSize: 1n,
    makerFeeBps: pick(r, [0n, 0n, 0n, 1n, 5n, 30n, 250n]),
    takerFeeBps: pick(r, [0n, 10n]),
  };
}

const MON_USDC: SimMarket = {
  address: MARKET,
  baseAsset: NATIVE,
  quoteAsset: QUOTE,
  baseDecimals: 18,
  quoteDecimals: 6,
  pricePrecision: 100_000_000n,
  sizePrecision: 10_000_000_000n,
  tickSize: 100n,
  minSize: 2_000_000_000_000n,
  makerFeeBps: 0n,
  takerFeeBps: 0n,
};

type RunOpts = {
  seed: number;
  market: SimMarket;
  steps: number;
  rounding: 'random' | 'down';
  partial: 'flip-per-fill' | 'update-existing';
  wholeUnits?: boolean; // sizes and fills in whole size-precision units (exact on MON-USDC)
  noUnknowns?: boolean; // assert the ledger never reports an 'unknown' issue
};

function run(o: RunOpts): { checks: number; maxTolQuote: bigint; nonzero: number; exactChecks: number } {
  const r = rng(o.seed * 7919 + 1);
  const m = o.market;
  const chain = new Chain(m, { seed: o.seed, rounding: o.rounding, partial: o.partial });
  const lm: Market = { ...m };
  const tick = m.tickSize;
  const p0 = randBig(r, 50n, 5000n) * tick;
  const unit = o.wholeUnits ? m.sizePrecision : 1n;
  const sizeLo = o.wholeUnits ? 200n * unit : m.sizePrecision / 10n + 1n;
  const sizeHi = o.wholeUnits ? 600n * unit : m.sizePrecision * 50n + 7n;
  const big = (dec: number): bigint => 10n ** BigInt(dec + 9);
  chain.fund(m.quoteAsset, big(m.quoteDecimals) * 10n ** 6n);
  chain.fund(m.baseAsset, big(m.baseDecimals) * 10n ** 6n);
  if (m.baseAsset !== NATIVE) chain.fund(NATIVE, 10n ** 30n);
  const base0: ChainState = chain.snapshot();
  const L0 = buildLedger({ account: chain.account, markets: [lm], events: [], txs: [] });
  // Enough margin for many orders at the highest price used.
  const pHi = p0 + 200n * tick;
  const quoteNeed = (sizeHi * pHi * 10n ** BigInt(m.quoteDecimals)) / (m.sizePrecision * m.pricePrecision) + 1n;
  const baseNeed = (sizeHi * 10n ** BigInt(m.baseDecimals)) / m.sizePrecision + 1n;
  chain.deposit(m.quoteAsset, quoteNeed * 12n);
  chain.deposit(m.baseAsset, baseNeed * 12n);

  let checks = 0;
  let maxTolQuote = 0n;
  let nonzero = 0;
  let exactChecks = 0;
  const check = (where: string): void => {
    checks++;
    const L = buildLedger({ account: chain.account, markets: [lm], events: chain.events, txs: chain.txs });
    const errors = L.issues.filter((i) => i.severity === 'error');
    assert.deepEqual(errors, [], `seed ${o.seed} ${where}: ledger errors ${json(errors)}`);
    if (o.noUnknowns) {
      const unk = L.issues.filter((i) => i.severity === 'unknown');
      assert.deepEqual(unk, [], `seed ${o.seed} ${where}: unknowns ${json(unk)}`);
    }
    const snap = chain.snapshot();
    const rep = reconcile(L, snap, { ledger: L0, chain: base0 });
    if (rep.diffs.every((d) => d.tolerance === 0n)) exactChecks++; // and then every diff is exactly 0
    for (const d of rep.diffs) {
      assert.ok(d.ok, `seed ${o.seed} ${where}: ${d.check} ${d.token ?? d.orderId} diff ${d.diff} tol ${d.tolerance} market ${json(m)}`);
      if (d.diff !== 0n) nonzero++;
    }
    // Truth 1: equity per token against the chain's real reserves (not the reader's estimate).
    for (const t of [m.baseAsset, m.quoteAsset]) {
      const b = L.balances.get(t)!;
      const diff = chain.equity(t) - b.equity;
      const tol = b.roundingEquity;
      assert.ok(diff <= tol && -diff <= tol, `seed ${o.seed} ${where}: equity ${t} chain ${chain.equity(t)} ledger ${b.equity} tol ${tol}`);
      if (t === m.quoteAsset && tol > maxTolQuote) maxTolQuote = tol;
    }
    // Truth 2: PnL = balance change. total(mid) vs the chain's own traded amounts at mid.
    const book = { bestBid: p0 - tick, bestAsk: p0 + tick };
    const p = marketPnl(L, MARKET, book);
    const P = priceRaw(q(book.bestBid + book.bestAsk, 2n), lm);
    const truth: Q = add(q(chain.tradedQuote), mul(q(chain.tradedBase), P));
    const tolQ = add(q(L.balances.get(m.quoteAsset)!.roundingEquity), mul(q(L.balances.get(m.baseAsset)!.roundingEquity), P));
    const gap = sub(p.total.mid!, truth);
    assert.ok(cmp(gap, tolQ) <= 0 && cmp(sub(q(0n), gap), tolQ) <= 0, `seed ${o.seed} ${where}: PnL gap ${json(gap)} > ${json(tolQ)}`);
    // Realized + unrealized + fees decomposition is internally exact.
    const recomposed = sub(add(p.realized, p.unrealized.mid.value!), p.fees.quoteEquivMid!);
    assert.equal(cmp(recomposed, p.total.mid!), 0);
  };

  for (let step = 0; step < o.steps; step++) {
    const open = chain.openOrders();
    const x = r();
    if (x < 0.3 || open.length === 0) {
      const n = 1 + Math.floor(r() * 3);
      const specs = [];
      for (let i = 0; i < n; i++) {
        const isBuy = r() < 0.6;
        const k = randBig(r, 1n, 100n);
        const price = isBuy ? p0 - k * tick : p0 + k * tick;
        const spread = randBig(r, 1n, 20n) * tick;
        const flipPrice = isBuy ? price + spread : price - spread;
        if (price <= 0n || flipPrice <= 0n) continue;
        const size = o.wholeUnits ? randBig(r, sizeLo / unit, sizeHi / unit) * unit : randBig(r, sizeLo, sizeHi);
        specs.push({ isBuy, price, flipPrice, size });
      }
      chain.place(specs);
      check(`step ${step} place`);
    } else if (x < 0.75) {
      const ord = pick(r, open);
      let f: bigint;
      if (r() < 0.4) f = ord.size;
      else if (o.wholeUnits) f = randBig(r, 1n, ord.size / unit) * unit;
      else f = randBig(r, 1n, ord.size);
      if (f > ord.size) f = ord.size;
      chain.takerFill(ord.id, f);
      check(`step ${step} fill ${f}/${ord.size}`);
    } else if (x < 0.88) {
      const ids = open.filter(() => r() < 0.5).map((z) => z.id);
      if (ids.length) {
        chain.cancel(ids);
        check(`step ${step} cancel`);
      }
    } else if (x < 0.94) {
      const t = r() < 0.5 ? m.quoteAsset : m.baseAsset;
      const free = chain.margin.get(t) ?? 0n;
      if (free > 0n) {
        chain.withdraw(t, randBig(r, 0n, free));
        check(`step ${step} withdraw`);
      }
    } else {
      const t = r() < 0.5 ? m.quoteAsset : m.baseAsset;
      chain.deposit(t, (t === m.quoteAsset ? quoteNeed : baseNeed) * 2n);
      check(`step ${step} deposit`);
    }
  }
  return { checks, maxTolQuote, nonzero, exactChecks };
}

test('differential: 400 random markets (precisions, fees, native or ERC-20 base), adversarial rounding', () => {
  let checks = 0;
  let nonzero = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const r = rng(seed);
    const res = run({ seed, market: randomMarket(r), steps: 60, rounding: 'random', partial: 'update-existing' });
    checks += res.checks;
    nonzero += res.nonzero;
  }
  assert.ok(checks > 15_000, `only ${checks} checks`);
  // Rounding really happened somewhere, and stayed inside the budget.
  assert.ok(nonzero > 0);
});

test('differential: MON-USDC with whole-MON orders is exact (zero budget, zero difference) until an ask fill flips into a fractional bid', () => {
  let exact = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const res = run({ seed, market: MON_USDC, steps: 80, rounding: 'random', partial: 'update-existing', wholeUnits: true });
    exact += res.exactChecks;
  }
  assert.ok(exact > 200, `only ${exact} zero-budget checks`);
});

test('differential: MON-USDC parameters with arbitrary partial-fill sizes stay within the budget', () => {
  for (let seed = 1; seed <= 100; seed++) {
    run({ seed, market: MON_USDC, steps: 80, rounding: 'random', partial: 'update-existing' });
  }
});

test('differential: hypothetical "new flipped order per partial fill" behaviour also reconciles', () => {
  for (let seed = 1; seed <= 100; seed++) {
    const r = rng(seed + 10_000);
    run({ seed, market: randomMarket(r), steps: 60, rounding: 'random', partial: 'flip-per-fill' });
  }
});

test('differential: observed behaviour (fee 0) raises no unknown-semantics issue at all', () => {
  for (let seed = 1; seed <= 100; seed++) {
    const r = rng(seed + 20_000);
    const market = { ...randomMarket(r), makerFeeBps: 0n };
    run({ seed, market, steps: 60, rounding: 'random', partial: 'update-existing', noUnknowns: true });
  }
});
