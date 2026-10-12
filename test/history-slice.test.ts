// GET /history on the Worker and the page's use of it, joined end to end with the real gate-test logs. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handle, type Deps } from '../server/src/app.ts';
import type { Chain, Env, KV } from '../server/src/types.ts';
import { ALLOWED_ORIGIN } from '../server/src/cors.ts';
import { newScanState, sync, type LogFilter } from '../src/scan.ts';
import type { RawLog } from '../src/events.ts';
import { prefetchHistory, MAINNET, type CacheEntry } from '../web/src/pipeline.ts';
import { raw, market as gateMarket, WALLET } from './helpers/gate.ts';

class FakeKV implements KV {
  data = new Map<string, string>();
  async get(k: string) { return this.data.get(k) ?? null; }
  async put(k: string, v: string) { this.data.set(k, v); }
  async delete(k: string) { this.data.delete(k); }
}
const START = 112209400;
const HEAD = 112211600;
const CFG = { ...MAINNET, market: raw.market, marginAccount: raw.marginAccount, historyUrl: 'https://lb.example' };

function chain(opts: { fail?: boolean; windowBlocks?: number } = {}): Chain & { calls: number } {
  const c = {
    calls: 0,
    windowBlocks: opts.windowBlocks,
    async blockNumber() { return HEAD; },
    async getLogs(f: LogFilter) {
      c.calls++;
      if (opts.fail) throw new Error('boom secret-text');
      return (raw.logs as RawLog[]).filter((l) => l.address.toLowerCase() === f.address && Number(BigInt(l.blockNumber)) >= f.fromBlock && Number(BigInt(l.blockNumber)) <= f.toBlock && f.topics[0].includes(l.topics[0]));
    },
    async marketParams() { return gateMarket; },
    async blockTimestamp(b: number) { return 1_800_000_000 + b; },
  };
  return c as Chain & { calls: number };
}
const env = (kv: KV): Env => ({ KV: kv, MARKET: raw.market, MARGIN_ACCOUNT: raw.marginAccount, MARKET_FIRST_BLOCK: '112000000', MAX_RPC_CALLS_PER_RUN: '40' });
const viaWorker = (c: Chain, kv = new FakeKV()): typeof fetch =>
  (async (url: string) => handle(new Request(url, { headers: { origin: ALLOWED_ORIGIN } }), env(kv), { chain: c, now: () => 0 } as Deps)) as unknown as typeof fetch;
const fresh = (): CacheEntry => ({ state: newScanState({ account: WALLET, markets: [raw.market], marginAccount: raw.marginAccount, startBlock: START }), approvals: {} });

test('the page reads the same logs through the Worker as it does from the RPC, in a few requests', async () => {
  const rpcOnly = fresh();
  await sync(rpcOnly.state, chain(), { confirmations: 2 });

  const c = chain({ windowBlocks: 5000 });
  const viaW = fresh();
  const steps: number[] = [];
  await prefetchHistory(viaW, CFG, WALLET, HEAD - 2, viaWorker(c), (b) => steps.push(b), () => {});
  assert.deepEqual(Object.keys(viaW.state.logs).sort(), Object.keys(rpcOnly.state.logs).sort());
  assert.deepEqual(viaW.state.logs, rpcOnly.state.logs);
  assert.ok(viaW.state.nextBlock > HEAD - 3, 'reached the safe head');
  assert.ok(steps.length >= 1 && steps.length <= 3, `${steps.length} slices`);
  assert.ok(c.calls <= 20, `${c.calls} chain calls`);
});

test('a Worker failure leaves the cursor where it was, so the RPC scan can take over', async () => {
  const e = fresh();
  await prefetchHistory(e, CFG, WALLET, HEAD - 2, viaWorker(chain({ fail: true })), () => {}, () => {});
  assert.equal(e.state.nextBlock, START);
  assert.deepEqual(e.state.logs, {});
  const odd = (async () => Response.json({ from: START, nextBlock: START + 10, logs: { x: { address: '0x1111111111111111111111111111111111111111', data: '0x', topics: [], transactionHash: '0xab' } }, approvals: {} })) as unknown as typeof fetch;
  await prefetchHistory(e, CFG, WALLET, HEAD - 2, odd, () => {}, () => {});
  assert.equal(e.state.nextBlock, START, 'logs from an unexpected contract are refused');
  const stuck = (async () => Response.json({ from: START, nextBlock: START, logs: {}, approvals: {} })) as unknown as typeof fetch;
  await prefetchHistory(e, CFG, WALLET, HEAD - 2, stuck, () => {}, () => {});
  assert.equal(e.state.nextBlock, START, 'no progress means stop');
});

test('GET /history validates its input and never echoes a chain error', async () => {
  const f = viaWorker(chain());
  const get = (p: string) => f(`https://lb.example${p}`) as unknown as Promise<Response>;
  assert.equal((await get(`/history/${WALLET}?from=${START}`)).status, 200);
  assert.equal((await get('/history/0x123?from=112209400')).status, 400);
  assert.equal((await get(`/history/${WALLET}?from=5`)).status, 400, 'older than the market');
  assert.equal((await get(`/history/${WALLET}`)).status, 400);
  assert.equal((await get(`/history/${WALLET}?from=-1`)).status, 400);
  const down = viaWorker(chain({ fail: true }));
  const r = (await down(`https://lb.example/history/${WALLET}?from=${START}`)) as unknown as Response;
  assert.equal(r.status, 503);
  assert.ok(!/secret-text/.test(await r.text()));
});
