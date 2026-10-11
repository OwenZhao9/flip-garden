// The web side of the leaderboard: answer parsing, the registration call and the markup, all against a fake fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ageText, boardHtml, fetchBoard, fetchGarden, parseBoard, parseGarden, register, statusHtml } from '../web/src/leaderboard.ts';

const BASE = 'https://board.example';
const ADDR = '0x39FdC1B554FCF0B7478E58ff671f3d0FEA64DA38';
const reply = (status: number, body: unknown): typeof fetch => (async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;

test('parseBoard keeps well-formed rows and drops malformed ones', () => {
  const b = parseBoard({ updatedAt: '2026-10-11T10:00:00.000Z', rows: [
    { rank: 1, address: '0x1234…abcd', completedRoundTrips: 3, gardenAgeDays: 9, level: 'Bloom', updatedAt: 'x' },
    { rank: 2, address: 5, completedRoundTrips: 1, gardenAgeDays: 1, level: 'Seed', updatedAt: 'x' },
    { rank: -1, address: 'a', completedRoundTrips: 1, gardenAgeDays: 1, level: 'Seed', updatedAt: 'x' },
  ] });
  assert.equal(b?.rows.length, 1);
  assert.equal(b?.rows[0].level, 'Bloom');
});

test('parseBoard and parseGarden refuse answers of the wrong shape', () => {
  assert.equal(parseBoard(null), null);
  assert.equal(parseBoard({ rows: 'x' }), null);
  assert.equal(parseGarden({ address: 1 }), null);
  const g = parseGarden({ address: ADDR, catchingUp: true, scannedTo: 5, figures: null });
  assert.equal(g?.figures, null);
});

test('fetchBoard and fetchGarden call the service and treat errors as nothing', async () => {
  const seen: string[] = [];
  const f = (async (u: string) => {
    seen.push(u);
    return new Response(JSON.stringify({ rows: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  assert.deepEqual((await fetchBoard(BASE, f))?.rows, []);
  assert.equal(seen[0], `${BASE}/leaderboard`);
  assert.equal(await fetchBoard(BASE, reply(500, { error: 'x' })), null);
  assert.equal(await fetchGarden(BASE, ADDR, reply(404, { error: 'not registered' })), null);
  const g = await fetchGarden(BASE, ADDR, reply(200, { address: ADDR.toLowerCase(), catchingUp: false, scannedTo: 9, figures: { completedRoundTrips: 2, gardenAgeDays: 4, level: 'Sprout', updatedAt: 't' } }));
  assert.equal(g?.figures?.completedRoundTrips, 2);
});

test('register sends only the address and the start block', async () => {
  let sent: { url: string; init: RequestInit } | undefined;
  const f = (async (url: string, init: RequestInit) => {
    sent = { url, init };
    return new Response(JSON.stringify({ registered: true, alreadyRegistered: false }), { status: 201 });
  }) as unknown as typeof fetch;
  const r = await register(BASE, ` ${ADDR} `, 112209462, f);
  assert.deepEqual(r, { ok: true, alreadyRegistered: false });
  assert.equal(sent!.url, `${BASE}/register`);
  assert.equal(sent!.init.method, 'POST');
  assert.deepEqual(JSON.parse(String(sent!.init.body)), { address: ADDR, startBlock: 112209462 });
});

test('register validates locally and reports service and network errors', async () => {
  let calls = 0;
  const count = (async () => { calls++; return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
  assert.equal((await register(BASE, 'nope', 5, count)).ok, false);
  assert.equal((await register(BASE, ADDR, -1, count)).ok, false);
  assert.equal((await register(BASE, ADDR, 1.5, count)).ok, false);
  assert.equal(calls, 0, 'invalid input never reaches the network');
  const full = await register(BASE, ADDR, 5, reply(409, { error: 'The leaderboard is full (500 wallets).' }));
  assert.deepEqual(full, { ok: false, error: 'The leaderboard is full (500 wallets).' });
  const odd = await register(BASE, ADDR, 5, reply(502, 'bad gateway'));
  assert.equal(odd.ok, false);
  const down = await register(BASE, ADDR, 5, (async () => { throw new Error('offline'); }) as unknown as typeof fetch);
  assert.equal(down.ok, false);
  assert.equal((await register(BASE, ADDR, 5, reply(200, { alreadyRegistered: true }))).ok && true, true);
});

test('markup escapes service text and labels unverified figures', () => {
  const html = boardHtml({ updatedAt: '2026-10-11T10:00:00.000Z', rows: [{ rank: 1, address: '<img src=x>', completedRoundTrips: 0, gardenAgeDays: null, level: '<b>Seed</b>', updatedAt: 't' }] });
  assert.ok(!html.includes('<img') && !html.includes('<b>'));
  assert.doesNotMatch(html, /verified/i);
  assert.match(html, /not started/);
  assert.match(boardHtml({ updatedAt: null, rows: [] }), /No garden is ranked yet/);
  assert.equal(ageText(1), '1 day');
  assert.match(statusHtml({ address: ADDR, catchingUp: true, scannedTo: 1, figures: null }), /still reading the chain/);
  assert.match(statusHtml({ address: ADDR, catchingUp: false, scannedTo: 1, figures: { completedRoundTrips: 1, gardenAgeDays: 2, level: 'Seed', updatedAt: 't' } }), /1<\/strong> completed round trip,/);
});
