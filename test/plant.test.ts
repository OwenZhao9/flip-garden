// Planting policy: ladder equals lib/, caps equal the config, preview maths, the transaction guard, next-step planners.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { CHAIN, LIMITS, buildBidLadder, buildPreview, crossingBids, guardTx, nextPlantAction, nextUnwindAction, planApprove, planCancel, planDeposit, planPlant, planWithdraw, type PlannedTx } from '../src/plant.ts';
import { encodeApprove, encodeDeposit } from '../src/abi.ts';
import { NATIVE, parseUnits } from '../src/units.ts';
import { market } from './helpers/gate.ts';

const lib = createRequire(import.meta.url)('../lib/units.cjs');
const cfg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'config', 'kuru.mainnet.json'), 'utf8'));
const USER = '0x39FdC1B554FCF0B7478E58ff671f3d0FEA64DA38';

test('chain constants and hard caps equal config/kuru.mainnet.json', () => {
  assert.equal(CHAIN.chainId, cfg.chainId);
  assert.equal(CHAIN.rpcUrl, cfg.rpcUrl);
  assert.equal(CHAIN.marginAccount, cfg.marginAccount);
  assert.equal(CHAIN.usdc, cfg.tokens.USDC.address);
  assert.equal(CHAIN.market, cfg.markets['MON-USDC']);
  assert.equal(CHAIN.chainIdHex, '0x' + cfg.chainId.toString(16));
  assert.equal(LIMITS.maxDepositUsdc, parseUnits(cfg.limits.maxDepositUsdc, 6));
  assert.equal(LIMITS.maxNotionalUsdc, parseUnits(cfg.limits.maxNotionalUsdcPerPlant, 6));
  assert.equal(LIMITS.maxOrdersPerPlant, cfg.limits.maxOrdersPerPlant);
  assert.equal(LIMITS.minWalletMon, parseUnits(cfg.limits.minWalletMon, 18));
});

let seed = 99n;
const rnd = (n: bigint): bigint => {
  seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
  return (seed >> 20n) % n;
};

test('the ported ladder equals lib/units.cjs on thousands of random books', () => {
  let compared = 0;
  for (let i = 0; i < 3000; i++) {
    const tick = [1n, 10n, 100n][Number(rnd(3n))];
    const bestBid = (1n + rnd(5_000_000n)) * tick;
    const bestAsk = bestBid + (1n + rnd(40n)) * tick;
    const args = {
      bestBid, bestAsk, tick, count: 1 + Number(rnd(6n)), sizeRaw: 1n + rnd(10n ** 13n),
      offsetTicks: [1n, 3n, 1000n][Number(rnd(3n))], stepBps: rnd(30n), spreadBps: rnd(60n),
    };
    let expected: Array<{ price: bigint; flipPrice: bigint; liquidity: bigint }> | Error;
    try { expected = lib.buildBidLadder(args); } catch (e) { expected = e as Error; }
    let got: ReturnType<typeof buildBidLadder> | Error;
    try { got = buildBidLadder({ bestBid, bestAsk, tick, count: args.count, size: args.sizeRaw, offsetTicks: args.offsetTicks, stepBps: args.stepBps, spreadBps: args.spreadBps }); } catch (e) { got = e as Error; }
    if (expected instanceof Error || got instanceof Error) {
      assert.equal(got instanceof Error, expected instanceof Error, 'both fail or both succeed');
      if (got instanceof Error && expected instanceof Error) assert.equal(got.message, expected.message);
    } else {
      assert.deepEqual(got.map((b) => [b.price, b.flipPrice, b.size]), expected.map((b) => [b.price, b.flipPrice, b.liquidity]));
      compared++;
    }
  }
  assert.ok(compared > 1500, `compared ${compared} successful ladders`);
});

const book = { bestBid: 2_476_000n, bestAsk: 2_476_500n }; // 0.02476 / 0.024765 USDC
const usdc = (s: string): bigint => parseUnits(s, 6);

test('preview: one level, close placement, matches the real-funds test shape', () => {
  const p = buildPreview({ market, book, budget: usdc('5.2'), levels: 1, placement: 'close' });
  assert.equal(p.ok, true, p.errors.join());
  const [l] = p.levels;
  assert.equal(l.price, 2_476_400n); // one tick under the ask
  assert.equal(l.flipPrice > l.price, true);
  assert.equal(l.baseWhole, 209n); // 5.2 / 0.024764 = 209.98, rounded down to whole coins so every lock is an exact integer
  assert.equal(l.locked, 5_175_676n); // 209 x 0.024764
  assert.ok(p.totalLocked <= usdc('5.2'));
  assert.equal(p.totalGross, l.grossPerRoundTrip);
});

test('preview: sizes are whole coins, locks exact, the total never exceeds the budget (random)', () => {
  for (let i = 0; i < 400; i++) {
    const ask = 1_000_000n + rnd(9_000_000n) * 100n;
    const b = { bestBid: ask - 100n * (1n + rnd(5n)), bestAsk: ask };
    const budget = usdc('0.5') + rnd(15_000_000n);
    const levels = 1 + Number(rnd(3n));
    const placement = rnd(2n) === 0n ? 'close' : 'passive';
    const p = buildPreview({ market, book: b, budget, levels, placement });
    if (!p.ok) continue;
    assert.ok(p.totalLocked <= budget && p.totalLocked <= LIMITS.maxNotionalUsdc);
    assert.equal(p.levels.length, levels);
    for (const l of p.levels) {
      assert.equal(l.size % market.sizePrecision, 0n);
      assert.ok(l.size >= market.minSize);
      assert.ok(l.price < b.bestAsk, 'never crosses');
      assert.equal((l.size * l.price * 10n ** 6n) % (market.sizePrecision * market.pricePrecision), 0n, 'lock is exact');
    }
    assert.deepEqual(crossingBids(p.levels.map((l) => ({ price: l.price, flipPrice: l.flipPrice, size: l.size })), b.bestAsk), []);
  }
});

test('preview refuses what the caps and the minimum order forbid', () => {
  assert.match(buildPreview({ market, book, budget: usdc('3'), levels: 1, placement: 'close' }).errors[0], /at least 200 MON/);
  assert.match(buildPreview({ market, book, budget: usdc('9'), levels: 2, placement: 'close' }).errors[0], /at least 200 MON/); // 4.5 each is below the minimum
  assert.match(buildPreview({ market, book, budget: usdc('15.01'), levels: 3, placement: 'close' }).errors[0], /capped at 15/);
  assert.match(buildPreview({ market, book, budget: usdc('15'), levels: 4, placement: 'close' }).errors[0], /between 1 and 3/);
  assert.match(buildPreview({ market, book, budget: usdc('15'), levels: 0, placement: 'close' }).errors[0], /between 1 and 3/);
  assert.match(buildPreview({ market, book, budget: 0n, levels: 1, placement: 'close' }).errors[0], /above zero/);
  assert.match(buildPreview({ market, book: { bestBid: 0n, bestAsk: 0n }, budget: usdc('6'), levels: 1, placement: 'close' }).errors[0], /empty or crossed/);
  assert.equal(buildPreview({ market, book, budget: usdc('15'), levels: 3, placement: 'passive' }).ok, true);
});

test('passive placement sits under the ask by less than close placement', () => {
  const close = buildPreview({ market, book: { bestBid: 2_470_000n, bestAsk: 2_476_500n }, budget: usdc('6'), levels: 1, placement: 'close' });
  const passive = buildPreview({ market, book: { bestBid: 2_470_000n, bestAsk: 2_476_500n }, budget: usdc('6'), levels: 1, placement: 'passive' });
  assert.ok(passive.levels[0].price < close.levels[0].price);
});

const plantBids = (n = 1) => buildPreview({ market, book, budget: usdc('15'), levels: n, placement: 'close' }).levels.map((l) => ({ price: l.price, flipPrice: l.flipPrice, size: l.size }));

test('guard: the five planned transactions pass', () => {
  for (const tx of [planApprove(USER, usdc('6')), planDeposit(USER, usdc('6')), planPlant(USER, plantBids(3)), planCancel(USER, [5n, 6n]), planWithdraw(USER, [CHAIN.usdc, NATIVE])]) {
    assert.equal(guardTx(tx), null, tx.kind);
  }
});

test('guard: refuses unlimited or oversized approvals, other spenders, other tokens, other targets, MON value', () => {
  const ok = planApprove(USER, usdc('6'));
  assert.match(guardTx({ ...ok, data: encodeApprove(CHAIN.marginAccount, (1n << 256n) - 1n) })!, /never unlimited/);
  assert.match(guardTx({ ...ok, data: encodeApprove(CHAIN.marginAccount, usdc('15.000001')) })!, /never unlimited/);
  assert.match(guardTx({ ...ok, data: encodeApprove(USER, usdc('1')) })!, /margin account/);
  assert.match(guardTx({ ...ok, to: '0x1111111111111111111111111111111111111111' })!, /only allowed on USDC/);
  assert.match(guardTx({ ...planDeposit(USER, usdc('1')), data: encodeDeposit(USER, NATIVE, usdc('1')) })!, /only USDC/);
  assert.match(guardTx({ ...planDeposit(USER, usdc('1')), data: encodeDeposit('0x1111111111111111111111111111111111111111', CHAIN.usdc, 1n) })!, /your own address/);
  assert.match(guardTx(planDeposit(USER, usdc('15.5')))!, /within the cap/);
  assert.match(guardTx({ ...planDeposit(USER, usdc('1')), to: CHAIN.market })!, /margin account/);
  assert.match(guardTx({ ...planCancel(USER, [1n]), to: CHAIN.marginAccount })!, /MON-USDC market/);
  assert.match(guardTx({ ...planWithdraw(USER, [CHAIN.usdc]), to: CHAIN.market })!, /margin account/);
  assert.match(guardTx({ ...planWithdraw(USER, ['0x2222222222222222222222222222222222222222']) })!, /only USDC and MON/);
  assert.match(guardTx({ ...ok, value: '0x1' as '0x0' })!, /never sends MON/);
  assert.match(guardTx({ ...ok, data: '0xdeadbeef' })!, /unknown function/);
  assert.match(guardTx({ ...ok, kind: 'deposit' } as PlannedTx)!, /does not match the step/);
});

test('guard: refuses more than 3 orders, wrong market, asks, and a flip price that is not above the bid', () => {
  assert.match(guardTx(planPlant(USER, plantBids(3).concat(plantBids(1))))!, /between 1 and 3/);
  assert.match(guardTx({ ...planPlant(USER, plantBids(1)), to: CHAIN.marginAccount })!, /MON-USDC market/);
  assert.match(guardTx(planPlant(USER, [{ price: 100n, flipPrice: 100n, size: market.minSize }]))!, /above its bid/);
});

test('planner: approve exact, then deposit, then plant, derived from chain numbers only', () => {
  const base = { lockedNeeded: usdc('5.2'), walletUsdc: usdc('10'), walletMon: parseUnits('3', 18), allowance: 0n, marginUsdc: 0n, openOrders: 0 };
  assert.deepEqual(nextPlantAction(base), { type: 'approve', amount: usdc('5.2') });
  assert.deepEqual(nextPlantAction({ ...base, allowance: usdc('5.2') }), { type: 'deposit', amount: usdc('5.2') });
  assert.deepEqual(nextPlantAction({ ...base, allowance: usdc('5.2'), marginUsdc: usdc('2') }), { type: 'deposit', amount: usdc('3.2') });
  assert.deepEqual(nextPlantAction({ ...base, marginUsdc: usdc('5.2') }), { type: 'plant' });
  assert.deepEqual(nextPlantAction({ ...base, marginUsdc: usdc('9') }), { type: 'plant' });
  assert.deepEqual(nextPlantAction({ ...base, openOrders: 2 }), { type: 'planted' });
});

test('planner: blocks on too little USDC, too little MON for gas, and the deposit cap', () => {
  const base = { lockedNeeded: usdc('5.2'), walletUsdc: usdc('10'), walletMon: parseUnits('3', 18), allowance: 0n, marginUsdc: 0n, openOrders: 0 };
  assert.match((nextPlantAction({ ...base, walletUsdc: usdc('1') }) as { reason: string }).reason, /more is needed/);
  assert.match((nextPlantAction({ ...base, walletMon: parseUnits('0.4', 18) }) as { reason: string }).reason, /0.5 MON/);
  assert.match((nextPlantAction({ ...base, lockedNeeded: usdc('15.5') }) as { reason: string }).reason, /cap/);
});

test('planner: unwind cancels live orders first, then withdraws only what is there', () => {
  assert.deepEqual(nextUnwindAction({ liveOrderIds: [7n, 8n], marginUsdc: 1n, marginMon: 1n }), { type: 'cancel', ids: [7n, 8n] });
  assert.deepEqual(nextUnwindAction({ liveOrderIds: [], marginUsdc: 5n, marginMon: 0n }), { type: 'withdraw', tokens: [CHAIN.usdc] });
  assert.deepEqual(nextUnwindAction({ liveOrderIds: [], marginUsdc: 5n, marginMon: 9n }), { type: 'withdraw', tokens: [CHAIN.usdc, NATIVE] });
  assert.deepEqual(nextUnwindAction({ liveOrderIds: [], marginUsdc: 0n, marginMon: 0n }), { type: 'done' });
});
