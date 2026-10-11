// Hedge maths: exact examples taken from the live simulation of 2026-10-11 and randomized properties.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rng, randBig } from './helpers/sim.ts';
import { fundingCostPerIntervalCNS, liquidationPricePNS, marginPlan, notionalCNS, shortSize, type HedgeMarket } from '../src/perpl/hedge.ts';

const MON: HedgeMarket = {
  lotDecimals: 0, priceDecimals: 6, cnsDecimals: 6, baseDecimals: 18, minLotLNS: 1n,
  maintMarginFracHdths: 2000n, maxLeverageHdths: 1000n,
};
const E18 = 10n ** 18n;

test('shortSize rounds down to whole MON and refuses sizes under the market minimum', () => {
  assert.deepEqual(shortSize(1234n * E18 + E18 * 9n / 10n, 10_000n, MON), { lotLNS: 1234n, meetsMinimum: true, hedgedInventoryRaw: 1234n * E18 });
  assert.equal(shortSize(2001n * E18, 5_000n, MON).lotLNS, 1000n);
  assert.deepEqual(shortSize(E18 - 1n, 10_000n, MON), { lotLNS: 0n, meetsMinimum: false, hedgedInventoryRaw: 0n });
  assert.equal(shortSize(1999n * E18 / 1000n, 5_000n, MON).meetsMinimum, false); // 0.9995 MON
  assert.equal(shortSize(0n, 10_000n, MON).meetsMinimum, false);
  assert.throws(() => shortSize(E18, 10_001n, MON), /ratioBps/);
  assert.throws(() => shortSize(-1n, 100n, MON), /negative/);
});

test('shortSize never hedges more than asked for (random inventories and ratios)', () => {
  const r = rng(3);
  for (let i = 0; i < 2000; i++) {
    const inv = randBig(r, 0n, 10n ** 27n);
    const ratio = randBig(r, 0n, 10_000n);
    const s = shortSize(inv, ratio, MON);
    assert.ok(s.hedgedInventoryRaw * 10_000n <= inv * ratio, 'hedged amount does not exceed ratio x inventory');
    if (s.meetsMinimum) assert.ok((s.lotLNS + 1n) * E18 * 10_000n > inv * ratio, 'rounded down by less than one lot');
  }
});

test('margin plan reproduces the live simulation: 100 MON at 24913 and 5x, fee 345 millionths', () => {
  // live: taker fee paid 860 CNS, deposit 500960 CNS of which 2700 was extra collateral beyond notional / leverage
  const p = marginPlan({ lotLNS: 100n, pricePNS: 24913n, leverageHdths: 500n, feePpm: 345n, bufferBps: 100n }, MON);
  assert.equal(p.notionalCNS, 2_491_300n);
  assert.equal(p.initialMarginCNS, 498_260n);
  assert.equal(p.entryFeeCNS, 860n);
  assert.equal(p.bufferCNS, 4_983n);
  assert.equal(p.requiredCNS, 498_260n + 860n + 4_983n);
  assert.ok(p.requiredCNS >= 500_960n + 860n - 2_700n, 'covers what the live fill actually took (deposit + fee)');
  assert.throws(() => marginPlan({ lotLNS: 1n, pricePNS: 1n, leverageHdths: 1001n, feePpm: 0n, bufferBps: 0n }, MON), /leverage/);
  assert.throws(() => marginPlan({ lotLNS: 1n, pricePNS: 1n, leverageHdths: 0n, feePpm: 0n, bufferBps: 0n }, MON), /leverage/);
});

test('notional is rounded up and scales with the decimals of the market', () => {
  assert.equal(notionalCNS(1n, 24913n, MON), 24913n);
  const m2 = { ...MON, lotDecimals: 3, priceDecimals: 2 }; // 0.001 lots, 0.01 price units
  assert.equal(notionalCNS(1n, 1n, m2), 10n); // 1e-3 MON x 1e-2 AUSD per MON = 1e-5 AUSD = 10 CNS
  assert.equal(notionalCNS(1n, 1n, { ...m2, cnsDecimals: 3 }), 1n); // 1e-5 AUSD is 0.01 of a 1e-3 unit: rounded up
});

test('liquidation price: live-style example and the margin identity at the liquidation point', () => {
  // short 100 MON entered at 24913 with 500960 CNS deposited (live simulation), MMF 20
  const liq = liquidationPricePNS({ side: 'short', entryPricePNS: 24913n, lotLNS: 100n, depositCNS: 500_960n }, MON);
  assert.equal(liq, 28_676n);
  // without the extra 2700: deposit = notional / 5 -> entry x (1 + 1/5 - 1/20) = x 1.15
  assert.equal(liquidationPricePNS({ side: 'short', entryPricePNS: 20_000n, lotLNS: 100n, depositCNS: 400_000n }, MON), 23_000n);
  assert.equal(liquidationPricePNS({ side: 'long', entryPricePNS: 20_000n, lotLNS: 100n, depositCNS: 400_000n }, MON), 17_000n);
  // property: equity at the liquidation price equals the maintenance requirement, which the docs compute on the
  // ENTRY notional (P_entry x L / MMF), within the rounding of one price unit
  const r = rng(5);
  for (let i = 0; i < 2000; i++) {
    const L = randBig(r, 1n, 10_000_000n);
    const Pe = randBig(r, 100n, 10_000_000n);
    const lev = randBig(r, 100n, 1000n);
    const D = (L * Pe * 100n) / lev; // CNS == PNS x LNS for this market
    for (const side of ['long', 'short'] as const) {
      const Pl = liquidationPricePNS({ side, entryPricePNS: Pe, lotLNS: L, depositCNS: D }, MON);
      const pnl = side === 'short' ? (Pe - Pl) * L : (Pl - Pe) * L;
      const equity = D + pnl;
      const mmr = (Pe * L) / 20n;
      if (side === 'long' && Pl === 0n) continue; // clamped: the position cannot be liquidated by price
      assert.ok(equity - mmr <= 2n * L + 20n && equity - mmr >= -2n * L - 20n, `${side}: equity ${equity} vs requirement ${mmr}`);
    }
  }
  // funding owed brings the liquidation price closer
  const closer = liquidationPricePNS({ side: 'short', entryPricePNS: 20_000n, lotLNS: 100n, depositCNS: 400_000n, fundingOwedCNS: 50_000n }, MON);
  assert.ok(closer > 23_000n);
});

test('funding cost: shorts pay when the rate is negative, receive when it is positive (docs convention, unverified)', () => {
  assert.equal(fundingCostPerIntervalCNS(2_491_300n, -4n, 'short'), 99n);
  assert.equal(fundingCostPerIntervalCNS(2_491_300n, -4n, 'long'), -99n);
  assert.equal(fundingCostPerIntervalCNS(2_491_300n, 4n, 'short'), -99n);
});
