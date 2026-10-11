// The garden game layer: growth stages, achievements and the level, on hand-made chains and on real recorded data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { decodeLog, type KuruEvent } from '../src/events.ts';
import { buildLedger, type Ledger, type Order } from '../src/ledger.ts';
import { marketFromJson } from '../src/units.ts';
import { DAY_SECONDS, ROUND_TRIP_SEEN_ON_REAL_DATA, achievements, gardenOf, gardenSpan, levelOf, plotsOf, stageOf } from '../src/garden.ts';
import { WALLET, events as gateEvents, market as gateMarket, txs as gateTxs } from './helpers/gate.ts';

const M = '0x065c9d28e428a0db40191a54d33d5b7c71a9c394';
let n = 1n;
const order = (o: Partial<Order> & { status: Order['status'] }): Order => ({
  market: M, id: n++, owner: WALLET, isBuy: true, price: 100n, flipPrice: 110n, origin: 'placed', parent: null, children: [],
  initialSize: 1000n, remaining: 1000n, filled: 0n, createdBlock: 10, closedBlock: null, fills: [], ...o,
});
const chain = (...specs: Array<Partial<Order> & { status: Order['status'] }>): Order[] => {
  const list = specs.map((s, i) => order({ origin: i === 0 ? 'placed' : 'flipped', ...s }));
  list.forEach((o, i) => { if (i > 0) { o.parent = { orderId: list[i - 1].id, fillKey: 'k' }; list[i - 1].children = [o.id]; } });
  return list;
};
const ledgerOf = (orders: Order[], extra: Partial<Ledger> = {}): Ledger =>
  ({ account: WALLET, untilBlock: 500, markets: new Map(), orders: new Map(orders.map((o) => [`${M}:${o.id}`, o])), fills: [], flows: [], balances: new Map(), gas: { token: '', totalWei: 0n, txs: [] }, issues: [], ...extra }) as Ledger;

test('stage mapping: planted, partly filled, filled, round trip, pruned', () => {
  assert.equal(stageOf(chain({ status: 'open' })), 'seed');
  assert.equal(stageOf(chain({ status: 'open', filled: 300n, remaining: 700n })), 'sprout');
  assert.equal(stageOf(chain({ status: 'filled', filled: 1000n, remaining: 0n }, { status: 'open' })), 'flower');
  assert.equal(stageOf(chain({ status: 'filled', filled: 1000n }, { status: 'open', isBuy: false, filled: 200n })), 'flower', 'a partly filled second leg stays a flower');
  assert.equal(stageOf(chain({ status: 'filled', filled: 1000n }, { status: 'filled', filled: 1000n }, { status: 'open' })), 'fruit');
  assert.equal(stageOf(chain({ status: 'cancelled' })), 'pruned');
  assert.equal(stageOf(chain({ status: 'filled', filled: 1000n }, { status: 'cancelled' })), 'pruned', 'the flipped sell was cut (the 2026-10-11 real run)');
  assert.equal(stageOf(chain({ status: 'cancelled', filled: 400n }, { status: 'open' })), 'sprout', 'a partly filled order that was cancelled left a live flipped order');
  assert.equal(stageOf(chain({ status: 'filled', filled: 1000n }, { status: 'filled', filled: 1000n }, { status: 'cancelled' })), 'fruit', 'a round trip stays a round trip when the last order is cut');
  assert.equal(stageOf([]), 'seed');
});

test('plots follow the flip chain from the planted order and count round trips', () => {
  const a = chain({ status: 'filled', filled: 1000n }, { status: 'filled', filled: 1000n }, { status: 'filled', filled: 1000n }, { status: 'filled', filled: 1000n }, { status: 'open' });
  const b = chain({ status: 'open' });
  const plots = plotsOf(ledgerOf([...a, ...b]), M);
  assert.equal(plots.length, 2);
  assert.deepEqual(plots[0].orders.map((o) => o.id), a.map((o) => o.id));
  assert.equal(plots[0].stage, 'fruit');
  assert.equal(plots[0].roundTrips, 2);
  assert.equal(plots[0].live.length, 1);
  assert.equal(plots[1].stage, 'seed');
  assert.equal(plotsOf(ledgerOf([...a]), '0x0000000000000000000000000000000000000001').length, 0, 'other markets are ignored');
});

test('achievements are computed from the ledger and nothing else', () => {
  const none = achievements({ ledger: ledgerOf([]), market: M });
  assert.ok(none.every((a) => !a.earned));
  const three = [...chain({ status: 'open' }), ...chain({ status: 'cancelled' }), ...chain({ status: 'filled', filled: 1n }, { status: 'filled', filled: 1n })];
  const L = ledgerOf(three, { fills: [{ block: 11 } as never], flows: [{ kind: 'withdrawal', amount: -5n } as never] });
  const got = Object.fromEntries(achievements({ ledger: L, market: M, ageSeconds: 8 * DAY_SECONDS }).map((a) => [a.id, a]));
  for (const id of Object.keys(got)) assert.equal(got[id].earned, true, id);
  assert.match(got['first-round-trip'].note ?? '', /Not yet seen on real data/);
  const young = Object.fromEntries(achievements({ ledger: L, market: M, ageSeconds: 6 * DAY_SECONDS }).map((a) => [a.id, a]));
  assert.equal(young['seven-days'].earned, false);
  const unknownAge = Object.fromEntries(achievements({ ledger: L, market: M }).map((a) => [a.id, a]));
  assert.equal(unknownAge['seven-days'].earned, false);
  assert.match(unknownAge['seven-days'].note ?? '', /unknown/);
  const zero = Object.fromEntries(achievements({ ledger: ledgerOf(three, { flows: [{ kind: 'withdrawal', amount: 0n } as never] }), market: M }).map((a) => [a.id, a]));
  assert.equal(zero['first-harvest'].earned, false, 'a withdrawal of nothing is not a harvest');
});

test('level uses round trips and age only', () => {
  assert.equal(levelOf({ roundTrips: 0, ageSeconds: 0 }).name, 'Seed');
  assert.equal(levelOf({ roundTrips: 0 }).name, 'Seed');
  assert.equal(levelOf({ roundTrips: 1 }).name, 'Sprout');
  assert.equal(levelOf({ roundTrips: 0, ageSeconds: DAY_SECONDS }).name, 'Sprout');
  assert.equal(levelOf({ roundTrips: 3, ageSeconds: 2 * DAY_SECONDS }).name, 'Sprout', 'Bloom needs both');
  assert.equal(levelOf({ roundTrips: 3, ageSeconds: 3 * DAY_SECONDS }).name, 'Bloom');
  assert.equal(levelOf({ roundTrips: 10, ageSeconds: 6 * DAY_SECONDS }).name, 'Bloom');
  const top = levelOf({ roundTrips: 10, ageSeconds: 7 * DAY_SECONDS });
  assert.equal(top.name, 'Orchard');
  assert.equal(top.next, null);
  assert.match(levelOf({ roundTrips: 0 }).next ?? '', /^Sprout: 1 completed round trip or 1 day/);
  assert.match(top.note, /nothing about profit/);
  assert.equal(levelOf({ roundTrips: 0 }).index, 0);
});

test('gardenSpan reports the first and last block, and nothing for an empty ledger', () => {
  const a = chain({ status: 'open', createdBlock: 40 });
  const b = chain({ status: 'open', createdBlock: 25 });
  assert.deepEqual(gardenSpan(ledgerOf([...a, ...b], { untilBlock: 99 }), M), { firstBlock: 25, lastBlock: 99 });
  assert.deepEqual(gardenSpan(ledgerOf([]), M), { firstBlock: null, lastBlock: null });
});

// --- real recorded data ---------------------------------------------------------------------------------

const partialFx = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'flip-partial-fills-0x52ce.raw.json'), 'utf8'));
const partialMarket = marketFromJson(partialFx.marketParams, partialFx.market);
const partialLedger = buildLedger({ account: partialFx.owner, markets: [partialMarket], events: partialFx.logs.map((l: never) => decodeLog(l)!) as KuruEvent[] });
const gateLedger = buildLedger({ account: WALLET, markets: [gateMarket], events: gateEvents, txs: gateTxs });

test('real data: our gate test is one pruned plot after a fill, and the other account shows what Kuru really produced', () => {
  const g = plotsOf(gateLedger, gateMarket.address);
  assert.equal(g.length, 1);
  assert.equal(g[0].stage, 'pruned');
  assert.equal(g[0].filledLegs, 1);
  assert.equal(g[0].roundTrips, 0);
  const p = plotsOf(partialLedger, partialMarket.address);
  assert.equal(p.length, 119);
  const count = (s: string): number => p.filter((x) => x.stage === s).length;
  assert.deepEqual([count('pruned'), count('flower'), count('sprout')], [117, 1, 1]);
  assert.equal(p.filter((x) => x.live.length > 0).length, 1);
});

test('the "not yet seen on real data" flag matches the recorded data', () => {
  const trips = [...plotsOf(gateLedger, gateMarket.address), ...plotsOf(partialLedger, partialMarket.address)].reduce((a, x) => a + x.roundTrips, 0);
  assert.equal(ROUND_TRIP_SEEN_ON_REAL_DATA, trips > 0, 'flip ROUND_TRIP_SEEN_ON_REAL_DATA in src/garden.ts when a fixture contains a completed round trip');
});

test('gardenOf on real data: achievements, level and the unverified label', () => {
  const g = gardenOf({ ledger: gateLedger, market: gateMarket.address, ageSeconds: 600 });
  const by = Object.fromEntries(g.achievements.map((a) => [a.id, a.earned]));
  assert.deepEqual(by, { 'first-planting': true, 'first-fill': true, 'first-round-trip': false, 'three-plots': false, 'seven-days': false, 'first-prune': true, 'first-harvest': true });
  assert.equal(g.level.name, 'Seed');
  assert.equal(g.seenOnRealData, false);
  const o = gardenOf({ ledger: partialLedger, market: partialMarket.address, ageSeconds: 9 * DAY_SECONDS });
  assert.equal(o.level.name, 'Sprout', 'no completed round trip in the data, nine days old');
  assert.equal(o.achievements.find((a) => a.id === 'three-plots')!.earned, true);
});
