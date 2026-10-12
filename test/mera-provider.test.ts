// The Mera passkey wallet (web/src/mera-provider.ts) with a STUB passkey: fixed bytes, no browser, no real key, no network.
// Covers: fixed address, differential signing against ethers, every lock trigger, nothing sensitive leaving memory,
// and the unchanged planting engine running through it against the fake chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { MeraProvider, ACCOUNT_PATH, type LockReason, type PasskeyCeremony } from '../web/src/mera-provider.ts';
import { JsonRpc } from '../src/rpc.ts';
import { CHAIN, buildPreview, planApprove, planCancel, planDeposit, planPlant, planWithdraw } from '../src/plant.ts';
import { readSnapshot, sendStep, verifyApprove, verifyCancel, verifyDeposit, verifyPlant, verifyWithdraw, connectWallet, type Env } from '../src/flow.ts';
import { parseUnits } from '../src/units.ts';
import { FakeChain } from './helpers/fakechain.ts';

const { ethers } = createRequire(import.meta.url)('ethers');
const PRF = (): Uint8Array => Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff); // fixed stub bytes, fresh copy each call
const stub = (): PasskeyCeremony & { calls: string[] } => {
  const calls: string[] = [];
  return { calls, create: async () => (calls.push('create'), PRF()), signIn: async () => (calls.push('signIn'), PRF()) };
};
const prfHex = '0x' + Buffer.from(PRF()).toString('hex');

// The expected key, derived with ethers (an independent implementation of BIP-39 and BIP-32) from the same bytes.
const node = ethers.utils.HDNode.fromMnemonic(ethers.utils.entropyToMnemonic(PRF())).derivePath(ACCOUNT_PATH);
const EXPECTED_ADDRESS: string = node.address;
const KEY: string = node.privateKey;

type Sent = { method: string; params: unknown[]; raw: string };
function net(over: Record<string, (p: unknown[]) => unknown> = {}) {
  const bodies: string[] = [];
  const sent: Sent[] = [];
  const fetchFn = async (_url: string, init: { body: string }) => {
    bodies.push(init.body);
    const { id, method, params } = JSON.parse(init.body);
    const table: Record<string, (p: unknown[]) => unknown> = {
      eth_getTransactionCount: () => '0x7',
      eth_gasPrice: () => '0x174876e800',
      eth_estimateGas: () => '0x30d40',
      eth_sendRawTransaction: (p) => (sent.push({ method, params, raw: p[0] as string }), ethers.utils.keccak256(p[0] as string)),
      ...over,
    };
    return { json: async () => ({ jsonrpc: '2.0', id, result: table[method]?.(params) }) };
  };
  return { fetch: fetchFn as unknown as typeof fetch, bodies, sent };
}

function make(opts: { idleMs?: number } = {}) {
  const ceremony = stub();
  const n = net();
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const events: { unlocked: boolean; reason?: LockReason }[] = [];
  const lifecycle = new EventTarget();
  const p = new MeraProvider({
    ceremony,
    rpcUrl: 'https://rpc.example',
    fetch: n.fetch,
    idleMs: opts.idleMs,
    setTimer: (fn, ms) => (timers.push({ fn, ms, live: true }), timers.length - 1),
    clearTimer: (h) => { timers[h as number].live = false; },
    lifecycle,
    onChange: (s) => events.push(s),
  });
  return { p, ceremony, n, timers, events, lifecycle };
}
const txReq = (to: string, data: string, gas = '0x30d40') => ({ method: 'eth_sendTransaction', params: [{ from: EXPECTED_ADDRESS, to, data, value: '0x0', gas }] });

test('a stub passkey gives a fixed address, the same one ethers derives from the same bytes', async () => {
  const { p, ceremony } = make();
  assert.deepEqual(await p.request({ method: 'eth_accounts' }), []);
  const [addr] = (await p.request({ method: 'eth_requestAccounts' })) as string[];
  assert.equal(addr, EXPECTED_ADDRESS);
  assert.deepEqual(ceremony.calls, ['signIn']);
  assert.deepEqual(await p.request({ method: 'eth_accounts' }), [addr]);
  p.dispose();
});

test('the address for the stub bytes is pinned (a change would mean the derivation changed)', async () => {
  const { p } = make();
  assert.equal(await p.unlock('create'), EXPECTED_ADDRESS);
  assert.equal(EXPECTED_ADDRESS, '0x9eBA8D5Dc196826B262d3882cbFA5B87E93Ef2A8');
  p.dispose();
});

test('the passkey bytes handed in are zeroed after the session is opened', async () => {
  const kept: Uint8Array[] = [];
  const p = new MeraProvider({ ceremony: { create: async () => { const b = PRF(); kept.push(b); return b; }, signIn: async () => { const b = PRF(); kept.push(b); return b; } }, rpcUrl: 'x', fetch: net().fetch });
  await p.unlock('signin');
  assert.ok(kept[0].every((b) => b === 0));
  p.dispose();
});

test('signed transactions equal what ethers signs for the same key and fields (differential, legacy, chain 143)', async () => {
  const wallet = new ethers.Wallet(KEY);
  let seed = 12345n;
  const rnd = (n: bigint): bigint => ((seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n)), (seed >> 20n) % n);
  for (let i = 0; i < 25; i++) {
    const nonce = rnd(1000n), gasPrice = 1n + rnd(10n ** 12n), gas = 21000n + rnd(3_000_000n);
    const to = '0x' + rnd(2n ** 160n).toString(16).padStart(40, '0');
    const data = '0x' + Array.from({ length: Number(rnd(200n)) }, () => rnd(256n).toString(16).padStart(2, '0')).join('');
    const n = net({ eth_getTransactionCount: () => '0x' + nonce.toString(16), eth_gasPrice: () => '0x' + gasPrice.toString(16) });
    const p = new MeraProvider({ ceremony: stub(), rpcUrl: 'x', fetch: n.fetch });
    await p.unlock('signin');
    await p.request({ method: 'eth_sendTransaction', params: [{ from: EXPECTED_ADDRESS, to, data, value: '0x0', gas: '0x' + gas.toString(16) }] });
    const mine = n.sent[0].raw;
    const theirs = await wallet.signTransaction({ chainId: 143, nonce: Number(nonce), gasPrice, gasLimit: gas, to, value: 0, data, type: 0 });
    assert.equal(mine, theirs, `case ${i}`);
    const parsed = ethers.utils.parseTransaction(mine);
    assert.equal(parsed.from, EXPECTED_ADDRESS);
    assert.equal(parsed.chainId, 143);
    p.dispose();
  }
});

test('every lock trigger ends the session: button, idle, page hide, dispose; signing afterwards fails', async () => {
  for (const trigger of ['button', 'idle', 'page-hide', 'dispose'] as const) {
    const { p, timers, events, lifecycle, n } = make({ idleMs: 300_000 });
    await p.unlock('signin');
    const account = (p as unknown as { account: { signTransaction(t: unknown): Promise<string> } }).account; // test-only peek
    assert.equal(timers.at(-1)!.ms, 300_000);
    if (trigger === 'button') p.lock('button');
    if (trigger === 'idle') timers.at(-1)!.fn();
    if (trigger === 'page-hide') lifecycle.dispatchEvent(new Event('pagehide'));
    if (trigger === 'dispose') p.dispose();
    assert.equal(p.unlocked, false, trigger);
    assert.equal(p.address, null);
    assert.deepEqual(await p.request({ method: 'eth_accounts' }), []);
    await assert.rejects(p.request(txReq(CHAIN.usdc, '0x')), (e: { code: number }) => e.code === 4100);
    assert.equal(n.sent.length, 0);
    // the underlying key is really gone, not just hidden
    await assert.rejects(account.signTransaction({ type: 'legacy', chainId: 143, nonce: 0, gasPrice: 1n, gas: 21000n, to: CHAIN.usdc, value: 0n, data: '0x' }), /SESSION_ENDED|ended/i);
    assert.equal(events.at(-1)!.unlocked, false);
    assert.equal(events.at(-1)!.reason, trigger === 'dispose' ? 'button' : trigger);
  }
});

test('activity restarts the idle clock; the old timer is cancelled', async () => {
  const { p, timers } = make();
  await p.unlock('signin');
  const first = timers.length - 1;
  await p.request(txReq(CHAIN.usdc, '0x'));
  assert.equal(timers[first].live, false);
  assert.equal(timers.at(-1)!.live, true);
  p.dispose();
});

test('keepAlive restarts the idle clock of an open session without signing, and never reopens a locked one', async () => {
  const { p, timers, n, events } = make();
  await p.unlock('signin');
  const first = timers.length - 1;
  p.keepAlive();
  assert.equal(timers[first].live, false);
  assert.equal(timers.at(-1)!.live, true);
  assert.equal(n.sent.length, 0, 'nothing signed or sent');
  p.lock('button');
  const count = timers.length;
  p.keepAlive();
  assert.equal(p.unlocked, false);
  assert.equal(timers.length, count, 'no timer for a locked session');
  assert.equal(events.at(-1)?.unlocked, false);
  p.dispose();
});

test('a lock in the middle of a send stops it before anything is broadcast', async () => {
  const ceremony = stub();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const n = net({ eth_gasPrice: () => '0x1' });
  const slow = (async (u: string, i: { body: string }) => { if (JSON.parse(i.body).method === 'eth_gasPrice') await gate; return n.fetch(u, i as never); }) as unknown as typeof fetch;
  const p = new MeraProvider({ ceremony, rpcUrl: 'x', fetch: slow });
  await p.unlock('signin');
  const pending = p.request(txReq(CHAIN.usdc, '0x'));
  p.lock('button');
  release();
  await assert.rejects(pending, (e: { code: number }) => e.code === 4100);
  assert.equal(n.sent.length, 0);
});

test('chain methods answer for Monad mainnet only; other accounts, chains and methods are refused', async () => {
  const { p } = make();
  assert.equal(await p.request({ method: 'eth_chainId' }), '0x8f');
  assert.equal(await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x8f' }] }), null);
  await assert.rejects(p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] }), (e: { code: number }) => e.code === 4902);
  await assert.rejects(p.request({ method: 'personal_sign', params: [] }), (e: { code: number }) => e.code === 4200);
  await p.unlock('signin');
  await assert.rejects(p.request({ method: 'eth_sendTransaction', params: [{ from: '0x1111111111111111111111111111111111111111', to: CHAIN.usdc, data: '0x', gas: '0x5208' }] }), (e: { code: number }) => e.code === 4100);
  await assert.rejects(p.request({ method: 'eth_sendTransaction', params: [{ from: EXPECTED_ADDRESS, data: '0x', gas: '0x5208' }] }), /destination/);
  await assert.rejects(p.request({ method: 'eth_sendTransaction', params: [{ from: EXPECTED_ADDRESS, to: CHAIN.usdc, data: '0xzz', gas: '0x5208' }] }), /hex/);
  p.dispose();
});

test('a cancelled or unsupported passkey gives a plain error and no session', async () => {
  const { MeraError } = await import('../web/node_modules/@category-labs/mera/dist/index.js');
  const mk = (code: 'PASSKEY_OPERATION_FAILED' | 'PRF_UNAVAILABLE') => new MeraProvider({ ceremony: { create: async () => { throw new MeraError(code, 'x'); }, signIn: async () => { throw new MeraError(code, 'x'); } }, rpcUrl: 'x', fetch: net().fetch });
  const a = mk('PASSKEY_OPERATION_FAILED');
  await assert.rejects(a.request({ method: 'eth_requestAccounts' }), (e: { code: number; message: string }) => e.code === 4001 && /cancelled/.test(e.message));
  const b = mk('PRF_UNAVAILABLE');
  await assert.rejects(b.request({ method: 'eth_requestAccounts' }), (e: { code: number; message: string }) => e.code === 4100 && /PRF/.test(e.message) && /nothing is stored/i.test(e.message));
  assert.equal(a.unlocked || b.unlocked, false);
  const r = await connectWallet(b);
  assert.equal(r.ok, false);
});

test('nothing sensitive reaches localStorage, sessionStorage, console or fetch; only JSON-RPC to the one RPC URL', async () => {
  const writes: string[] = [];
  const mkStore = () => new Proxy({}, { get: (_t, k) => (k === 'setItem' ? (a: string, b: string) => writes.push(a + '=' + b) : () => null), set: (_t, k, v) => (writes.push(String(k) + '=' + String(v)), true) });
  const g = globalThis as Record<string, unknown>;
  const saved = { l: g.localStorage, s: g.sessionStorage, idb: g.indexedDB };
  g.localStorage = mkStore();
  g.sessionStorage = mkStore();
  const logs: string[] = [];
  const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  for (const k of Object.keys(orig) as (keyof typeof orig)[]) console[k] = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
  const urls: string[] = [];
  try {
    const n = net();
    const f = (async (u: string, i: { body: string }) => (urls.push(u), n.fetch(u, i as never))) as unknown as typeof fetch;
    const p = new MeraProvider({ ceremony: stub(), rpcUrl: 'https://rpc.example', fetch: f });
    await p.unlock('create');
    await p.request(txReq(CHAIN.usdc, '0xa9059cbb'));
    p.lock('button');
    const secrets = [KEY.slice(2).toLowerCase(), prfHex.slice(2).toLowerCase(), Buffer.from(PRF()).toString('base64')];
    const hay = [...writes, ...logs, ...n.bodies].join('\n').toLowerCase();
    for (const s of secrets) assert.equal(hay.includes(s.toLowerCase()), false);
    assert.deepEqual(writes, []);
    assert.deepEqual([...new Set(urls)], ['https://rpc.example']);
    // the only state-changing request carries a signed transaction (a signature, not a key)
    assert.deepEqual(n.bodies.map((b) => JSON.parse(b).method).sort(), ['eth_gasPrice', 'eth_getTransactionCount', 'eth_sendRawTransaction']);
  } finally {
    Object.assign(console, orig);
    g.localStorage = saved.l;
    g.sessionStorage = saved.s;
    g.indexedDB = saved.idb;
  }
});

// --- the unchanged planting engine, through the Mera wallet, against the fake chain ----------------------------

test('approve, deposit, plant, cancel and withdraw run through the Mera wallet; each step signs exactly once and checks out', async () => {
  const chain = new FakeChain(EXPECTED_ADDRESS);
  let nonce = 0;
  const signed: { from: string; to: string; chainId: number; nonce: number; gasLimit: string }[] = [];
  const chainFetch = chain.fetch;
  const f = (async (u: string, init: { body: string }) => {
    const { id, method, params } = JSON.parse(init.body);
    if (method === 'eth_getTransactionCount') return { json: async () => ({ id, result: '0x' + nonce.toString(16) }) };
    if (method === 'eth_sendRawTransaction') {
      const t = ethers.utils.parseTransaction(params[0]);
      signed.push({ from: t.from, to: t.to, chainId: t.chainId, nonce: t.nonce, gasLimit: t.gasLimit.toHexString() });
      nonce++;
      const hash = chain.mine({ from: t.from, to: t.to, data: t.data, gas: t.gasLimit.toHexString() });
      return { json: async () => ({ id, result: hash }) };
    }
    return chainFetch(u, init);
  }) as unknown as typeof fetch;

  const p = new MeraProvider({ ceremony: stub(), rpcUrl: 'x', fetch: f });
  const conn = await connectWallet(p);
  assert.ok(conn.ok && conn.account === EXPECTED_ADDRESS);
  const env: Env = { rpc: new JsonRpc('x', { retries: 0, fetch: chain.fetch as never }), sim: new JsonRpc('x', { retries: 0, fetch: chain.fetch as never }), wallet: p, account: EXPECTED_ADDRESS, sleep: async () => {} };
  const hooks = { announce: async () => true };
  const ok = <T extends { status: string }>(r: T) => { assert.equal(r.status, 'confirmed', JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? String(v) : v))); return r as never as Extract<Awaited<ReturnType<typeof sendStep>>, { status: 'confirmed' }>; };

  const snap0 = await readSnapshot(env.rpc, EXPECTED_ADDRESS);
  const pv = buildPreview({ market: snap0.market, book: snap0.book, budget: parseUnits('6', 6), levels: 1, placement: 'close' });
  assert.ok(pv.ok);
  const bids = pv.levels.map((l) => ({ price: l.price, flipPrice: l.flipPrice, size: l.size }));
  const need = pv.totalLocked;

  assert.equal((await verifyApprove(env, need, ok(await sendStep(env, planApprove(EXPECTED_ADDRESS, need), hooks)))).ok, true);
  const before = await readSnapshot(env.rpc, EXPECTED_ADDRESS);
  assert.equal((await verifyDeposit(env, before, need, ok(await sendStep(env, planDeposit(EXPECTED_ADDRESS, need), hooks)))).ok, true);
  const b2 = await readSnapshot(env.rpc, EXPECTED_ADDRESS);
  const plant = ok(await sendStep(env, planPlant(EXPECTED_ADDRESS, bids), hooks, { bids }));
  const vp = await verifyPlant(env, b2, bids, plant);
  assert.equal(vp.ok, true, vp.problems.join());
  assert.equal((await verifyCancel(env, vp.orderIds, ok(await sendStep(env, planCancel(EXPECTED_ADDRESS, vp.orderIds), hooks)))).ok, true);
  const b3 = await readSnapshot(env.rpc, EXPECTED_ADDRESS);
  assert.equal((await verifyWithdraw(env, b3, [CHAIN.usdc], ok(await sendStep(env, planWithdraw(EXPECTED_ADDRESS, [CHAIN.usdc]), hooks)))).ok, true);

  assert.equal(signed.length, 5);
  assert.deepEqual(signed.map((s) => s.nonce), [0, 1, 2, 3, 4]);
  assert.ok(signed.every((s) => s.from === EXPECTED_ADDRESS && s.chainId === 143));
  assert.deepEqual(signed.map((s) => s.to.toLowerCase()), [CHAIN.usdc, CHAIN.marginAccount, CHAIN.market, CHAIN.market, CHAIN.marginAccount].map((x) => x.toLowerCase()));

  // after a lock the engine cannot send: the account check refuses before anything is signed
  p.lock('button');
  const after = await sendStep(env, planApprove(EXPECTED_ADDRESS, need), hooks);
  assert.equal(after.status, 'wrong-account');
  assert.equal(signed.length, 5);
});
