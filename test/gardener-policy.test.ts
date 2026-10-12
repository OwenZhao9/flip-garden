// The Gardener's deterministic policy: mandate validation, stop conditions, the questions and their allowed options,
// confidence routing and intents. Pure functions only; no chain, no model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultMandate, validateMandate, hasRoom, lastHour, remaining, type Mandate, type Spend } from '../src/gardener/mandate.ts';
import {
  afterAction, checkBid, feeReserveWei, freshMemory, gardenMon, intentOf, needsRefuel, passiveBid, questions, remember, replantSize, route, stopCheck, POLICY,
  type Observation, type Question,
} from '../src/gardener/policy.ts';
import { NATIVE, type Market } from '../src/units.ts';
import { CHAIN } from '../src/plant.ts';

const USER = '0x39fdc1b554fcf0b7478e58ff671f3d0fea64da38';
const MON = 10n ** 18n;
const MARKET: Market = {
  address: CHAIN.market.toLowerCase(), pricePrecision: 10n ** 8n, sizePrecision: 10n ** 10n, baseAsset: NATIVE, baseDecimals: 18, quoteAsset: CHAIN.usdc.toLowerCase(), quoteDecimals: 6,
  tickSize: 100n, minSize: 200n * 10n ** 10n, maxSize: 2n * 10n ** 18n, takerFeeBps: 0n, makerFeeBps: 0n,
};
const T0 = 1_800_000_000_000;
const BOOK = { bestBid: 2_561_300n, bestAsk: 2_565_500n };

function obs(p: Partial<Observation> = {}): Observation {
  return { block: 1000, readAtMs: T0, market: MARKET, book: BOOK, mids: [2_563_400n], orders: [], walletMon: 2n * MON, marginUsdc: 0n, marginMon: 0n, hedge: null, gasPriceWei: 100n * 10n ** 9n, ...p };
}
const mandate = (p: Partial<Mandate> = {}): Mandate => ({ ...defaultMandate(USER, T0, BOOK, 100n), ...p });
const mem = () => remember(freshMemory(), obs(), T0);
const bid = (id: bigint, price: bigint, size = 234n * 10n ** 10n) => ({ id, isBuy: true, price, flipPrice: price + 2600n, size });

test('the default mandate is valid; every bound is enforced', () => {
  const m = mandate();
  assert.deepEqual(validateMandate(m, T0), []);
  assert.equal(m.expiresMs - m.startMs, 3_600_000, 'default expiry is one hour');
  assert.ok(m.priceMin < BOOK.bestBid && m.priceMax > BOOK.bestAsk);
  const bad = (p: Partial<Mandate>) => validateMandate(mandate(p), T0).length > 0;
  assert.ok(bad({ expiresMs: T0 + 25 * 3_600_000 }), 'at most 24 hours');
  assert.ok(bad({ expiresMs: T0 - 1 }), 'expiry in the future');
  assert.ok(bad({ usdcBudget: 15_000_001n }), 'USDC budget within the planting cap');
  assert.ok(bad({ ausdBudget: 15_000_001n }), 'AUSD budget within the hedge deposit cap');
  assert.ok(bad({ priceMin: 3_000_000n, priceMax: 2_000_000n }));
  assert.ok(bad({ maxTxPerHour: 31 }));
  assert.ok(bad({ maxFeeWeiPerHour: 3n * MON }));
  assert.ok(bad({ askAt: 0.9, actAt: 0.8 }));
  assert.ok(bad({ actions: ['requote', 'withdrawAll' as never] }));
  assert.ok(bad({ account: 'not an address' }));
});

test('hourly budget: transactions and fees in the last hour only', () => {
  const m = mandate({ maxTxPerHour: 2, maxFeeWeiPerHour: MON / 10n });
  const spend: Spend = [
    { atMs: T0 - 3_700_000, kind: 'plant', feeWei: MON, ok: true }, // older than an hour: ignored
    { atMs: T0 - 1000, kind: 'cancel', feeWei: MON / 20n, ok: true },
  ];
  assert.deepEqual(lastHour(spend, T0), { txs: 1, feeWei: MON / 20n, failures: 0 });
  assert.equal(hasRoom(m, spend, T0, 1, MON / 20n), true);
  assert.equal(hasRoom(m, spend, T0, 1, MON / 20n + 1n), false, 'fee budget');
  assert.equal(hasRoom(m, spend, T0, 2, 0n), false, 'transaction budget');
  assert.equal(remaining(m, spend, T0).txs, 1);
});

test('stop conditions: expiry and repeated failures are final; stale data, a bad book and an empty budget wait', () => {
  const m = mandate();
  assert.equal(stopCheck(obs(), m, [], mem(), T0 + 1000), null);
  assert.deepEqual(stopCheck(obs(), m, [], mem(), m.expiresMs)?.kind, 'expired');
  assert.equal(stopCheck(obs(), m, [], mem(), m.expiresMs)?.final, true);
  const fails: Spend = [1, 2, 3].map((i) => ({ atMs: T0 - i * 1000, kind: 'plant', feeWei: 0n, ok: false }));
  assert.equal(stopCheck(obs(), m, fails, mem(), T0)?.kind, 'failures');
  assert.equal(stopCheck(obs(), m, fails.slice(0, 2), mem(), T0), null, 'two failures are not enough');
  assert.equal(stopCheck(obs({ readAtMs: T0 - POLICY.staleMs - 1 }), m, [], mem(), T0)?.kind, 'stale');
  const stuck = { ...mem(), lastBlockAtMs: T0 - POLICY.staleMs - 1 };
  assert.equal(stopCheck(obs(), m, [], stuck, T0)?.kind, 'stale', 'no new block for a while');
  assert.equal(stopCheck(obs({ book: { bestBid: 0n, bestAsk: 0n } }), m, [], mem(), T0)?.kind, 'book');
  assert.equal(stopCheck(obs({ book: { bestBid: 2_500_000n, bestAsk: 2_560_000n } }), m, [], mem(), T0)?.kind, 'spread', '2.4% spread');
  const full: Spend = Array.from({ length: m.maxTxPerHour }, (_, i) => ({ atMs: T0 - i, kind: 'plant', feeWei: 0n, ok: true }));
  const s = stopCheck(obs(), m, full, mem(), T0);
  assert.equal(s?.kind, 'budget');
  assert.equal(s?.final, false);
});

test('tend: a bid that left the range offers keep, requote and prune; the rules re-place it one tick above the best bid', () => {
  const m = mandate({ usdcBudget: 15_000_000n }); // two bids of 234 MON lock about 12 USDC
  const far = bid(7n, 2_540_000n); // 0.83% under the best bid, band is 0.20%
  const near = bid(8n, 2_560_000n); // 0.05% under
  const o = obs({ orders: [near, far] });
  const qs = questions(o, m, [], mem(), T0);
  assert.equal(qs.length, 1);
  assert.equal(qs[0].id, 'tend');
  assert.deepEqual(qs[0].options, ['keep', 'requote', 'prune']);
  assert.equal(qs[0].rulesChoice, 'requote');
  assert.equal(qs[0].facts.orderId, 7n);
  assert.deepEqual(intentOf(qs[0], 'requote', o, m), { type: 'requote', kind: 'requote', cancelId: 7n, size: far.size });
  assert.deepEqual(intentOf(qs[0], 'prune', o, m), { type: 'prune', kind: 'requote', ids: [7n] });
  assert.equal(intentOf(qs[0], 'keep', o, m), null);
  const fresh = passiveBid(o, far.size);
  assert.equal(fresh.price, BOOK.bestBid + 100n, 'one tick above the best bid');
  assert.ok(fresh.price < BOOK.bestAsk);
});

test('tend: requote is not offered when the new price leaves the price range or the action is not allowed', () => {
  const far = bid(7n, 2_540_000n);
  const outside = mandate({ priceMax: 2_550_000n });
  const qs = questions(obs({ orders: [far] }), outside, [], mem(), T0);
  assert.deepEqual(qs[0].options, ['keep', 'prune']);
  assert.equal(qs[0].rulesChoice, 'keep');
  assert.deepEqual(questions(obs({ orders: [far] }), mandate({ actions: ['harvest'] }), [], mem(), T0), []);
});

test('recover: free USDC and no bid -> replant within the budget; nothing below the market minimum', () => {
  const m = mandate();
  const o = obs({ marginUsdc: 5_998_884n });
  const qs = questions(o, m, [], mem(), T0);
  assert.deepEqual(qs.map((q) => q.id), ['recover']);
  assert.deepEqual(qs[0].options, ['wait', 'replant']);
  assert.deepEqual(intentOf(qs[0], 'replant', o, m), { type: 'replant', kind: 'replant' });
  const size = replantSize(o, m, passiveBid(o, MARKET.minSize).price);
  assert.equal(size, 234n * 10n ** 10n, '5.998884 USDC buys 234 whole MON at 0.025614');
  assert.equal(replantSize(obs({ marginUsdc: 4_000_000n }), m, 2_561_400n), 0n, 'below 200 MON');
  assert.equal(replantSize(o, mandate({ usdcBudget: 3_000_000n }), 2_561_400n), 0n, 'the budget caps it');
  assert.deepEqual(questions(obs({ marginUsdc: 4_000_000n }), m, [], mem(), T0), []);
});

test('cool-downs and back-off: a failed replant waits 30 s, then 60 s', () => {
  const m = mandate();
  const o = obs({ marginUsdc: 6_000_000n });
  let me = afterAction(mem(), 'replant', false, T0);
  assert.deepEqual(questions(o, m, [], me, T0 + 29_000), []);
  assert.equal(questions(o, m, [], me, T0 + 31_000).length, 1);
  me = afterAction(me, 'replant', false, T0 + 31_000);
  assert.deepEqual(questions(o, m, [], me, T0 + 31_000 + 59_000), []);
  me = afterAction(me, 'replant', true, T0 + 100_000);
  assert.equal(me.backoffMs.replant, 0, 'a success resets the back-off');
});

test('harvest: idle money is offered for withdrawal only after five minutes and only if replanting does not want it', () => {
  const m = mandate({ actions: ['harvest'] });
  const o = obs({ marginMon: 234n * MON });
  let me = remember(freshMemory(), o, T0);
  assert.deepEqual(questions(o, m, [], me, T0 + 60_000), []);
  me = remember(me, o, T0 + POLICY.idleBeforeHarvestMs);
  const qs = questions(o, m, [], me, T0 + POLICY.idleBeforeHarvestMs);
  assert.deepEqual(qs.map((q) => q.id), ['harvest']);
  assert.deepEqual(intentOf(qs[0], 'harvest', o, m), { type: 'harvest', kind: 'harvest', tokens: [NATIVE] });
  // with replant allowed, free USDC goes to the recover question instead
  const both = mandate({ actions: ['replant', 'harvest'] });
  const ou = obs({ marginUsdc: 6_000_000n });
  const mu = remember(remember(freshMemory(), ou, T0), ou, T0 + POLICY.idleBeforeHarvestMs);
  assert.deepEqual(questions(ou, both, [], mu, T0 + POLICY.idleBeforeHarvestMs).map((q) => q.id), ['recover']);
});

test('refuel: low wallet MON with MON free at Kuru is a fixed rule; low gas also blocks new orders', () => {
  const m = mandate();
  const low = obs({ walletMon: MON / 10n, marginMon: 234n * MON, marginUsdc: 6_000_000n });
  assert.ok(feeReserveWei(low) >= 500_000_000_000_000_000n);
  assert.equal(needsRefuel(low, m, [], mem(), T0), true);
  assert.equal(needsRefuel(obs({ walletMon: MON / 10n }), m, [], mem(), T0), false, 'nothing to refuel from');
  assert.deepEqual(questions(low, m, [], mem(), T0).map((q) => q.id), [], 'no replant while gas is low');
});

test('hedge: a short larger than the range allows is reduced to the middle; with no inventory it is closed', () => {
  const m = mandate({ actions: ['hedge'] });
  const sell = { id: 9n, isBuy: false, price: 2_565_000n, flipPrice: 2_562_000n, size: 100n * 10n ** 10n };
  const o = obs({ orders: [sell], hedge: { hasAccount: true, freeCNS: 5_000_000n, shortLot: 219n, otherExposure: false } });
  assert.equal(gardenMon(o), 100n);
  const qs = questions(o, m, [], mem(), T0);
  assert.deepEqual(qs.map((q) => q.id), ['hedge']);
  assert.equal(qs[0].facts.ratioBps, 21_900n);
  assert.deepEqual(intentOf(qs[0], 'adjust', o, m), { type: 'hedgeReduce', kind: 'hedge', lot: 219n - 50n });
  const none = obs({ hedge: { hasAccount: true, freeCNS: 5_000_000n, shortLot: 219n, otherExposure: false } });
  const q2 = questions(none, m, [], mem(), T0)[0];
  assert.equal(q2.facts.ratioBps, null);
  assert.deepEqual(intentOf(q2, 'adjust', none, m), { type: 'hedgeReduce', kind: 'hedge', lot: 219n });
  assert.deepEqual(questions(obs({ ...o, hedge: { ...o.hedge!, otherExposure: true } }), m, [], mem(), T0), [], 'other exposure: left alone');
});

test('hedge: no short and inventory under the range opens one at the middle; an existing small short is left to the user', () => {
  const m = mandate({ actions: ['hedge'] });
  const sell = { id: 9n, isBuy: false, price: 2_565_000n, flipPrice: 2_562_000n, size: 234n * 10n ** 10n };
  const o = obs({ orders: [sell], hedge: { hasAccount: true, freeCNS: 5_000_000n, shortLot: 0n, otherExposure: false } });
  const qs = questions(o, m, [], mem(), T0);
  assert.deepEqual(intentOf(qs[0], 'adjust', o, m), { type: 'hedgeOpen', kind: 'hedge', ratioBps: 5000n });
  const small = obs({ orders: [sell], hedge: { hasAccount: true, freeCNS: 5_000_000n, shortLot: 10n, otherExposure: false } });
  assert.deepEqual(questions(small, m, [], mem(), T0), []);
  const noAccount = obs({ orders: [sell], hedge: { hasAccount: false, freeCNS: 0n, shortLot: 0n, otherExposure: false } });
  assert.deepEqual(questions(noAccount, m, [], mem(), T0), [], 'the Gardener never creates a Perpl account');
});

test('routing: act at or above actAt, ask between, skip below or on anything malformed', () => {
  const m = mandate();
  const q: Question = { id: 'recover', options: ['wait', 'replant'], rulesChoice: 'replant', facts: {}, why: '' };
  assert.equal(route(q, { choice: 'replant', confidence: 0.9, source: 'jev' }, m), 'act');
  assert.equal(route(q, { choice: 'replant', confidence: 0.85, source: 'jev' }, m), 'act');
  assert.equal(route(q, { choice: 'replant', confidence: 0.7, source: 'jev' }, m), 'ask');
  assert.equal(route(q, { choice: 'replant', confidence: 0.59, source: 'jev' }, m), 'skip');
  assert.equal(route(q, { choice: 'prune', confidence: 1, source: 'jev' }, m), 'skip', 'not an offered option');
  assert.equal(route(q, { choice: 'replant', confidence: Number.NaN, source: 'jev' }, m), 'skip');
  assert.equal(route(q, { choice: 'replant', confidence: 1.5, source: 'jev' }, m), 'skip');
  assert.equal(route(q, null, m), 'skip');
});

test('checkBid: the last check before a plant refuses anything outside the mandate', () => {
  const m = mandate();
  const o = obs();
  const ok = passiveBid(o, 234n * 10n ** 10n);
  assert.equal(checkBid(ok, o, m, 0n), null);
  assert.match(checkBid({ ...ok, price: m.priceMax + 100n }, o, m, 0n)!, /price range/);
  assert.match(checkBid({ ...ok, price: BOOK.bestAsk }, o, m, 0n)!, /cross/);
  assert.match(checkBid({ ...ok, size: 199n * 10n ** 10n }, o, m, 0n)!, /minimum/);
  assert.match(checkBid(ok, o, m, 1_000_000n)!, /budget/);
});
