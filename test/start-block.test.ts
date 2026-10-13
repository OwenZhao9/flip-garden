// Finding where a planting starts when the browser does not know it: GET /start on the Worker and the page's fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handle, type Deps } from '../server/src/app.ts';
import type { Chain, Env, KV } from '../server/src/types.ts';
import { ALLOWED_ORIGIN } from '../server/src/cors.ts';
import type { LogFilter } from '../src/scan.ts';
import { keccak256 } from '../src/keccak.ts';
import { findStartBlock, type NonceRpc } from '../web/src/start-block.ts';
import { raw, market as gateMarket } from './helpers/gate.ts';

class FakeKV implements KV {
  data = new Map<string, string>();
  async get(k: string) { return this.data.get(k) ?? null; }
  async put(k: string, v: string) { this.data.set(k, v); }
  async delete(k: string) { this.data.delete(k); }
}
const ME = '0x3c76e2389438e38475001b7a011bfb52603a194e';
const OTHER = '0x5e56e252589b2c0acd1e983ee75520c5eb71abad';
const APPROVAL = keccak256('Approval(address,address,uint256)');
const pad = (a: string): string => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const approval = (owner: string, spender: string, block: number) => ({ address: gateMarket.quoteAsset, topics: [APPROVAL, pad(owner), pad(spender)], data: '0x', blockNumber: '0x' + block.toString(16), transactionHash: '0x' + block.toString(16).padStart(64, '0'), logIndex: '0x0' });
const LOGS = [approval(ME, raw.marginAccount, 112941300), approval(ME, raw.marginAccount, 112990000), approval(ME, OTHER, 112900000), approval(OTHER, raw.marginAccount, 112800000)];

function chain(windowBlocks?: number): Chain & { filters: LogFilter[] } {
  const c = {
    filters: [] as LogFilter[],
    windowBlocks,
    async blockNumber() { return 113000000; },
    async getLogs(f: LogFilter) {
      c.filters.push(f);
      return LOGS.filter((l) => l.address.toLowerCase() === f.address && f.topics.every((alts, i) => alts === null || alts.includes(l.topics[i])) && Number(BigInt(l.blockNumber)) >= f.fromBlock && Number(BigInt(l.blockNumber)) <= f.toBlock);
    },
    async marketParams() { return gateMarket; },
    async blockTimestamp(b: number) { return b; },
  };
  return c as Chain & { filters: LogFilter[] };
}
const env: Env = { KV: new FakeKV(), MARKET: raw.market, MARGIN_ACCOUNT: raw.marginAccount, MARKET_FIRST_BLOCK: '110298080', MAX_RPC_CALLS_PER_RUN: '40' };
const get = (c: Chain, path: string) => handle(new Request('https://lb.example' + path, { headers: { origin: ALLOWED_ORIGIN } }), env, { chain: c, now: () => 0 } as Deps);

test('GET /start answers the block before the first USDC approval to the margin account, in one query', async () => {
  const c = chain(100_000);
  const r = await get(c, `/start/${ME}`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { startBlock: 112941299 });
  assert.equal(c.filters.length, 1);
  assert.equal(c.filters[0].fromBlock, 110298080);
  assert.deepEqual(await (await get(chain(100_000), '/start/0x000000000000000000000000000000000000dEaD')).json(), { startBlock: null });
  assert.equal((await get(chain(100_000), '/start/0x123')).status, 400);
});

test('GET /start refuses on the public RPC, where the search would take thousands of calls', async () => {
  const c = chain(undefined);
  assert.equal((await get(c, `/start/${ME}`)).status, 503);
  assert.equal(c.filters.length, 0);
});

function nonceRpc(firstTxBlock: number, oldest: number, head = 113000000): NonceRpc & { calls: number } {
  const r = {
    calls: 0,
    async call<T>(method: string, params: unknown[]): Promise<T> {
      r.calls++;
      if (method === 'eth_blockNumber') return ('0x' + head.toString(16)) as T;
      const b = params[1] === 'latest' ? head : Number(BigInt(params[1] as string));
      if (b < oldest) throw new Error('Block requested not found');
      return (b >= firstTxBlock ? '0x3' : '0x0') as T;
    },
  };
  return r;
}
const down = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;

test('the page takes the Worker answer, and falls back to bisecting the nonce over the state the node keeps', async () => {
  const worker = (async () => Response.json({ startBlock: 112941299 })) as unknown as typeof fetch;
  assert.equal(await findStartBlock({ account: ME, historyUrl: 'https://lb.example', rpc: nonceRpc(1, 0), fetch: worker }), 112941299);

  const rpc = nonceRpc(112941221, 110600000);
  assert.equal(await findStartBlock({ account: ME, historyUrl: 'https://lb.example', rpc, fetch: down }), 112941220);
  assert.ok(rpc.calls < 40, `${rpc.calls} calls`);

  // The first transaction is older than any state the node keeps: unknown, so the page asks.
  assert.equal(await findStartBlock({ account: ME, historyUrl: 'https://lb.example', rpc: nonceRpc(100, 110600000), fetch: down }), undefined);
  // Never sent anything, or the Worker says nothing was ever approved to Kuru: nothing to find.
  assert.equal(await findStartBlock({ account: ME, rpc: nonceRpc(200_000_000, 0), fetch: down }), undefined);
  const none = (async () => Response.json({ startBlock: null })) as unknown as typeof fetch;
  assert.equal(await findStartBlock({ account: ME, historyUrl: 'https://lb.example', rpc: nonceRpc(1, 0), fetch: none }), undefined);
  // A malformed Worker answer is not trusted.
  const odd = (async () => Response.json({ startBlock: 'x' })) as unknown as typeof fetch;
  assert.equal(await findStartBlock({ account: ME, historyUrl: 'https://lb.example', rpc: nonceRpc(112941221, 110600000), fetch: odd }), 112941220);
});
