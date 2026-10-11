// Precision: synthetic markets with other decimals, precisions and non-zero fees.
import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteForSize, baseForSize, feeOn, eventPriceToOrderPrice, priceRaw, mulDiv, type Market } from '../src/units.ts';
import { q, floor, ceil, add, sub, mul, cmp } from '../src/rational.ts';
import { buildLedger } from '../src/ledger.ts';
import { reconcile } from '../src/reconcile.ts';
import type { KuruEvent } from '../src/events.ts';

const mk = (o: Partial<Market>): Market => ({
  address: '0x00000000000000000000000000000000000000ee',
  baseAsset: '0x00000000000000000000000000000000000000b0',
  quoteAsset: '0x00000000000000000000000000000000000000c0',
  baseDecimals: 8,
  quoteDecimals: 2,
  pricePrecision: 1000n,
  sizePrecision: 100n,
  tickSize: 1n,
  minSize: 1n,
  makerFeeBps: 30n,
  takerFeeBps: 30n,
  ...o,
});

test('rounding direction: received rounds down, paid/locked rounds up, exactness is reported', () => {
  const m = mk({});
  // 0.07 base at price 1.234 quote = 0.08638 -> 2-decimal quote: 8.638 raw
  assert.deepEqual(quoteForSize(7n, 1234n, m, 'down'), { value: 8n, exact: false });
  assert.deepEqual(quoteForSize(7n, 1234n, m, 'up'), { value: 9n, exact: false });
  assert.deepEqual(quoteForSize(100n, 1000n, m, 'up'), { value: 100n, exact: true });
  // base with fewer decimals than the size precision
  const thin = mk({ baseDecimals: 1, sizePrecision: 1000n });
  assert.deepEqual(baseForSize(15n, thin, 'down'), { value: 0n, exact: false });
  assert.deepEqual(baseForSize(15n, thin, 'up'), { value: 1n, exact: false });
  assert.deepEqual(baseForSize(1500n, thin, 'up'), { value: 15n, exact: true });
});

test('fees round up (the user never receives more than due) and 0 bps is exact', () => {
  assert.deepEqual(feeOn(10_000n, 30n), { value: 30n, exact: true });
  assert.deepEqual(feeOn(1n, 30n), { value: 1n, exact: false });
  assert.deepEqual(feeOn(123_456n, 0n), { value: 0n, exact: true });
  assert.throws(() => mulDiv(-1n, 1n, 1n, 'down'));
});

test('event price: exact on the grid, flagged when not', () => {
  const m = mk({ pricePrecision: 10n ** 8n });
  assert.deepEqual(eventPriceToOrderPrice(24761000000000000n, m), { value: 2476100n, exact: true });
  assert.deepEqual(eventPriceToOrderPrice(24761000000000001n, m), { value: 2476100n, exact: false });
  assert.throws(() => eventPriceToOrderPrice(1n, mk({ pricePrecision: 10n ** 19n })));
});

test('priceRaw: an order price as exact quote-raw per base-raw', () => {
  const monUsdc = mk({ baseDecimals: 18, quoteDecimals: 6, pricePrecision: 10n ** 8n, sizePrecision: 10n ** 10n });
  // 201 MON × 0.024761 = 4.976961 USDC
  assert.deepEqual(mul(q(201n * 10n ** 18n), priceRaw(2476100n, monUsdc)), q(4976961n));
  assert.equal(floor(q(-7n, 2n)), -4n);
  assert.equal(ceil(q(-7n, 2n)), -3n);
  assert.equal(cmp(add(q(1n, 3n), q(1n, 6n)), q(1n, 2n)), 0);
  assert.deepEqual(sub(q(1n), q(1n)), q(0n));
});

test('a 30 bps maker fee on a 2-decimal quote / 8-decimal base market reconciles within the budget', () => {
  const m = mk({});
  const acct = '0x00000000000000000000000000000000000000aa';
  const at = (block: number, logIndex: number, tx: string) => ({ block, logIndex, tx, address: m.address });
  // Deposit 100.00 quote; place a bid 3.33 base @ 1.234; it fills 1.11 then 2.22.
  const events: KuruEvent[] = [
    { ...at(1, 0, '0x01'), address: '0xmargin', name: 'Deposit', owner: acct, token: m.quoteAsset, amount: 10_000n },
    { ...at(2, 0, '0x02'), name: 'FlipOrderCreated', orderId: 1n, flippedId: 0n, owner: acct, size: 333n, price: 1234n, flippedPrice: 1240n, isBuy: true },
    { ...at(3, 0, '0x03'), name: 'FlippedOrderCreated', orderId: 2n, flippedId: 1n, owner: acct, size: 110n, price: 1240n, flippedPrice: 1234n, isBuy: false },
    { ...at(3, 1, '0x03'), name: 'Trade', orderId: 1n, maker: acct, isBuy: false, price1e18: 1234n * 10n ** 15n, updatedSize: 222n, taker: acct, txOrigin: acct, filledSize: 111n },
  ];
  const L = buildLedger({ account: acct, markets: [m], events });
  const f = L.fills[0];
  // 1.11 base = 111_000_000 raw; fee 30 bps = 333_000 (exact); paid 1.11 × 1.234 = 1.36974 -> 137 (up)
  assert.equal(f.base.value, 111_000_000n);
  assert.equal(f.fee.amount.value, 333_000n);
  assert.equal(f.quote.value, 137n);
  assert.equal(f.quote.exact, false);
  // The flipped ask is 1.10 base (fee taken from proceeds), not the 1.11 filled: reported, not guessed.
  assert.ok(L.issues.some((i) => i.code === 'FLIP_SIZE_UNEXPECTED' && i.severity === 'unknown'));
  // Chain state if the contract rounded the payment DOWN (136): equity differs by 1, budget allows it.
  // Remaining bid 2.22 × 1.234 = 2.73948 -> 274 locked (up).
  const r = reconcile(L, {
    block: 3,
    margin: { [m.quoteAsset]: 10_000n - 411n + (411n - 136n - 274n) + 0n, [m.baseAsset]: 111_000_000n - 333_000n - 110_000_000n },
    locked: { [m.quoteAsset]: 274n, [m.baseAsset]: 110_000_000n },
  });
  const eq = r.diffs.find((d) => d.check === 'EQUITY' && d.token === m.quoteAsset)!;
  assert.equal(eq.diff, 1n);
  assert.ok(eq.ok, `tolerance ${eq.tolerance}`);
});
