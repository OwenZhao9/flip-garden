// USDC -> AUSD through Kuru Flow: the guard, quote checks, the safety trace, the engine and post-conditions.
// Everything runs against a real captured quote (test/fixtures/flow-quote-usdc-ausd.json) and fakes. Nothing signs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CHAIN, LIMITS, guardTx, planApprove, type PlannedTx } from '../src/plant.ts';
import { encodeApprove } from '../src/abi.ts';
import { JsonRpc } from '../src/rpc.ts';
import { sendStep, type Env } from '../src/flow.ts';
import { AUSD, FLOW_ROUTER, MIN_OUT_FLOOR_BPS, checkQuote, fetchSwapQuote, nextSwapAction, parseSwapAmount, planSwap, planSwapApprove, swapTraceCheck, verifySwap, type SwapQuote } from '../src/swap.ts';
import { decodeFlowSwap } from '../src/swapguard.ts';

const here = import.meta.dirname;
const cfg = JSON.parse(fs.readFileSync(path.join(here, '..', 'config', 'kuru.mainnet.json'), 'utf8'));
const fx = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'flow-quote-usdc-ausd.json'), 'utf8'));
const USER = '0x39FdC1B554FCF0B7478E58ff671f3d0FEA64DA38';
const FIVE = 5_000_000n;
const good = (): SwapQuote => {
  const r = checkQuote(structuredClone(fx), FIVE);
  assert.ok(r.ok, r.ok ? '' : r.message);
  return r.quote;
};
const w = (x: bigint): string => x.toString(16).padStart(64, '0');
const swapData = (o: { out?: string; minOut?: bigint; inn?: string; amount?: bigint }): string => {
  const base = fx.transaction.calldata as string;
  const words = base.slice(8).match(/.{64}/g)!;
  if (o.out) words[0] = o.out.slice(2).toLowerCase().padStart(64, '0');
  if (o.minOut !== undefined) words[1] = w(o.minOut);
  if (o.inn) words[2] = o.inn.slice(2).toLowerCase().padStart(64, '0');
  if (o.amount !== undefined) words[3] = w(o.amount);
  return '0x' + base.slice(0, 8) + words.join('');
};
const tx = (data: string, to: string = FLOW_ROUTER): PlannedTx => ({ kind: 'swap', from: USER, to, data, value: '0x0' });

test('the Flow router is not the order-book router in the config, and the pinned addresses are right', () => {
  assert.notEqual(FLOW_ROUTER.toLowerCase(), cfg.router.toLowerCase());
  assert.equal(fx.transaction.to, FLOW_ROUTER);
  assert.equal(AUSD, '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a');
});

test('the captured real quote decodes to USDC -> AUSD for exactly 5 USDC and passes the guard', () => {
  const c = decodeFlowSwap('0x' + fx.transaction.calldata)!;
  assert.equal(c.amountIn, FIVE);
  assert.equal(c.tokenIn.toLowerCase(), CHAIN.usdc.toLowerCase());
  assert.equal(c.tokenOut.toLowerCase(), AUSD.toLowerCase());
  assert.equal(c.minOut, BigInt(fx.minOut));
  assert.equal(guardTx(planSwap(USER, good())), null);
});

test('guard: wrong router, wrong tokens, over the cap, value, other selector and truncated data are refused', () => {
  const d = '0x' + fx.transaction.calldata;
  assert.match(guardTx(tx(d, CHAIN.marginAccount))!, /Flow router/);
  assert.match(guardTx(tx(d, cfg.router))!, /Flow router/);
  assert.match(guardTx(tx(swapData({ inn: AUSD })))!, /only USDC/);
  assert.match(guardTx(tx(swapData({ out: CHAIN.usdc })))!, /buy AUSD/);
  assert.match(guardTx(tx(swapData({ amount: LIMITS.maxDepositUsdc + 1n })))!, /cap/);
  assert.match(guardTx(tx(swapData({ amount: 0n })))!, /cap/);
  assert.match(guardTx(tx(swapData({ minOut: 0n })))!, /minimum/);
  assert.match(guardTx({ ...tx(d), value: '0x1' as '0x0' })!, /never sends MON/);
  assert.match(guardTx(tx('0x12345678' + d.slice(10)))!, /not the Kuru Flow swap/);
  assert.match(guardTx(tx(d.slice(0, 10 + 64 * 8)))!, /not the Kuru Flow swap/);
  assert.match(guardTx({ ...tx(d), kind: 'plant' })!, /./); // another kind cannot reuse swap data
});

test('guard: swap approvals go to the Flow router only, exact and capped; the old approve rule is unchanged', () => {
  assert.equal(guardTx(planSwapApprove(USER, FIVE)), null);
  assert.equal(guardTx(planApprove(USER, FIVE)), null);
  // a plain approve may not name the Flow router, and a swap approve may not name the margin account
  assert.match(guardTx({ kind: 'approve', from: USER, to: CHAIN.usdc, data: encodeApprove(FLOW_ROUTER, FIVE), value: '0x0' })!, /margin account/);
  assert.match(guardTx({ kind: 'swapApprove', from: USER, to: CHAIN.usdc, data: encodeApprove(CHAIN.marginAccount, FIVE), value: '0x0' })!, /Flow router/);
  assert.match(guardTx({ kind: 'swapApprove', from: USER, to: CHAIN.usdc, data: encodeApprove(FLOW_ROUTER, 2n ** 256n - 1n), value: '0x0' })!, /never unlimited/);
  assert.match(guardTx({ kind: 'swapApprove', from: USER, to: CHAIN.usdc, data: encodeApprove(FLOW_ROUTER, LIMITS.maxDepositUsdc + 1n), value: '0x0' })!, /never unlimited/);
  assert.match(guardTx({ kind: 'swapApprove', from: USER, to: AUSD, data: encodeApprove(FLOW_ROUTER, FIVE), value: '0x0' })!, /only allowed on USDC/);
  // a swap-approve step cannot carry a swap and vice versa
  assert.match(guardTx({ ...planSwap(USER, good()), kind: 'swapApprove' })!, /./);
  assert.match(guardTx({ ...planSwapApprove(USER, FIVE), kind: 'swap' })!, /./);
});

test('checkQuote refuses anything off: status, target, tokens, amount, minimum, price sanity, MON value', () => {
  const q = (f: (x: any) => void) => { const c = structuredClone(fx); f(c); return checkQuote(c, FIVE); };
  assert.ok(checkQuote(structuredClone(fx), FIVE).ok);
  assert.equal(q((c) => { c.status = 'error'; c.message = 'no route'; }).ok, false);
  assert.equal(q((c) => { c.transaction.to = CHAIN.marginAccount; }).ok, false);
  assert.equal(q((c) => { c.transaction.value = '1'; }).ok, false);
  assert.equal(q((c) => { c.transaction.calldata = '0x'; }).ok, false);
  assert.equal(checkQuote(structuredClone(fx), FIVE + 1n).ok, false); // quote is for another amount than asked
  assert.equal(q((c) => { c.output = 'x'; }).ok, false);
  assert.equal(q((c) => { c.output = '1'; }).ok, false); // minOut above output
  const cheap = swapData({ minOut: (FIVE * MIN_OUT_FLOOR_BPS) / 10000n - 1n });
  assert.match((q((c) => { c.transaction.calldata = cheap.slice(2); c.output = '4900000'; }) as any).message, /price looks off/);
});

test('fetchSwapQuote asks for a token, then the quote, with the user address and exact amounts', async () => {
  const seen: { url: string; body: any; auth?: string }[] = [];
  const f = async (url: string, init: any) => {
    seen.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
    return { ok: true, json: async () => (url.endsWith('generate-token') ? { token: 'T' } : structuredClone(fx)) };
  };
  const r = await fetchSwapQuote(f, USER, FIVE);
  assert.ok(r.ok);
  assert.deepEqual(seen.map((s) => s.url), ['https://ws.kuru.io/api/generate-token', 'https://ws.kuru.io/api/quote']);
  assert.deepEqual(seen[0].body, { user_address: USER });
  assert.equal(seen[1].auth, 'Bearer T');
  assert.deepEqual(seen[1].body, { userAddress: USER, tokenIn: CHAIN.usdc, tokenOut: AUSD, amount: '5000000', slippageTolerance: 50, autoSlippage: true });
  const down = await fetchSwapQuote(async () => { throw new Error('offline'); }, USER, FIVE);
  assert.equal(down.ok, false);
});

test('parseSwapAmount and nextSwapAction enforce the cap, gas reserve, balance and exact approvals', () => {
  assert.deepEqual(parseSwapAmount('5.25'), { ok: true, amount: 5_250_000n });
  assert.equal(parseSwapAmount('15.000001').ok, false);
  assert.equal(parseSwapAmount('0').ok, false);
  assert.equal(parseSwapAmount('abc').ok, false);
  const base = { amount: FIVE, walletUsdc: 20_000_000n, walletMon: 5n * 10n ** 18n, allowance: 0n };
  assert.deepEqual(nextSwapAction(base), { type: 'approve', amount: FIVE });
  assert.deepEqual(nextSwapAction({ ...base, allowance: FIVE }), { type: 'swap' });
  assert.equal(nextSwapAction({ ...base, walletMon: 1n }).type, 'blocked');
  assert.equal(nextSwapAction({ ...base, walletUsdc: 1n }).type, 'blocked');
  assert.equal(nextSwapAction({ ...base, amount: LIMITS.maxDepositUsdc + 1n }).type, 'blocked');
});

// --- the safety trace -------------------------------------------------------------------------------

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const pad = (a: string): string => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
const transfer = (token: string, from: string, to: string, amount: bigint) => ({ address: token.toLowerCase(), topics: [TRANSFER, pad(from), pad(to)], data: '0x' + w(amount) });
const traceOf = (logs: unknown[], error?: string) => ({ type: 'CALL', error, calls: [{ type: 'CALL', logs }] });
const simWith = (result: unknown | Error): JsonRpc => new JsonRpc('http://x', { retries: 0, fetch: (async (_u: string, init: { body: string }) => {
  const { id } = JSON.parse(init.body);
  return { json: async () => (result instanceof Error ? { id, error: { code: -32000, message: result.message } } : { id, result }) };
}) as never });
const call = { from: USER, to: FLOW_ROUTER, data: good().data, value: '0x0' };
const okLogs = (): unknown[] => [transfer(CHAIN.usdc, USER, FLOW_ROUTER, FIVE), transfer(AUSD, FLOW_ROUTER, USER, 4_990_000n), transfer(AUSD, '0x1111111111111111111111111111111111111111', FLOW_ROUTER, 4_990_000n)];

test('swap trace: accepts exactly-USDC-out and at-least-minOut-in', async () => {
  assert.equal(await swapTraceCheck(simWith(traceOf(okLogs())), USER, good())(call), null);
});

test('swap trace: refuses when output goes elsewhere, too little arrives, extra tokens leave, wrong amount, errors, or no trace', async () => {
  const run = (t: unknown | Error) => swapTraceCheck(simWith(t), USER, good())(call);
  assert.match((await run(traceOf([transfer(CHAIN.usdc, USER, FLOW_ROUTER, FIVE), transfer(AUSD, FLOW_ROUTER, '0x2222222222222222222222222222222222222222', 4_990_000n)])))!, /minimum AUSD/);
  assert.match((await run(traceOf([transfer(CHAIN.usdc, USER, FLOW_ROUTER, FIVE), transfer(AUSD, FLOW_ROUTER, USER, 1n)])))!, /minimum AUSD/);
  assert.match((await run(traceOf([...okLogs(), transfer('0x3333333333333333333333333333333333333333', USER, FLOW_ROUTER, 1n)])))!, /unexpected/);
  assert.match((await run(traceOf([...okLogs(), transfer(CHAIN.usdc, USER, '0x2222222222222222222222222222222222222222', 1n)])))!, /unexpected/);
  assert.match((await run(traceOf([transfer(CHAIN.usdc, USER, FLOW_ROUTER, FIVE - 1n), transfer(AUSD, FLOW_ROUTER, USER, 4_990_000n)])))!, /instead of exactly/);
  assert.match((await run(traceOf(okLogs(), 'execution reverted')))!, /would fail/);
  assert.match((await run(new Error('method not found')))!, /cannot be checked/);
});

// --- the engine and post-conditions -----------------------------------------------------------------

function engine(opts: { trace?: unknown; sendBalances?: { usdc: bigint; ausd: bigint } } = {}) {
  const state = { usdc: 20_000_000n, ausd: 0n, sent: [] as unknown[], calls: [] as string[] };
  const fetchFn = async (_u: string, init: { body: string }) => {
    const { id, method, params } = JSON.parse(init.body);
    state.calls.push(method);
    const ok = (result: unknown) => ({ json: async () => ({ id, result }) });
    switch (method) {
      case 'eth_call': {
        const to = String(params[0].to).toLowerCase();
        if (params[0].data.startsWith('0x70a08231')) return ok('0x' + w(to === AUSD.toLowerCase() ? state.ausd : state.usdc));
        if (to === FLOW_ROUTER.toLowerCase()) return ok('0x');
        return ok('0x' + w(0n));
      }
      case 'eth_getBalance': return ok('0x' + w(5n * 10n ** 18n));
      case 'eth_estimateGas': return ok('0x30d40');
      case 'eth_gasPrice': return ok('0x174876e800');
      case 'eth_blockNumber': return ok('0x10');
      case 'debug_traceCall': return ok(opts.trace ?? traceOf(okLogs()));
      case 'eth_getTransactionReceipt': {
        state.usdc = opts.sendBalances?.usdc ?? state.usdc - FIVE;
        state.ausd = opts.sendBalances?.ausd ?? 4_990_000n;
        return ok({ status: '0x1', blockNumber: '0x11', gasUsed: '0x30d40', effectiveGasPrice: '0x174876e800', logs: [] });
      }
      default: return ok(null);
    }
  };
  const wallet = {
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      if (method === 'eth_chainId') return '0x8f';
      if (method === 'eth_accounts') return [USER];
      if (method === 'eth_sendTransaction') { state.sent.push(params![0]); return '0x' + 'ab'.repeat(32); }
      throw new Error('unexpected ' + method);
    },
  };
  const env: Env = { rpc: new JsonRpc('http://x', { retries: 0, fetch: fetchFn as never }), sim: new JsonRpc('http://x', { retries: 0, fetch: fetchFn as never }), wallet, account: USER, sleep: async () => {}, maxReceiptPolls: 2 };
  return { env, state };
}
const yes = { announce: async () => true };

test('swap engine: simulate, trace, announce, ONE pop-up, then USDC down by exactly the amount and AUSD up by at least minOut', async () => {
  const { env, state } = engine();
  const q = good();
  const before = { walletUsdc: state.usdc, walletAusd: state.ausd };
  const r = await sendStep(env, planSwap(USER, q), yes, { extraCheck: swapTraceCheck(env.sim, USER, q) });
  assert.equal(r.status, 'confirmed');
  assert.equal(state.sent.length, 1);
  assert.ok(state.calls.includes('debug_traceCall'));
  assert.ok(state.calls.indexOf('debug_traceCall') < state.calls.indexOf('eth_estimateGas'));
  if (r.status !== 'confirmed') return;
  const v = await verifySwap(env, before, q, r);
  assert.equal(v.ok, true, v.problems.join());
  assert.equal(v.received, 4_990_000n);
});

test('swap engine: a failing trace stops before any pop-up; wrong balances after the receipt are "cannot explain"', async () => {
  const bad = engine({ trace: traceOf([transfer(CHAIN.usdc, USER, FLOW_ROUTER, FIVE)]) });
  const q = good();
  const r = await sendStep(bad.env, planSwap(USER, q), yes, { extraCheck: swapTraceCheck(bad.env.sim, USER, q) });
  assert.equal(r.status, 'simulation-failed');
  assert.equal(bad.state.sent.length, 0);

  const odd = engine({ sendBalances: { usdc: 20_000_000n - FIVE - 1n, ausd: 4_990_000n } });
  const before = { walletUsdc: odd.state.usdc, walletAusd: odd.state.ausd };
  const ok = await sendStep(odd.env, planSwap(USER, q), yes, { extraCheck: swapTraceCheck(odd.env.sim, USER, q) });
  assert.equal(ok.status, 'confirmed');
  if (ok.status === 'confirmed') {
    const v = await verifySwap(odd.env, before, q, ok);
    assert.equal(v.ok, false);
    assert.match(v.problems[0], /Cannot explain/);
  }
  const short = engine({ sendBalances: { usdc: 20_000_000n - FIVE, ausd: 10n } });
  const s = await sendStep(short.env, planSwap(USER, q), yes, { extraCheck: swapTraceCheck(short.env.sim, USER, q) });
  if (s.status === 'confirmed') assert.equal((await verifySwap(short.env, { walletUsdc: 20_000_000n, walletAusd: 0n }, q, s)).ok, false);
});

test('swap engine: the user declining the statement sends nothing', async () => {
  const { env, state } = engine();
  const q = good();
  const r = await sendStep(env, planSwap(USER, q), { announce: async () => false }, { extraCheck: swapTraceCheck(env.sim, USER, q) });
  assert.equal(r.status, 'declined');
  assert.equal(state.sent.length, 0);
});
