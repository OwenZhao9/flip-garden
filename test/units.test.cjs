'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const u = require('../lib/units.cjs');

// MON-USDC market params as read on-chain 2026-10-10 (block ~112.19M).
const mp = {
  pricePrecision: 100000000n,
  sizePrecision: 10000000000n,
  baseDecimals: 18,
  quoteDecimals: 6,
  tickSize: 100n,
  minSize: 2000000000000n,
};

test('log10Exact accepts powers of ten only', () => {
  assert.equal(u.log10Exact(1n), 0);
  assert.equal(u.log10Exact(100000000n), 8);
  assert.throws(() => u.log10Exact(250n));
});

test('alignUp / alignDown', () => {
  assert.equal(u.alignDown(2469467n, 100n), 2469400n);
  assert.equal(u.alignUp(2469467n, 100n), 2469500n);
  assert.equal(u.alignUp(2469500n, 100n), 2469500n);
});

test('event price (1e18) -> order price (1e8)', () => {
  assert.equal(u.eventPriceToRaw(24703000000000000n, mp.pricePrecision), 2470300n);
});

test('201 MON at 0.02467 USDC is 4.95867 USDC', () => {
  const size = u.parseUnits('201', 10);
  assert.equal(size, 2010000000000n);
  const quote = u.quoteForSize(size, 2467000n, mp);
  assert.equal(quote, 4958670n);
  assert.equal(u.formatUnits(quote, 6), '4.95867');
});

test('minimum order (200 MON) is about 4.95 USDC at 0.024765', () => {
  const q = u.quoteForSize(mp.minSize, 2476500n, mp);
  assert.equal(u.formatUnits(q, 6), '4.953');
});

test('base amount: 201 MON -> 201e18', () => {
  assert.equal(u.baseForSize(2010000000000n, mp), 201n * 10n ** 18n);
});

test('parseUnits rejects extra precision and junk', () => {
  assert.equal(u.parseUnits('6', 6), 6000000n);
  assert.equal(u.parseUnits('0.5', 6), 500000n);
  assert.throws(() => u.parseUnits('0.1234567', 6));
  assert.throws(() => u.parseUnits('-1', 6));
  assert.throws(() => u.parseUnits('abc', 6));
});

test('formatUnits handles negatives and truncation', () => {
  assert.equal(u.formatUnits(-1500000n, 6), '-1.5');
  assert.equal(u.formatUnits(1234567n, 6, 3), '1.234');
  assert.equal(u.formatUnits(0n, 6), '0');
});

test('single-bid ladder from the observed book (bid 2466900 / ask 2470500)', () => {
  const l = u.buildBidLadder({
    bestBid: 2466900n,
    bestAsk: 2470500n,
    tick: mp.tickSize,
    count: 1,
    sizeRaw: 2010000000000n,
    spreadBps: 10n,
  });
  assert.equal(l.length, 1);
  assert.equal(l[0].price, 2467000n); // best bid + 1 tick
  assert.equal(l[0].flipPrice, 2469500n); // +10 bps, rounded up to tick
  assert.ok(l[0].price % mp.tickSize === 0n && l[0].flipPrice % mp.tickSize === 0n);
});

test('ladder never crosses the ask and is strictly descending', () => {
  const l = u.buildBidLadder({
    bestBid: 2470400n,
    bestAsk: 2470500n, // 1-tick spread
    tick: mp.tickSize,
    count: 3,
    sizeRaw: 2010000000000n,
    stepBps: 10n,
  });
  assert.equal(l[0].price, 2470400n); // joins best bid, stays below ask
  assert.ok(l[0].price < 2470500n);
  assert.ok(l[1].price < l[0].price && l[2].price < l[1].price);
  for (const p of l) assert.ok(p.flipPrice >= p.price + 2n * mp.tickSize);
});

test('a large offset clamps to ask - 1 tick (front of the queue, never crossing)', () => {
  const l = u.buildBidLadder({
    bestBid: 2466900n,
    bestAsk: 2469200n, // 23 ticks wide
    tick: mp.tickSize,
    count: 1,
    sizeRaw: 2010000000000n,
    offsetTicks: 1000n,
  });
  assert.equal(l[0].price, 2469100n); // ask - 1 tick
  assert.ok(l[0].price < 2469200n);
});

test('ladder rejects a crossed / empty book', () => {
  assert.throws(() =>
    u.buildBidLadder({ bestBid: 0n, bestAsk: 10n, tick: 1n, count: 1, sizeRaw: 1n }),
  );
  assert.throws(() =>
    u.buildBidLadder({ bestBid: 11n, bestAsk: 10n, tick: 1n, count: 1, sizeRaw: 1n }),
  );
});
