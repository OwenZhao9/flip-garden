// Leaderboard service end to end with a fake KV and a fake chain built from the real recorded logs. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { handle, runScheduled, type Deps } from '../server/src/app.ts';
import { Limiter } from '../server/src/ratelimit.ts';
import { ALLOWED_ORIGIN } from '../server/src/cors.ts';
import type { Chain, Env, KV } from '../server/src/types.ts';
import { marketFromJson } from '../src/units.ts';
import type { LogFilter } from '../src/scan.ts';
import type { RawLog } from '../src/events.ts';
import { raw, market as gateMarket, WALLET } from './helpers/gate.ts';

class FakeKV implements KV {
  data = new Map<string, string>();
  async get(k: string) { return this.data.get(k) ?? null; }
  async put(k: string, v: string) { this.data.set(k, v); }
  async delete(k: string) { this.data.delete(k); }
}

type Fake = Chain & { calls: number; failAt?: number; head: number };
function fakeChain(logs: RawLog[], market: typeof gateMarket, head: number, secondsPerBlock = 1): Fake {
  const c: Fake = {
    calls: 0, head,
    async blockNumber() { c.calls++; return c.head; },
    async getLogs(f: LogFilter) {
      c.calls++;
      assert.ok(f.toBlock - f.fromBlock + 1 <= 90, 'window above 90 blocks');
      if (c.failAt !== undefined && f.fromBlock <= c.failAt && c.failAt <= f.toBlock) throw new Error('rpc down');
      return logs.filter((l) => l.address.toLowerCase() === f.address && Number(BigInt(l.blockNumber)) >= f.fromBlock && Number(BigInt(l.blockNumber)) <= f.toBlock && f.topics[0].includes(l.topics[0]));
    },
    async marketParams() { c.calls++; return market; },
    async blockTimestamp(b: number) { c.calls++; return 1_800_000_000 + b * secondsPerBlock; },
  };
  return c;
}

const env = (kv: KV, over: Partial<Env> = {}): Env => ({ KV: kv, MARKET: raw.market, MARGIN_ACCOUNT: raw.marginAccount, MARKET_FIRST_BLOCK: '112000000', MAX_WALLETS: '500', MAX_RPC_CALLS_PER_RUN: '40', ...over });
const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
const deps = (chain: Chain, limiters?: Deps['limiters']): Deps => ({ chain, now: () => NOW, limiters });
const req = (p: string, init: RequestInit & { origin?: string } = {}): Request => new Request('https://lb.example' + p, { ...init, headers: { ...(init.origin ? { origin: init.origin } : {}), ...(init.body ? { 'content-type': 'application/json' } : {}) } });
const post = (address: string, startBlock: unknown, origin = ALLOWED_ORIGIN): Request => req('/register', { method: 'POST', body: JSON.stringify({ address, startBlock }), origin });
const START = 112209400;
const HEAD = 112211600;

test('register, then a scheduled run, then the board and the garden page, all from the real gate-test logs', async () => {
  const kv = new FakeKV();
  const chain = fakeChain(raw.logs, gateMarket, HEAD);
  const e = env(kv, { MAX_RPC_CALLS_PER_RUN: '1000' });
  const r = await handle(post(WALLET, START), e, deps(chain));
  assert.equal(r.status, 201);
  assert.equal(r.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
  assert.equal(((await (await handle(req('/leaderboard'), e, deps(chain))).json()) as { rows: unknown[] }).rows.length, 0, 'not ranked before the first scan');

  const cron = await runScheduled(e, deps(chain));
  assert.deepEqual(cron.scanned, [WALLET]);
  assert.equal(cron.ranked, 1);

  const board = (await (await handle(req('/leaderboard'), e, deps(chain))).json()) as { rows: Array<Record<string, unknown>> };
  assert.equal(board.rows.length, 1);
  assert.equal(board.rows[0].address, '0x39fd…da38');
  assert.equal(board.rows[0].completedRoundTrips, 0, 'the gate test filled one leg and cancelled the flipped order');
  assert.equal(board.rows[0].rank, 1);
  assert.equal(board.rows[0].level, 'Seed');
  assert.equal(typeof board.rows[0].gardenAgeDays, 'number');

  const g = (await (await handle(req('/garden/' + WALLET.toUpperCase().replace('0X', '0x')), e, deps(chain))).json()) as { catchingUp: boolean; figures: { completedRoundTrips: number } };
  assert.equal(g.catchingUp, false);
  assert.equal(g.figures.completedRoundTrips, 0);
});

test('only public chain data is stored: known keys, and the record holds address, start block, cursor and figures', async () => {
  const kv = new FakeKV();
  const chain = fakeChain(raw.logs, gateMarket, HEAD);
  const e = env(kv, { MAX_RPC_CALLS_PER_RUN: '1000' });
  await handle(post(WALLET, START), e, deps(chain));
  await runScheduled(e, deps(chain));
  assert.deepEqual([...kv.data.keys()].map((k) => k.split(':')[0]).sort(), ['board', 'index', 'market', 's', 'w']);
  const rec = JSON.parse(kv.data.get('w:' + WALLET)!);
  assert.deepEqual(Object.keys(rec).sort(), ['address', 'catchingUp', 'figures', 'firstTs', 'nextBlock', 'registeredAt', 'startBlock']);
  const everything = [...kv.data.values()].join(' ').toLowerCase();
  assert.ok(!/ip|user-agent|cf-connecting/.test(JSON.stringify(Object.keys(rec))), 'no request metadata in the record');
  assert.ok(!everything.includes('privatekey') && !everything.includes('mnemonic'));
});

test('the scan is resumable: small budgets over several runs reach the same figures as one big run', async () => {
  const big = new FakeKV();
  const bigChain = fakeChain(raw.logs, gateMarket, HEAD);
  const eb = env(big, { MAX_RPC_CALLS_PER_RUN: '1000' });
  await handle(post(WALLET, START), eb, deps(bigChain));
  await runScheduled(eb, deps(bigChain));

  const small = new FakeKV();
  const smallChain = fakeChain(raw.logs, gateMarket, HEAD);
  const es = env(small, { MAX_RPC_CALLS_PER_RUN: '20' });
  await handle(post(WALLET, START), es, deps(smallChain));
  let runs = 0;
  let before = smallChain.calls;
  while (runs < 20) {
    await runScheduled(es, deps(smallChain));
    runs++;
    assert.ok(smallChain.calls - before <= 20, 'a run stays within its request budget');
    before = smallChain.calls;
    if (!JSON.parse(small.data.get('w:' + WALLET)!).catchingUp) break;
  }
  assert.ok(runs > 1, 'a 20-request budget cannot finish 25 windows in one run');
  assert.ok(runs < 20);
  const a = JSON.parse(big.data.get('w:' + WALLET)!);
  const b = JSON.parse(small.data.get('w:' + WALLET)!);
  assert.equal(b.nextBlock, a.nextBlock);
  assert.deepEqual({ ...b.figures, updatedAt: 0 }, { ...a.figures, updatedAt: 0 });
  assert.equal(Object.keys(JSON.parse(small.data.get('s:' + WALLET)!).logs).length, raw.logs.length, 'every real log was kept, none twice');
});

test('a chain failure mid-scan keeps the cursor; the next run resumes without duplicates', async () => {
  const kv = new FakeKV();
  const chain = fakeChain(raw.logs, gateMarket, HEAD);
  const e = env(kv, { MAX_RPC_CALLS_PER_RUN: '1000' });
  await handle(post(WALLET, START), e, deps(chain));
  chain.failAt = 112210404;
  const bad = await runScheduled(e, deps(chain));
  assert.ok(bad.failed[WALLET]);
  const st1 = JSON.parse(kv.data.get('s:' + WALLET)!);
  assert.ok(st1.nextBlock > START && st1.nextBlock <= 112210404, 'windows before the failure were saved');
  chain.failAt = undefined;
  await runScheduled(e, deps(chain));
  const st2 = JSON.parse(kv.data.get('s:' + WALLET)!);
  assert.equal(Object.keys(st2.logs).length, raw.logs.length);
  assert.equal(JSON.parse(kv.data.get('w:' + WALLET)!).catchingUp, false);
});

test('garden age comes from two block timestamps, not an assumed block time', async () => {
  const kv = new FakeKV();
  // 1000 s per block makes the 2,200-block range about 25 days, whatever the real block time is.
  const chain = fakeChain(raw.logs, gateMarket, HEAD, 1000);
  const e = env(kv, { MAX_RPC_CALLS_PER_RUN: '1000' });
  await handle(post(WALLET, START), e, deps(chain));
  await runScheduled(e, deps(chain));
  const f = JSON.parse(kv.data.get('w:' + WALLET)!).figures;
  const first = f.firstBlock as number;
  assert.ok(first >= START && first < HEAD);
  assert.equal(f.gardenAgeDays, Math.floor(((HEAD - 2 - first) * 1000) / 86400));
  assert.equal(f.level, 'Sprout', 'no round trip but more than one day old');
});

test('real data from another account: 119 plots and no completed round trip, so zero', async () => {
  const fx = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'flip-partial-fills-0x52ce.raw.json'), 'utf8'));
  const m = marketFromJson(fx.marketParams, fx.market);
  const kv = new FakeKV();
  const last = Math.max(...fx.logs.map((l: RawLog) => Number(BigInt(l.blockNumber))));
  const chain = fakeChain(fx.logs, m, last + 10);
  const e = env(kv, { MARKET: fx.market, MARKET_FIRST_BLOCK: '110000000', MAX_RPC_CALLS_PER_RUN: '100000' });
  const first = Math.min(...fx.logs.map((l: RawLog) => Number(BigInt(l.blockNumber))));
  assert.equal((await handle(post(fx.owner, first - 5), e, deps(chain))).status, 201);
  await runScheduled(e, deps(chain));
  const f = JSON.parse(kv.data.get('w:' + fx.owner)!).figures;
  assert.equal(f.completedRoundTrips, 0);
  assert.ok(f.gardenAgeDays >= 0);
});

test('register: duplicates are idempotent, bad input is refused, the cap holds, the chain is checked', async () => {
  const kv = new FakeKV();
  const chain = fakeChain(raw.logs, gateMarket, HEAD);
  const e = env(kv, { MAX_WALLETS: '2' });
  assert.equal((await handle(post(WALLET, START), e, deps(chain))).status, 201);
  const again = await handle(post(WALLET, START + 5), e, deps(chain));
  assert.equal(again.status, 200);
  const j = (await again.json()) as { alreadyRegistered: boolean; startBlock: number };
  assert.deepEqual([j.alreadyRegistered, j.startBlock], [true, START], 'the first start block stands');
  assert.equal(JSON.parse(kv.data.get('index')!).length, 1);
  assert.equal((await handle(post('0x' + '1'.repeat(40), START), e, deps(chain))).status, 201);
  assert.equal((await handle(post('0x' + '2'.repeat(40), START), e, deps(chain))).status, 409, 'cap of 2 reached');
  assert.equal((await handle(post('0x' + '3'.repeat(40), HEAD + 1), e, deps(chain))).status, 400, 'future block');
  assert.equal((await handle(post('0x' + '3'.repeat(40), 111999999), e, deps(chain))).status, 400, 'before the market');
  assert.equal((await handle(post('nope', START), e, deps(chain))).status, 400);
  const down = fakeChain(raw.logs, gateMarket, HEAD);
  down.blockNumber = async () => { throw new Error('down'); };
  assert.equal((await handle(post('0x' + '4'.repeat(40), START), e, deps(down))).status, 503);
  assert.equal((await handle(req('/garden/' + '0x' + '9'.repeat(40)), e, deps(chain))).status, 404);
  assert.equal((await handle(req('/garden/not-an-address'), e, deps(chain))).status, 400);
  assert.equal((await handle(req('/elsewhere'), e, deps(chain))).status, 404);
});

test('CORS at the HTTP level: preflight, allowed origin, refused origin, no wildcard', async () => {
  const kv = new FakeKV();
  const chain = fakeChain(raw.logs, gateMarket, HEAD);
  const e = env(kv);
  const pre = await handle(req('/register', { method: 'OPTIONS', origin: ALLOWED_ORIGIN }), e, deps(chain));
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
  const local = await handle(req('/leaderboard', { origin: 'http://localhost:5173' }), e, deps(chain));
  assert.equal(local.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  const evil = await handle(post(WALLET, START, 'https://evil.example'), e, deps(chain));
  assert.equal(evil.status, 403);
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
  assert.equal(kv.data.size, 0, 'a refused origin writes nothing');
  const noOrigin = await handle(req('/leaderboard'), e, deps(chain));
  assert.equal(noOrigin.status, 200);
  assert.equal(noOrigin.headers.get('access-control-allow-origin'), null);
});

test('rate limit: a flood is answered with 429 and costs no RPC call', async () => {
  const kv = new FakeKV();
  const chain = fakeChain(raw.logs, gateMarket, HEAD);
  const limiters = { read: new Limiter(2), write: new Limiter(1) };
  const e = env(kv);
  const d = deps(chain, limiters);
  assert.equal((await handle(post(WALLET, START), e, d)).status, 201);
  const calls = chain.calls;
  const blocked = await handle(post('0x' + '1'.repeat(40), START), e, d);
  assert.equal(blocked.status, 429);
  assert.equal(chain.calls, calls);
  assert.equal((await handle(req('/leaderboard'), e, d)).status, 200);
  assert.equal((await handle(req('/leaderboard'), e, d)).status, 200);
  assert.equal((await handle(req('/leaderboard'), e, d)).status, 429);
});

test('POST bodies are size-limited', async () => {
  const kv = new FakeKV();
  const chain = fakeChain(raw.logs, gateMarket, HEAD);
  const r = await handle(req('/register', { method: 'POST', body: JSON.stringify({ address: WALLET, startBlock: START, pad: 'x'.repeat(2000) }), origin: ALLOWED_ORIGIN }), env(kv), deps(chain));
  assert.equal(r.status, 413);
});

test('a wide-window fast source gives the same figures; when it fails the run finishes on the public RPC', async () => {
  const slow = fakeChain(raw.logs, gateMarket, HEAD);
  const baseline = new FakeKV();
  const eBase = env(baseline, { MAX_RPC_CALLS_PER_RUN: '1000' });
  await handle(post(WALLET, START), eBase, deps(slow));
  await runScheduled(eBase, deps(slow));

  // Fast: 5,000-block windows (the 90-block assertion of fakeChain does not apply to it).
  const fastOf = (fail: boolean): Chain & { calls: number } => {
    const c = { ...fakeChain(raw.logs, gateMarket, HEAD), windowBlocks: 5000, calls: 0 } as Chain & { calls: number };
    c.getLogs = async (f: LogFilter) => {
      c.calls++;
      if (fail) throw new Error('hypersync down');
      return (raw.logs as RawLog[]).filter((l) => l.address.toLowerCase() === f.address && Number(BigInt(l.blockNumber)) >= f.fromBlock && Number(BigInt(l.blockNumber)) <= f.toBlock && f.topics[0].includes(l.topics[0]));
    };
    return c;
  };

  const kvFast = new FakeKV();
  const eFast = env(kvFast, { MAX_RPC_CALLS_PER_RUN: '1000' });
  const fast = fastOf(false);
  await handle(post(WALLET, START), eFast, deps(fast));
  await runScheduled(eFast, { ...deps(fast), fallbackChain: slow });
  assert.equal(JSON.parse(kvFast.data.get('s:' + WALLET)!).logs && Object.keys(JSON.parse(kvFast.data.get('s:' + WALLET)!).logs).length, Object.keys(JSON.parse(baseline.data.get('s:' + WALLET)!).logs).length);
  assert.ok(fast.calls <= 4, 'one or two wide windows instead of about 25');

  const kvDown = new FakeKV();
  const eDown = env(kvDown, { MAX_RPC_CALLS_PER_RUN: '1000' });
  const down = fastOf(true);
  await handle(post(WALLET, START), eDown, deps(down));
  const cron = await runScheduled(eDown, { ...deps(down), fallbackChain: slow });
  assert.deepEqual(cron.failed, {});
  assert.deepEqual(Object.keys(JSON.parse(kvDown.data.get('s:' + WALLET)!).logs).sort(), Object.keys(JSON.parse(baseline.data.get('s:' + WALLET)!).logs).sort());
});

test('a cron run never sends more fast-source queries than ENVIO_QUERIES_PER_RUN, and the cursor resumes next run', async () => {
  const kv = new FakeKV();
  const e = env(kv, { MAX_RPC_CALLS_PER_RUN: '1000', ENVIO_QUERIES_PER_RUN: '2' });
  const c = { ...fakeChain(raw.logs, gateMarket, HEAD), windowBlocks: 200, calls: 0 } as Chain & { calls: number };
  let queries = 0;
  c.getLogs = async (f: LogFilter) => {
    queries++;
    return (raw.logs as RawLog[]).filter((l) => l.address.toLowerCase() === f.address && Number(BigInt(l.blockNumber)) >= f.fromBlock && Number(BigInt(l.blockNumber)) <= f.toBlock && f.topics[0].includes(l.topics[0]));
  };
  await handle(post(WALLET, START), e, deps(c));
  await runScheduled(e, deps(c));
  assert.equal(queries, 2, 'one window: a market query and a MarginAccount query');
  const first = JSON.parse(kv.data.get('w:' + WALLET)!).nextBlock;
  assert.equal(first, START + 200);
  await runScheduled(e, deps(c));
  assert.equal(JSON.parse(kv.data.get('w:' + WALLET)!).nextBlock, START + 400);
});
