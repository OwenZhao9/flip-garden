'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const u = require('../lib/units.cjs');
const { reconcile, makerBuys } = require('../lib/reconcile.cjs');

test('Trade.isBuy is the taker side: a maker bid filled by a seller shows isBuy=false', () => {
  assert.equal(makerBuys(false), true);
  assert.equal(makerBuys('false'), true);
  assert.equal(makerBuys(true), false);
  assert.equal(makerBuys('true'), false);
});

const mp = {
  pricePrecision: 100000000n,
  sizePrecision: 10000000000n,
  baseDecimals: 18,
  quoteDecimals: 6,
  tickSize: 100n,
  minSize: 2000000000000n,
};
const MON = (x) => u.parseUnits(String(x), 18);
const USDC = (x) => u.parseUnits(String(x), 6);

// Scenario: wallet 6 USDC + 5 MON. Deposit 6 USDC, bid 201 MON @ 0.02467 fully fills (costs 4.95867 USDC),
// the flipped ask (201 MON) is resting. Gas: 0.30 MON if charged on gas limit, 0.25 MON if on gas used.
const baseline = { walletUsdc: USDC(6), walletMon: MON(5), marginUsdc: 0n, marginMon: 0n };
const fill = { priceRaw: 2467000n, sizeRaw: 2010000000000n, makerBuys: true };

function nowAfterFill(gasPaid) {
  return {
    walletUsdc: 0n,
    walletMon: MON(5) - gasPaid,
    marginUsdc: USDC(6) - u.quoteForSize(fill.sizeRaw, fill.priceRaw, mp), // 1.04133 left free
    marginMon: 0n,
  };
}
const lockedAsk = { quote: 0n, base: MON(201) };

test('fill + resting flipped ask reconciles; gas charged on limit is detected', () => {
  const r = reconcile({
    baseline,
    now: nowAfterFill(MON('0.3')),
    locked: lockedAsk,
    fills: [fill],
    feeLimit: MON('0.3'),
    feeUsed: MON('0.25'),
    mp,
  });
  assert.equal(r.quoteOk, true);
  assert.equal(r.baseOk, true);
  assert.equal(r.feeModel, 'gasLimit');
  assert.equal(r.meaningful, true);
  assert.equal(r.dQuote, -4958670n);
});

test('gas charged on used gas is detected', () => {
  const r = reconcile({
    baseline,
    now: nowAfterFill(MON('0.25')),
    locked: lockedAsk,
    fills: [fill],
    feeLimit: MON('0.3'),
    feeUsed: MON('0.25'),
    mp,
  });
  assert.equal(r.feeModel, 'gasUsed');
  assert.equal(r.baseOk, true);
});

test('a missing 0.01 USDC is reported as a mismatch', () => {
  const now = nowAfterFill(MON('0.3'));
  now.marginUsdc -= 10000n;
  const r = reconcile({ baseline, now, locked: lockedAsk, fills: [fill], feeLimit: MON('0.3'), feeUsed: MON('0.25'), mp });
  assert.equal(r.quoteOk, false);
  assert.equal(r.quoteDiff, -10000n);
});

test('wrong side assumption (isBuy reversed) is flagged as signFlipped', () => {
  const r = reconcile({
    baseline,
    now: nowAfterFill(MON('0.3')),
    locked: lockedAsk,
    fills: [{ ...fill, makerBuys: false }],
    feeLimit: MON('0.3'),
    feeUsed: MON('0.25'),
    mp,
  });
  assert.equal(r.quoteOk, false);
  assert.equal(r.signFlipped, true);
});

test('with no fills only deposits and gas are exercised', () => {
  const now = { walletUsdc: 0n, walletMon: MON(5) - MON('0.2'), marginUsdc: USDC(6), marginMon: 0n };
  const r = reconcile({ baseline, now, locked: { quote: 0n, base: 0n }, fills: [], feeLimit: MON('0.2'), feeUsed: MON('0.2'), mp });
  assert.equal(r.meaningful, false);
  assert.equal(r.quoteOk, true);
  assert.equal(r.baseOk, true);
});

test('locked bid counts as value, not as a loss', () => {
  const now = { walletUsdc: 0n, walletMon: MON(5), marginUsdc: USDC(1), marginMon: 0n };
  const r = reconcile({ baseline, now, locked: { quote: USDC(5), base: 0n }, fills: [], feeLimit: 0n, feeUsed: 0n, mp });
  assert.equal(r.dQuote, 0n);
  assert.equal(r.quoteOk, true);
});
