// Leaderboard service, pure parts: input validation, ranking and tie-breaks, level thresholds, CORS, rate limiter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRegistration, MAX_BODY_BYTES } from '../server/src/validate.ts';
import { rankRecords, shortAddress } from '../server/src/rank.ts';
import { makeFigures, roundTripsOf } from '../server/src/figures.ts';
import { corsHeaders, originAllowed, ALLOWED_ORIGIN } from '../server/src/cors.ts';
import { Limiter } from '../server/src/ratelimit.ts';
import { levelOf, DAY_SECONDS } from '../src/garden.ts';
import type { Ledger, Order } from '../src/ledger.ts';
import type { WalletRecord } from '../server/src/types.ts';

const A = '0x39fdc1b554fcf0b7478e58ff671f3d0fea64da38';
const lim = { marketFirstBlock: 1000, head: 5000 };
const body = (o: unknown): string => JSON.stringify(o);

test('registration: a valid body is accepted and the address is lower-cased', () => {
  const r = parseRegistration(body({ address: A.toUpperCase().replace('0X', '0x'), startBlock: 2000 }), lim);
  assert.deepEqual(r, { ok: true, value: { address: A, startBlock: 2000 } });
  assert.equal(parseRegistration(body({ address: A, startBlock: 1000 }), lim).ok, true, 'the first block itself is allowed');
  assert.equal(parseRegistration(body({ address: A, startBlock: 5000 }), lim).ok, true, 'the head itself is allowed');
});

test('registration: every malformed input is rejected with a 4xx and a reason', () => {
  const bad: Array<[string, string, number]> = [
    ['not json', '{nope', 400],
    ['array body', '[]', 400],
    ['null body', 'null', 400],
    ['missing address', body({ startBlock: 2000 }), 400],
    ['short address', body({ address: '0x1234', startBlock: 2000 }), 400],
    ['no 0x prefix', body({ address: A.slice(2), startBlock: 2000 }), 400],
    ['non-hex address', body({ address: '0x' + 'g'.repeat(40), startBlock: 2000 }), 400],
    ['zero address', body({ address: '0x' + '0'.repeat(40), startBlock: 2000 }), 400],
    ['numeric address', body({ address: 5, startBlock: 2000 }), 400],
    ['string block', body({ address: A, startBlock: '2000' }), 400],
    ['fractional block', body({ address: A, startBlock: 2000.5 }), 400],
    ['negative block', body({ address: A, startBlock: -1 }), 400],
    ['block before the market', body({ address: A, startBlock: 999 }), 400],
    ['block in the future', body({ address: A, startBlock: 5001 }), 400],
    ['unsafe integer', '{"address":"' + A + '","startBlock":1e300}', 400],
    ['extra field', body({ address: A, startBlock: 2000, score: 99 }), 400],
    ['oversized body', body({ address: A, startBlock: 2000, pad: 'x'.repeat(MAX_BODY_BYTES) }), 413],
  ];
  for (const [name, text, status] of bad) {
    const r = parseRegistration(text, lim);
    assert.equal(r.ok, false, name);
    if (!r.ok) {
      assert.equal(r.status, status, name);
      assert.ok(r.error.length > 0, name);
    }
  }
});

const rec = (address: string, trips: number, ageDays: number | null): WalletRecord => ({
  address, startBlock: 1, registeredAt: 'x', nextBlock: 2, catchingUp: false,
  figures: { completedRoundTrips: trips, gardenAgeDays: ageDays, level: 'Seed', levelIndex: 0, firstBlock: 1, updatedAt: '2026-10-11T00:00:00.000Z' },
});
const addr = (n: number): string => '0x' + n.toString(16).padStart(40, '0');

test('ranking: round trips first, then garden age, never anything else', () => {
  const rows = rankRecords([rec(addr(1), 2, 30), rec(addr(2), 5, 1), rec(addr(3), 5, 9), rec(addr(4), 0, 100), rec(addr(5), 2, null)]);
  assert.deepEqual(rows.map((r) => r.address), [addr(3), addr(2), addr(1), addr(5), addr(4)].map(shortAddress));
  assert.deepEqual(rows.map((r) => r.rank), [1, 2, 3, 4, 5]);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['address', 'completedRoundTrips', 'gardenAgeDays', 'level', 'rank', 'updatedAt'], 'no profit field, no full address');
});

test('ranking: equal round trips and equal age share a rank, the next rank skips; the order is stable by address', () => {
  const rows = rankRecords([rec(addr(9), 3, 4), rec(addr(7), 3, 4), rec(addr(8), 1, 4)]);
  assert.deepEqual(rows.map((r) => r.rank), [1, 1, 3]);
  assert.deepEqual(rows.map((r) => r.address), [addr(7), addr(9), addr(8)].map(shortAddress));
  assert.deepEqual(rankRecords([rec(addr(1), 3, 4), rec(addr(2), 3, 4)]).map((r) => r.address), rankRecords([rec(addr(2), 3, 4), rec(addr(1), 3, 4)]).map((r) => r.address));
});

test('ranking: wallets that were never scanned are not ranked, and an empty list is an empty board', () => {
  const unscanned: WalletRecord = { ...rec(addr(1), 0, 0), figures: null };
  assert.deepEqual(rankRecords([unscanned]), []);
  assert.deepEqual(rankRecords([]), []);
});

test('shortAddress keeps six and four characters', () => {
  assert.equal(shortAddress(A), '0x39fd…da38');
});

test('level thresholds are the shared garden rules: Seed, Sprout, Bloom, Orchard', () => {
  const lv = (trips: number, days: number | null) => makeFigures({ completedRoundTrips: trips, firstBlock: 1, ageSeconds: days === null ? null : days * DAY_SECONDS, now: 'n' }).level;
  assert.equal(lv(0, 0), 'Seed');
  assert.equal(lv(0, null), 'Seed');
  assert.equal(lv(1, 0), 'Sprout');
  assert.equal(lv(0, 1), 'Sprout');
  assert.equal(lv(3, 2), 'Sprout');
  assert.equal(lv(3, 3), 'Bloom');
  assert.equal(lv(10, 6), 'Bloom');
  assert.equal(lv(10, 7), 'Orchard');
  assert.equal(makeFigures({ completedRoundTrips: 10, firstBlock: 1, ageSeconds: 7 * DAY_SECONDS, now: 'n' }).level, levelOf({ roundTrips: 10, ageSeconds: 7 * DAY_SECONDS }).name);
});

test('garden age is whole days, rounded down, and null when unknown', () => {
  assert.equal(makeFigures({ completedRoundTrips: 0, firstBlock: 1, ageSeconds: 2.9 * DAY_SECONDS, now: 'n' }).gardenAgeDays, 2);
  assert.equal(makeFigures({ completedRoundTrips: 0, firstBlock: 1, ageSeconds: 59, now: 'n' }).gardenAgeDays, 0);
  assert.equal(makeFigures({ completedRoundTrips: 0, firstBlock: null, ageSeconds: null, now: 'n' }).gardenAgeDays, null);
});

test('completed round trips come from the ledger core: a filled leg plus its filled flip is one', () => {
  const M = '0x065c9d28e428a0db40191a54d33d5b7c71a9c394';
  const mk = (id: bigint, status: Order['status'], parent: bigint | null, children: bigint[]): Order => ({
    market: M, id, owner: A, isBuy: true, price: 1n, flipPrice: 2n, origin: parent === null ? 'placed' : 'flipped',
    parent: parent === null ? null : { orderId: parent, fillKey: 'k' }, children, initialSize: 1n, remaining: 0n, status, filled: status === 'filled' ? 1n : 0n,
    createdBlock: 10, closedBlock: null, fills: [],
  });
  const orders = [mk(1n, 'filled', null, [2n]), mk(2n, 'filled', 1n, [3n]), mk(3n, 'open', 2n, []), mk(4n, 'filled', null, [5n]), mk(5n, 'cancelled', 4n, [])];
  const L = { account: A, untilBlock: 20, markets: new Map(), orders: new Map(orders.map((o) => [`${M}:${o.id}`, o])), fills: [], flows: [], balances: new Map(), gas: { token: '', totalWei: 0n, txs: [] }, issues: [] } as unknown as Ledger;
  assert.equal(roundTripsOf(L, M), 1, 'the second plot filled one leg only');
});

test('CORS: only the public page and local development are answered', () => {
  assert.equal(originAllowed(ALLOWED_ORIGIN), true);
  for (const o of ['http://localhost:5173', 'http://localhost', 'http://127.0.0.1:8080']) assert.equal(originAllowed(o), true, o);
  for (const o of ['https://evil.example', 'https://owenzhao9.github.io.evil.example', 'http://owenzhao9.github.io', 'https://localhost:3000', 'http://localhost.evil.example', 'null', '']) assert.equal(originAllowed(o), false, o);
  assert.equal(corsHeaders(ALLOWED_ORIGIN)['access-control-allow-origin'], ALLOWED_ORIGIN);
  assert.equal(corsHeaders('https://evil.example')['access-control-allow-origin'], undefined);
  assert.equal(corsHeaders(null)['access-control-allow-origin'], undefined);
  assert.notEqual(corsHeaders(ALLOWED_ORIGIN)['access-control-allow-origin'], '*');
});

test('limiter: allows up to the maximum in a window, then resets', () => {
  const l = new Limiter(3, 1000);
  assert.deepEqual([0, 1, 2, 3].map((t) => l.allow(t)), [true, true, true, false]);
  assert.equal(l.allow(1000), true);
});
