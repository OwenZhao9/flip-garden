// The Gardener's hedge actions through the executor, against the fake Perpl chain (no network, nothing signed): reduce an
// existing short with a reduce-only close, and open a short from an existing account's collateral within the AUSD budget.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JsonRpc } from '../src/rpc.ts';
import { sendStep, type Env } from '../src/flow.ts';
import { HEDGE, perplTraceCheck, planHedge, planPerplApprove, planPerplCreate, planPerplOpen, readHedgeContext, readPerplState } from '../src/perpl/hedgeflow.ts';
import { execute, type ExecCtx } from '../src/gardener/execute.ts';
import { defaultMandate, type Spend } from '../src/gardener/mandate.ts';
import type { Observation } from '../src/gardener/policy.ts';
import { NATIVE, type Market } from '../src/units.ts';
import { CHAIN } from '../src/plant.ts';
import { FakeChain, FakeWallet } from './helpers/fakechain.ts';
import { FakePerplChain } from './helpers/fakeperpl.ts';

const USER = '0x39FdC1B554FCF0B7478E58ff671f3d0FEA64DA38';
const MARKET: Market = {
  address: CHAIN.market.toLowerCase(), pricePrecision: 10n ** 8n, sizePrecision: 10n ** 10n, baseAsset: NATIVE, baseDecimals: 18, quoteAsset: CHAIN.usdc.toLowerCase(), quoteDecimals: 6,
  tickSize: 100n, minSize: 200n * 10n ** 10n, maxSize: 2n * 10n ** 18n, takerFeeBps: 0n, makerFeeBps: 0n,
};

function setup() {
  const chain = new FakePerplChain(USER);
  const wallet = new FakeWallet(chain as unknown as FakeChain, USER);
  const env: Env = {
    rpc: new JsonRpc('fake://rpc', { retries: 0, fetch: chain.fetch as unknown as typeof fetch }),
    sim: new JsonRpc('fake://rpc', { retries: 0, fetch: chain.fetch as unknown as typeof fetch }),
    wallet, account: USER, sleep: async () => {},
  };
  const spend: Spend = [];
  const mandate = { ...defaultMandate(USER, 0, { bestBid: 2_525_000n, bestAsk: 2_529_000n }, 100n), actions: ['hedge' as const], ausdBudget: 10_000_000n, expiresMs: Date.now() + 3_600_000 };
  const ctx: ExecCtx = { env, mandate, spend: () => spend, record: (e) => void spend.push(e), now: () => Date.now(), confirm: async () => true, stopped: () => false };
  const obs = (monHeld: bigint): Observation => ({
    block: 1, readAtMs: 0, market: MARKET, book: { bestBid: 2_525_000n, bestAsk: 2_529_000n }, mids: [], walletMon: 5n * 10n ** 18n, marginUsdc: 0n, marginMon: monHeld * 10n ** 18n, hedge: null, gasPriceWei: 10n ** 11n,
    orders: [],
  });
  const sends = () => wallet.methods().filter((m) => m === 'eth_sendTransaction').length;
  return { chain, env, ctx, spend, obs, sends };
}

// The owner's own steps (Hedge page): an account with 10 AUSD and, optionally, a short of `lot` MON.
async function prepare(s: ReturnType<typeof setup>, lot: bigint | null) {
  const yes = { announce: async () => true };
  await sendStep(s.env, planPerplApprove(USER, 10_000_000n), yes);
  await sendStep(s.env, planPerplCreate(USER, 10_000_000n, 1n), yes, { extraCheck: perplTraceCheck(s.env.sim, USER, { kind: 'create', amount: 10_000_000n }) });
  if (lot === null) return;
  const c = await readHedgeContext(s.env.rpc);
  const st = await readPerplState(s.env.rpc, USER);
  const plan = planHedge({ inventoryRaw: lot * 2n * 10n ** 18n, ratioBps: 5000n, ctx: c, freeCNS: st.account!.balanceCNS });
  assert.ok(plan.ok);
  await sendStep(s.env, planPerplOpen(USER, { lot: plan.lot, boundPNS: plan.boundPNS, lastExecutionBlock: BigInt(c.block) + HEDGE.deadlineBlocks }), yes, { extraCheck: perplTraceCheck(s.env.sim, USER, { kind: 'open', accountId: st.account!.accountId, lot: plan.lot }) });
  assert.equal((await readPerplState(s.env.rpc, USER)).position?.lotLNS, lot);
}

test('hedgeReduce: the short is bought back down by exactly the requested lot, verified against the receipt', async () => {
  const s = setup();
  await prepare(s, 300n);
  const before = s.sends();
  const out = await execute(s.ctx, { type: 'hedgeReduce', kind: 'hedge', lot: 200n }, s.obs(200n));
  assert.equal(out.ok, true, out.text);
  assert.equal(s.sends() - before, 1);
  assert.equal((await readPerplState(s.env.rpc, USER)).position?.lotLNS, 100n);
  assert.deepEqual(out.txs.map((t) => t.kind), ['perplClose']);
  assert.match(out.text, /Bought back 200 MON; 100 MON still short/);
  assert.equal(s.spend.length, 1);
});

test('hedgeReduce never buys back more than the open short', async () => {
  const s = setup();
  await prepare(s, 100n);
  const out = await execute(s.ctx, { type: 'hedgeReduce', kind: 'hedge', lot: 500n }, s.obs(0n));
  assert.equal(out.ok, true, out.text);
  assert.equal((await readPerplState(s.env.rpc, USER)).position, null);
});

test('hedgeOpen: from an existing account, within the AUSD budget; the Gardener never creates an account', async () => {
  const s = setup();
  const none = await execute(s.ctx, { type: 'hedgeOpen', kind: 'hedge', ratioBps: 5000n }, s.obs(400n));
  assert.equal(none.ok, false);
  assert.match(none.text, /never creates one/);
  assert.equal(s.sends(), 0);
  await prepare(s, null);
  const out = await execute(s.ctx, { type: 'hedgeOpen', kind: 'hedge', ratioBps: 5000n }, s.obs(400n));
  assert.equal(out.ok, true, out.text);
  assert.equal((await readPerplState(s.env.rpc, USER)).position?.lotLNS, 200n, 'half of 400 MON');
  const small = setup();
  small.ctx.mandate.ausdBudget = 100_000n; // 0.1 AUSD: the short is cut down to what that collateral carries
  await prepare(small, null);
  const capped = await execute(small.ctx, { type: 'hedgeOpen', kind: 'hedge', ratioBps: 5000n }, small.obs(400n));
  assert.equal(capped.ok, true, capped.text);
  const pos = (await readPerplState(small.env.rpc, USER)).position!;
  assert.ok(pos.lotLNS > 0n && pos.lotLNS < 200n);
  assert.ok(pos.depositCNS <= 100_000n, 'collateral within the budget');
  const tiny = setup();
  tiny.ctx.mandate.ausdBudget = 1_000n; // 0.001 AUSD: not even 1 MON
  await prepare(tiny, null);
  const refused = await execute(tiny.ctx, { type: 'hedgeOpen', kind: 'hedge', ratioBps: 5000n }, tiny.obs(400n));
  assert.equal(refused.ok, false);
  assert.equal((await readPerplState(tiny.env.rpc, USER)).position, null);
});
