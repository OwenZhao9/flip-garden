// HyperSync log source: same ledger as the public RPC, pagination, fallback, and no token in errors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HyperSyncSource, HYPERSYNC_WINDOW_BLOCKS } from '../src/hypersync.ts';
import { newScanState, sync, eventsOf, type LogFilter, type LogSource } from '../src/scan.ts';
import { buildLedger } from '../src/ledger.ts';
import type { RawLog } from '../src/events.ts';
import { raw, market, txs, WALLET } from './helpers/gate.ts';

const HEAD = 112211505;
const num = (l: RawLog): number => Number(BigInt(l.blockNumber));

function rpcSource(): LogSource & { calls: LogFilter[] } {
  const calls: LogFilter[] = [];
  return {
    calls,
    async blockNumber() {
      return HEAD;
    },
    async getLogs(f) {
      calls.push(f);
      if (f.toBlock - f.fromBlock + 1 > 90) throw new Error('range too large');
      return (raw.logs as RawLog[]).filter((l) => l.address.toLowerCase() === f.address && num(l) >= f.fromBlock && num(l) <= f.toBlock && f.topics[0].includes(l.topics[0]));
    },
  };
}

// A fake HyperSync server over the same logs: to_block exclusive, at most `perPage` logs per response, next_block to continue.
function fakeHyperSync(perPage: number, opts: { fail?: boolean } = {}) {
  const seen: Array<{ url: string; auth: string | null; body?: any }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get('authorization');
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ url, auth, body });
    if (opts.fail) return new Response('secret-in-body', { status: 500 });
    if (path === '/height') return Response.json({ height: HEAD });
    const sel = body.logs[0];
    const hits = (raw.logs as RawLog[])
      .filter((l) => l.address.toLowerCase() === sel.address[0].toLowerCase() && num(l) >= body.from_block && num(l) < body.to_block && sel.topics[0].includes(l.topics[0]))
      .sort((a, b) => num(a) - num(b) || Number(BigInt(a.logIndex)) - Number(BigInt(b.logIndex)));
    // Like the real service, never split a block across two responses.
    let cut = Math.min(perPage, hits.length);
    while (cut < hits.length && num(hits[cut]) === num(hits[cut - 1])) cut++;
    const page = hits.slice(0, cut);
    const next = cut < hits.length ? num(hits[cut]) : body.to_block;
    const logs = page.map((l) => ({
      block_number: num(l),
      log_index: Number(BigInt(l.logIndex)),
      transaction_hash: l.transactionHash,
      address: '0x' + l.address.slice(2).toUpperCase(), // the service may answer with other casing than the node
      data: l.data,
      topic0: l.topics[0],
      topic1: l.topics[1] ?? null,
      topic2: l.topics[2] ?? null,
      topic3: l.topics[3] ?? null,
    }));
    return Response.json({ data: [{ logs }], next_block: next, archive_height: HEAD });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

const fresh = () => newScanState({ account: WALLET, markets: [raw.market], marginAccount: raw.marginAccount, startBlock: 112209400 });

test('HyperSync and the public RPC give the same ledger from the same fixture', async () => {
  const viaRpc = fresh();
  await sync(viaRpc, rpcSource(), { confirmations: 2 });
  const hs = fakeHyperSync(2);
  const viaHs = fresh();
  const src = new HyperSyncSource({ url: 'https://hs.test', token: 't', fallback: rpcSource(), fetch: hs.fetchImpl });
  await sync(viaHs, src, { confirmations: 2, maxBlocks: HYPERSYNC_WINDOW_BLOCKS });
  assert.deepEqual(viaHs.logs, viaRpc.logs);
  const a = buildLedger({ account: WALLET, markets: [market], events: eventsOf(viaRpc), txs });
  const b = buildLedger({ account: WALLET, markets: [market], events: eventsOf(viaHs), txs });
  assert.equal(JSON.stringify(b, (_k, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Map ? [...v] : v)), JSON.stringify(a, (_k, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Map ? [...v] : v)));
  assert.ok(hs.seen.every((r) => r.auth === 'Bearer t'));
});

test('one wide window replaces many 90-block windows and pages are followed', async () => {
  const hs = fakeHyperSync(1);
  const rpc = rpcSource();
  const src = new HyperSyncSource({ url: 'https://hs.test', fallback: rpc, fetch: hs.fetchImpl });
  const st = fresh();
  await sync(st, src, { confirmations: 2, maxBlocks: HYPERSYNC_WINDOW_BLOCKS });
  assert.equal(Object.keys(st.logs).length, raw.logs.length);
  assert.equal(rpc.calls.length, 0);
  assert.ok(hs.seen.filter((r) => r.body).length < 40); // the RPC path needs about 50 getLogs calls for this range
});

test('a HyperSync failure falls back to the public RPC in windows it accepts, and the error text carries no body', async () => {
  const hs = fakeHyperSync(2, { fail: true });
  const rpc = rpcSource();
  const sources: string[] = [];
  const src = new HyperSyncSource({ url: 'https://hs.test', token: 'secret-token', fallback: rpc, fetch: hs.fetchImpl, retries: 0, onSource: (s) => sources.push(s) });
  const st = fresh();
  await sync(st, src, { confirmations: 2, maxBlocks: HYPERSYNC_WINDOW_BLOCKS });
  assert.equal(Object.keys(st.logs).length, raw.logs.length);
  assert.ok(rpc.calls.length > 0 && rpc.calls.every((c) => c.toBlock - c.fromBlock + 1 <= 90));
  assert.ok(sources.includes('rpc') && !sources.includes('hypersync'));
  await assert.rejects(
    (async () => {
      const bad = new HyperSyncSource({ url: 'https://hs.test', token: 'secret-token', fallback: rpc, fetch: hs.fetchImpl, retries: 0 });
      return (bad as any).query({ address: raw.market, topics: [[]], fromBlock: 1, toBlock: 2 });
    })(),
    (e: Error) => !/secret/.test(e.message),
  );
});

test('a cursor that does not advance is an error, not a loop', async () => {
  const fetchImpl = (async () => Response.json({ data: [{ logs: [] }], next_block: 5 })) as unknown as typeof fetch;
  const src = new HyperSyncSource({ url: 'https://hs.test', fallback: rpcSource(), fetch: fetchImpl, retries: 0 });
  await assert.rejects((src as any).query({ address: raw.market, topics: [[]], fromBlock: 5, toBlock: 10 }), /did not advance/);
});
