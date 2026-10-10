'use strict';
// Ground-truth test: the real gate-test data from Monad mainnet must reconcile with zero difference.
const test = require('node:test');
const assert = require('node:assert/strict');
const u = require('../lib/units.cjs');
const { reconcile, makerBuys } = require('../lib/reconcile.cjs');
const fx = require('./fixtures/gate-test-2026-10-10.json');

const mp = {
  pricePrecision: BigInt(fx.market.pricePrecision),
  sizePrecision: BigInt(fx.market.sizePrecision),
  baseDecimals: fx.market.baseDecimals,
  quoteDecimals: fx.market.quoteDecimals,
  tickSize: BigInt(fx.market.tickSize),
  minSize: BigInt(fx.market.minSize),
};
const bal = (s) => ({
  walletUsdc: BigInt(s.walletUsdc),
  walletMon: BigInt(s.walletMon),
  marginUsdc: BigInt(s.marginUsdc),
  marginMon: BigInt(s.marginMon),
});
const locked = (s) => ({ quote: BigInt(s.lockedQuote), base: BigInt(s.lockedBase) });
const snap = (name) => fx.snapshots.find((s) => s.name === name);

const fills = fx.events
  .filter((e) => e.name === 'Trade' && e.args.makerAddress.toLowerCase() === fx.wallet.toLowerCase())
  .map((e) => ({
    priceRaw: u.eventPriceToRaw(BigInt(e.args.price), mp.pricePrecision),
    sizeRaw: BigInt(e.args.filledSize),
    makerBuys: makerBuys(e.args.isBuy),
  }));
const gas = (upTo) => fx.txs.filter((t) => t.block <= upTo).reduce((s, t) => s + BigInt(t.feeWei), 0n);

test('fixture: one maker fill, and it was our bid being hit (Trade.isBuy is the taker side)', () => {
  assert.equal(fills.length, 1);
  assert.equal(fills[0].makerBuys, true);
  assert.equal(fills[0].sizeRaw, 2010000000000n);
  assert.equal(fills[0].priceRaw, 2476100n);
});

test('fixture: after the fill (ask resting) reconciles with zero difference', () => {
  const s = snap('afterFill');
  const r = reconcile({
    baseline: bal(snap('baseline')),
    now: bal(s),
    locked: locked(s),
    fills,
    feeLimit: gas(s.block),
    feeUsed: gas(s.block),
    mp,
  });
  assert.equal(r.quoteDiff, 0n);
  assert.equal(r.baseDiffLimit, 0n);
  assert.equal(r.quoteOk && r.baseOk, true);
});

test('fixture: after cancel and withdraw reconciles with zero difference and matches the expected totals', () => {
  const s = snap('final');
  const r = reconcile({
    baseline: bal(snap('baseline')),
    now: bal(s),
    locked: locked(s),
    fills,
    feeLimit: gas(s.block),
    feeUsed: gas(s.block),
    mp,
  });
  assert.equal(r.dQuote, BigInt(fx.expected.quoteEquityDelta));
  assert.equal(r.dBase + gas(s.block), BigInt(fx.expected.baseEquityDeltaBeforeGas));
  assert.equal(gas(s.block), BigInt(fx.expected.gasTotalWei));
  assert.equal(r.quoteDiff, 0n);
  assert.equal(r.baseDiffLimit, 0n);
});

test('fixture: value moves between wallet, margin and locked without changing quote equity until the fill', () => {
  const eq = (s) => BigInt(s.walletUsdc) + BigInt(s.marginUsdc) + BigInt(s.lockedQuote);
  assert.equal(eq(snap('baseline')), eq(snap('afterDeposit')));
  assert.equal(eq(snap('afterDeposit')), eq(snap('afterPlant')));
  assert.equal(eq(snap('afterPlant')) - eq(snap('afterFill')), 4976961n); // paid for 201 MON
});
