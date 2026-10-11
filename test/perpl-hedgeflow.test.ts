// The hedge flow against a fake wallet and a fake Perpl chain. Nothing is signed or sent; the wallet only records
// requests and "sending" applies a transaction to in-memory state. Rules in the fake follow what was measured on the real
// exchange (docs/PERPL-ONCHAIN.md): extra collateral = (mark - fill) x lot, taker fee 345 per million, IOC orders that find
// nothing succeed and do nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JsonRpc } from '../src/rpc.ts';
import { sendStep, type Env, type Hooks, type StepResult } from '../src/flow.ts';
import { guardTx } from '../src/plant.ts';
import { PERPL } from '../src/perpl/guard.ts';
import {
  HEDGE, closeBound, nextCloseAction, nextOpenAction, openBound, perplTraceCheck, planHedge, planPerplApprove, planPerplClose, planPerplCreate, planPerplOpen, planPerplWithdraw,
  readHedgeContext, readPerplState, verifyPerplApprove, verifyPerplClose, verifyPerplCreate, verifyPerplOpen, verifyPerplWithdraw, type HedgeContext, type HedgePlan, type PerplState,
} from '../src/perpl/hedgeflow.ts';
import { FakeChain, FakeWallet } from './helpers/fakechain.ts';
import { FakePerplChain } from './helpers/fakeperpl.ts';

const USER = '0x39FdC1B554FCF0B7478E58ff671f3d0FEA64DA38';
const MON = 10n ** 18n;
type Confirmed = Extract<StepResult, { status: 'confirmed' }>;

function setup() {
  const chain = new FakePerplChain(USER);
  const wallet = new FakeWallet(chain as unknown as FakeChain, USER);
  const mk = (): Env => ({
    rpc: new JsonRpc('fake://rpc', { retries: 0, fetch: chain.fetch as unknown as typeof fetch }),
    sim: new JsonRpc('fake://rpc', { retries: 0, fetch: chain.fetch as unknown as typeof fetch }),
    wallet,
    account: USER,
    sleep: async () => {},
  });
  const announced: string[] = [];
  const hooks = (accept = true): Hooks => ({ announce: async (a) => (announced.push(a.kind), accept) });
  return { chain, wallet, env: mk(), mk, announced, hooks };
}
type Ctx = ReturnType<typeof setup>;

const okPlan = (p: HedgePlan): Extract<HedgePlan, { ok: true }> => {
  assert.equal(p.ok, true, p.ok ? '' : p.reason);
  return p as Extract<HedgePlan, { ok: true }>;
};
const confirmed = (r: StepResult): Confirmed => {
  assert.equal(r.status, 'confirmed', JSON.stringify(r, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
  return r as Confirmed;
};
const sends = (c: Ctx): number => c.wallet.methods().filter((m) => m === 'eth_sendTransaction').length;

async function planFor(c: Ctx, inventoryMon = 1000n, ratioBps = 5000n): Promise<{ ctx: HedgeContext; plan: Extract<HedgePlan, { ok: true }> }> {
  const ctx = await readHedgeContext(c.env.rpc);
  const st = await readPerplState(c.env.rpc, USER);
  return { ctx, plan: okPlan(planHedge({ inventoryRaw: inventoryMon * MON, ratioBps, ctx, freeCNS: st.account ? st.account.balanceCNS : null })) };
}

// approve -> create -> (state read) so the account exists with the plan's deposit
async function fundAccount(c: Ctx, plan: Extract<HedgePlan, { ok: true }>) {
  const s0 = await readPerplState(c.env.rpc, USER);
  const ap = confirmed(await sendStep(c.env, planPerplApprove(USER, plan.depositCNS), c.hooks()));
  assert.equal((await verifyPerplApprove(c.env, plan.depositCNS, ap)).ok, true);
  const s1 = await readPerplState(c.env.rpc, USER);
  const cr = confirmed(await sendStep(c.env, planPerplCreate(USER, plan.depositCNS, 10_000_000n), c.hooks(), { extraCheck: perplTraceCheck(c.env.sim, USER, { kind: 'create', amount: plan.depositCNS }) }));
  const v = await verifyPerplCreate(c.env, s1, plan.depositCNS, cr);
  assert.equal(v.ok, true, v.problems.join());
  return { s0, s1, v };
}

async function openHedge(c: Ctx, ctx: HedgeContext, plan: Extract<HedgePlan, { ok: true }>) {
  const before = await readPerplState(c.env.rpc, USER);
  const tx = planPerplOpen(USER, { lot: plan.lot, boundPNS: plan.boundPNS, lastExecutionBlock: BigInt(ctx.block) + HEDGE.deadlineBlocks });
  const r = await sendStep(c.env, tx, c.hooks(), { extraCheck: perplTraceCheck(c.env.sim, USER, { kind: 'open', accountId: before.account!.accountId, lot: plan.lot }) });
  return { before, r };
}

// ---------------------------------------------------------------- plan ---------------------------------------------------

test('plan: 50% of 1000 MON is a 500 MON short; margin at 2x, account deposit, liquidation, funding and cost are consistent', async () => {
  const c = setup();
  const { ctx, plan } = await planFor(c);
  assert.equal(plan.lot, 500n);
  assert.equal(plan.cappedBy, null);
  assert.equal(plan.refPricePNS, 25_250n);
  assert.equal(plan.notionalCNS, 12_625_000n); // 500 x 25,250 = 12.625 AUSD
  assert.equal(plan.margin.initialMarginCNS, 6_312_500n);
  assert.ok(plan.margin.requiredCNS > plan.margin.initialMarginCNS + plan.margin.entryFeeCNS);
  assert.equal(plan.depositCNS, 10_000_000n, 'the exchange minimum of 10 AUSD is the first deposit');
  assert.ok(plan.liquidationPNS > plan.refPricePNS && plan.liquidationPNS < 2n * plan.refPricePNS, 'a short is liquidated above its entry');
  assert.ok(plan.fundingPerDayCNS > 0n, 'at rate -4 a short pays');
  assert.ok(plan.roundTripCostCNS > 0n);
  assert.equal(plan.boundPNS, openBound(ctx));
  assert.equal(plan.boundPNS, 24_997n); // 25,250 x 99%
  assert.equal(closeBound(ctx), 25_546n); // 25,293 x 101% = 25,545.93, rounded up
});

test('plan: whole MON only, at least 1; caps by the 15 USD notional and by the free collateral; never rounds up into an over-hedge', async () => {
  const c = setup();
  const ctx = await readHedgeContext(c.env.rpc);
  assert.match((planHedge({ inventoryRaw: 1n * MON, ratioBps: 5000n, ctx, freeCNS: null }) as { reason: string }).reason, /below 1 MON/);
  assert.match((planHedge({ inventoryRaw: 0n, ratioBps: 5000n, ctx, freeCNS: null }) as { reason: string }).reason, /below 1 MON/);
  assert.equal(okPlan(planHedge({ inventoryRaw: 2n * MON, ratioBps: 5000n, ctx, freeCNS: null })).lot, 1n);
  assert.equal(okPlan(planHedge({ inventoryRaw: 3n * MON + 999n * 10n ** 15n, ratioBps: 5000n, ctx, freeCNS: null })).lot, 1n, '3.999 MON x 50% = 1.99 -> 1');
  // 100,000 MON x 100% would be 2,525 USD: capped to 15 USD of notional at the best bid
  const big = okPlan(planHedge({ inventoryRaw: 100_000n * MON, ratioBps: 10_000n, ctx, freeCNS: null }));
  assert.equal(big.lot, 594n); // floor(15,000,000 / 25,250)
  assert.equal(big.cappedBy, 'notional');
  assert.equal(big.requestedLot, 100_000n);
  assert.ok(big.notionalCNS <= PERPL.maxNotionalCNS);
  // a small free balance caps by margin
  const small = okPlan(planHedge({ inventoryRaw: 100_000n * MON, ratioBps: 10_000n, ctx, freeCNS: 4_000_000n }));
  assert.equal(small.cappedBy, 'margin');
  assert.ok(small.margin.requiredCNS <= 4_000_000n);
  assert.ok(small.lot < 594n && small.lot > 100n);
  assert.match((planHedge({ inventoryRaw: 1000n * MON, ratioBps: 5000n, ctx, freeCNS: 5n }) as { reason: string }).reason, /not enough to hedge even 1 MON/);
});

test('plan: refuses when the book is empty or crossed, when trading is halted, and when the minimum deposit exceeds the cap', async () => {
  const c = setup();
  const ctx = await readHedgeContext(c.env.rpc);
  const inv = 1000n * MON;
  assert.match((planHedge({ inventoryRaw: inv, ratioBps: 5000n, ctx: { ...ctx, bestBid: 0n }, freeCNS: null }) as { reason: string }).reason, /empty or crossed/);
  assert.match((planHedge({ inventoryRaw: inv, ratioBps: 5000n, ctx: { ...ctx, bestAsk: ctx.bestBid }, freeCNS: null }) as { reason: string }).reason, /empty or crossed/);
  assert.match((planHedge({ inventoryRaw: inv, ratioBps: 5000n, ctx: { ...ctx, halted: true }, freeCNS: null }) as { reason: string }).reason, /halted/);
  assert.match((planHedge({ inventoryRaw: inv, ratioBps: 5000n, ctx: { ...ctx, minOpenCNS: 16_000_000n }, freeCNS: null }) as { reason: string }).reason, /above this page's 15 AUSD cap/);
});

// ---------------------------------------------------------------- state machine ---------------------------------------------------

test('next action is derived from chain state only, so a reload resumes at the right step', async () => {
  const c = setup();
  const { ctx, plan } = await planFor(c);
  const act = async (): Promise<string> => {
    const env = c.mk(); // a brand-new engine each time: no memory but the chain
    const st = await readPerplState(env.rpc, USER);
    const p = okPlan(planHedge({ inventoryRaw: 1000n * MON, ratioBps: 5000n, ctx, freeCNS: st.account?.balanceCNS ?? null }));
    return nextOpenAction(st, p).type;
  };
  assert.equal(await act(), 'approve');
  confirmed(await sendStep(c.env, planPerplApprove(USER, plan.depositCNS), c.hooks()));
  assert.equal(await act(), 'create');
  confirmed(await sendStep(c.env, planPerplCreate(USER, plan.depositCNS), c.hooks()));
  assert.equal(await act(), 'open');
  const { r } = await openHedge(c, ctx, plan);
  confirmed(r);
  assert.equal(await act(), 'opened');
  const st = await readPerplState(c.env.rpc, USER);
  assert.equal(nextCloseAction(st).type, 'close');
});

test('next action: blocks on low gas MON, low AUSD, a long, positions elsewhere, a frozen account, too little free collateral', async () => {
  const c = setup();
  const { plan } = await planFor(c);
  const base: PerplState = { block: 1, walletAusd: 20_000_000n, walletMon: 2n * MON, allowance: 0n, account: null, position: null, otherPositions: [], restingOrders: 0 };
  assert.equal(nextOpenAction(base, plan).type, 'approve');
  assert.equal(nextOpenAction({ ...base, allowance: plan.depositCNS }, plan).type, 'create');
  assert.match((nextOpenAction({ ...base, walletMon: MON / 10n }, plan) as { reason: string }).reason, /network fees/);
  assert.match((nextOpenAction({ ...base, walletAusd: 1_000_000n }, plan) as { reason: string }).reason, /Passkey page/);
  const acct = { accountId: 7n, balanceCNS: 9_000_000n, lockedBalanceCNS: 0n, frozen: 0, address: USER, positionBanks: [0n, 0n, 0n, 0n] };
  assert.equal(nextOpenAction({ ...base, account: acct }, plan).type, 'open');
  assert.match((nextOpenAction({ ...base, account: { ...acct, frozen: 1 } }, plan) as { reason: string }).reason, /frozen/);
  assert.match((nextOpenAction({ ...base, account: { ...acct, balanceCNS: 1_000_000n } }, plan) as { reason: string }).reason, /Lower the hedge ratio/);
  assert.match((nextOpenAction({ ...base, account: acct, otherPositions: [3] }, plan) as { reason: string }).reason, /other markets/);
  assert.match((nextOpenAction({ ...base, account: acct, restingOrders: 2 }, plan) as { reason: string }).reason, /resting orders/);
  const pos = { accountId: 7n, positionType: 0, depositCNS: 1n, pricePNS: 1n, lotLNS: 5n, entryBlock: 1n, pnlCNS: 0n, deltaPnlCNS: 0n, premiumPnlCNS: 0n, priceResiduePNSQ16: 0n, markPricePNS: 1n, markPriceValid: true };
  assert.match((nextOpenAction({ ...base, account: acct, position: pos }, plan) as { reason: string }).reason, /long position/);
  assert.equal(nextOpenAction({ ...base, account: acct, position: { ...pos, positionType: 1 } }, plan).type, 'opened');
  assert.equal(nextCloseAction({ ...base, account: acct }).type, 'withdraw');
  assert.equal(nextCloseAction({ ...base, account: { ...acct, balanceCNS: 0n } }).type, 'done');
  assert.equal(nextCloseAction(base).type, 'done');
  assert.equal(nextCloseAction({ ...base, account: acct, position: pos }).type, 'blocked');
});

// ---------------------------------------------------------------- the full path ---------------------------------------------------

test('happy path: approve exact, create account, open a 2x short, close it, withdraw; one pop-up each, all verified on chain', async () => {
  const c = setup();
  const { ctx, plan } = await planFor(c);
  const { s1 } = await fundAccount(c, plan);
  assert.equal(c.chain.s.allowance, 0n, 'the exact approval is fully used');
  assert.equal(c.chain.acct!.balance, plan.depositCNS);

  const { before, r } = await openHedge(c, ctx, plan);
  const opened = confirmed(r);
  const v = await verifyPerplOpen(c.env, before, plan, opened);
  assert.equal(v.ok, true, v.problems.join());
  assert.equal(v.filledLot, 500n);
  assert.equal(v.entryPricePNS, 25_250n);
  assert.equal(v.depositCNS, 6_312_500n + 500n * (25_283n - 25_250n), 'notional / 2 plus (mark - fill) x lot');
  assert.equal(v.extraCollateralCNS, 16_500n);
  assert.equal(v.feeCNS, 4_356n); // ceil(12,625,000 x 345 / 1e6) = ceil(4,355.6)
  const st = await readPerplState(c.env.rpc, USER);
  assert.equal(st.position!.lotLNS, 500n);
  assert.equal(st.position!.positionType, 1);
  assert.equal(st.account!.balanceCNS, plan.depositCNS - v.depositCNS - v.feeCNS);

  // close
  const beforeClose = st;
  const cl = confirmed(await sendStep(c.env, planPerplClose(USER, { lot: 500n, boundPNS: closeBound(ctx), lastExecutionBlock: BigInt(ctx.block) + HEDGE.deadlineBlocks }), c.hooks(), {
    extraCheck: perplTraceCheck(c.env.sim, USER, { kind: 'close', accountId: st.account!.accountId, lot: 500n, positionLot: 500n }),
  }));
  const vc = await verifyPerplClose(c.env, beforeClose, { lot: 500n, boundPNS: closeBound(ctx) }, cl);
  assert.equal(vc.ok, true, vc.problems.join());
  assert.equal(vc.closedLot, 500n);
  assert.equal(vc.remainingLot, 0n);
  assert.equal(vc.pnlCNS, 500n * 25_250n - 500n * 25_293n, 'a short sold at the bid and bought at the ask loses the spread');
  assert.ok(vc.pnlCNS < 0n);
  assert.equal(nextCloseAction(await readPerplState(c.env.rpc, USER)).type, 'withdraw');

  // withdraw everything that is left
  const beforeW = await readPerplState(c.env.rpc, USER);
  const amount = beforeW.account!.balanceCNS;
  const w = confirmed(await sendStep(c.env, planPerplWithdraw(USER, amount), c.hooks(), { extraCheck: perplTraceCheck(c.env.sim, USER, { kind: 'withdraw', accountId: beforeW.account!.accountId, amount }) }));
  const vw = await verifyPerplWithdraw(c.env, beforeW, amount, w);
  assert.equal(vw.ok, true, vw.problems.join());
  assert.equal(nextCloseAction(await readPerplState(c.env.rpc, USER)).type, 'done');
  // the whole round trip costs the spread plus two fees, a few cents on a 12.6 USD hedge
  const spent = 20_000_000n - c.chain.s.walletAusd;
  assert.equal(spent, -vc.pnlCNS + v.feeCNS + vc.feeCNS);
  assert.ok(spent < 100_000n);
  assert.deepEqual(c.announced, ['perplApprove', 'perplCreate', 'perplOpen', 'perplClose', 'perplWithdraw']);
  assert.equal(sends(c), 5, 'exactly one wallet pop-up per transaction');
  assert.deepEqual(s1.account, null);
});

test('every request the wallet received was a guarded Perpl transaction or a read', async () => {
  const c = setup();
  const { ctx, plan } = await planFor(c);
  await fundAccount(c, plan);
  confirmed((await openHedge(c, ctx, plan)).r);
  const sent = c.wallet.requests.filter((r) => r.method === 'eth_sendTransaction').map((r) => (r.params as { from: string; to: string; data: string; value: string; gas: string }[])[0]);
  assert.equal(sent.length, 3);
  for (const tx of sent) {
    assert.equal(tx.value, '0x0');
    assert.ok([PERPL.ausd.toLowerCase(), PERPL.exchange.toLowerCase()].includes(tx.to.toLowerCase()));
    assert.ok(BigInt(tx.gas) >= 200_000n);
  }
  const allowed = new Set(['eth_requestAccounts', 'eth_accounts', 'eth_chainId', 'eth_sendTransaction']);
  assert.ok(c.wallet.methods().every((m) => allowed.has(m)), c.wallet.methods().join());
  void guardTx;
});

// ---------------------------------------------------------------- refusals and failures ---------------------------------------------------

test('wrong chain, changed account, user rejection and declining the announcement send nothing', async () => {
  const c = setup();
  const { ctx, plan } = await planFor(c);
  c.wallet.chainIdHex = '0x1';
  assert.equal((await sendStep(c.env, planPerplApprove(USER, plan.depositCNS), c.hooks())).status, 'wrong-network');
  c.wallet.chainIdHex = '0x8f';
  c.wallet.accounts = ['0x1111111111111111111111111111111111111111'];
  assert.equal((await sendStep(c.env, planPerplApprove(USER, plan.depositCNS), c.hooks())).status, 'wrong-account');
  c.wallet.accounts = [USER];
  assert.equal((await sendStep(c.env, planPerplApprove(USER, plan.depositCNS), c.hooks(false))).status, 'declined');
  c.wallet.rejectNext = true;
  assert.equal((await sendStep(c.env, planPerplApprove(USER, plan.depositCNS), c.hooks())).status, 'rejected');
  assert.equal(sends(c), 1, 'only the rejected request reached the wallet');
  assert.equal(c.chain.s.allowance, 0n);
  void ctx;
});

test('a transaction the guard refuses never reaches the wallet: unlimited approval, 3x leverage, a long, a 40 USD hedge', async () => {
  const c = setup();
  const bad = [
    planPerplApprove(USER, 2n ** 256n - 1n),
    planPerplOpen(USER, { lot: 5000n, boundPNS: 25_000n, lastExecutionBlock: 112_401_000n }),
    { ...planPerplOpen(USER, { lot: 100n, boundPNS: 25_000n, lastExecutionBlock: 112_401_000n }), to: PERPL.ausd },
    planPerplWithdraw(USER, 100_000_000n),
  ];
  for (const tx of bad) assert.equal((await sendStep(c.env, tx, c.hooks())).status, 'refused');
  assert.equal(sends(c), 0);
});

test('a failing simulation opens no pop-up, and says why', async () => {
  const c = setup();
  const { plan } = await planFor(c);
  c.chain.opts.failWith = 'InsufficentAmountToOpenAccount';
  const r = await sendStep(c.env, planPerplCreate(USER, plan.depositCNS), c.hooks());
  assert.equal(r.status, 'simulation-failed');
  assert.equal(sends(c), 0);
});

test('create without an approval fails in simulation (no pop-up); below the live minimum the guard refuses', async () => {
  const c = setup();
  const r = await sendStep(c.env, planPerplCreate(USER, 10_000_000n, 10_000_000n), c.hooks());
  assert.equal(r.status, 'simulation-failed');
  assert.equal((await sendStep(c.env, planPerplCreate(USER, 9_999_999n, 10_000_000n), c.hooks())).status, 'refused');
  assert.equal(sends(c), 0);
});

test('open when the bid side moved away before the simulation: the trace check refuses, no pop-up', async () => {
  const c = setup();
  const { ctx, plan } = await planFor(c);
  await fundAccount(c, plan);
  const sendsBefore = sends(c);
  c.chain.s.bids = [{ price: 24_000n, lot: 800n }]; // the whole bid side is far below the 1% bound
  const { r } = await openHedge(c, ctx, plan);
  assert.equal(r.status, 'simulation-failed');
  assert.match((r as { message: string }).message, /nothing would fill at the price bound/);
  assert.equal(sends(c), sendsBefore);
});

test('open when the book is too thin for the whole size: refused before the pop-up with the numbers', async () => {
  const c = setup();
  const { ctx, plan } = await planFor(c);
  await fundAccount(c, plan);
  c.chain.s.bids = [{ price: 25_250n, lot: 120n }, { price: 24_000n, lot: 9_000n }];
  const { r } = await openHedge(c, ctx, plan);
  assert.equal(r.status, 'simulation-failed');
  assert.match((r as { message: string }).message, /only 120 of 500 MON/);
});

test('the market moves after the simulation and nothing fills: the receipt is read honestly as "nothing filled", no position, no collateral moved', async () => {
  const c = setup();
  const { ctx, plan } = await planFor(c);
  await fundAccount(c, plan);
  c.chain.opts.liquidityAfterSim = 0n;
  const { before, r } = await openHedge(c, ctx, plan);
  const v = await verifyPerplOpen(c.env, before, plan, confirmed(r));
  assert.equal(v.ok, true, v.problems.join());
  assert.equal(v.filledLot, 0n);
  assert.match(v.facts.join(), /Nothing was filled/);
  const st = await readPerplState(c.env.rpc, USER);
  assert.equal(st.position, null);
  assert.equal(st.account!.balanceCNS, plan.depositCNS);
  assert.equal(nextOpenAction(st, plan).type, 'open', 'the same button simply works again');
});

test('a partial fill after the simulation is reported as partial, with the real size on chain', async () => {
  const c = setup();
  const { ctx, plan } = await planFor(c);
  await fundAccount(c, plan);
  c.chain.opts.liquidityAfterSim = 200n;
  const { before, r } = await openHedge(c, ctx, plan);
  const v = await verifyPerplOpen(c.env, before, plan, confirmed(r));
  assert.equal(v.ok, true, v.problems.join());
  assert.equal(v.filledLot, 200n);
  assert.match(v.facts.join(), /Partly filled: 200 of 500 MON/);
  const st = await readPerplState(c.env.rpc, USER);
  assert.equal(st.position!.lotLNS, 200n);
  assert.equal(nextOpenAction(st, plan).type, 'opened', 'a hedge exists; closing it stays available');
});

test('close: partial fill leaves a smaller short and says so; closing again finishes it', async () => {
  const c = setup();
  const { ctx, plan } = await planFor(c);
  await fundAccount(c, plan);
  confirmed((await openHedge(c, ctx, plan)).r);
  const closeTx = (lot: bigint) => planPerplClose(USER, { lot, boundPNS: closeBound(ctx), lastExecutionBlock: BigInt(ctx.block) + HEDGE.deadlineBlocks });
  let st = await readPerplState(c.env.rpc, USER);
  c.chain.opts.liquidityAfterSim = 300n;
  const r1 = confirmed(await sendStep(c.env, closeTx(500n), c.hooks(), { extraCheck: perplTraceCheck(c.env.sim, USER, { kind: 'close', accountId: st.account!.accountId, lot: 500n, positionLot: 500n }) }));
  const v1 = await verifyPerplClose(c.env, st, { lot: 500n, boundPNS: closeBound(ctx) }, r1);
  assert.equal(v1.ok, true, v1.problems.join());
  assert.equal(v1.closedLot, 300n);
  assert.equal(v1.remainingLot, 200n);
  assert.match(v1.facts.join(), /Partly closed: 300 MON bought back, 200 MON still short/);
  st = await readPerplState(c.env.rpc, USER);
  assert.equal(nextCloseAction(st).type, 'close');
  c.chain.opts.liquidityAfterSim = undefined;
  const r2 = confirmed(await sendStep(c.env, closeTx(200n), c.hooks()));
  const v2 = await verifyPerplClose(c.env, st, { lot: 200n, boundPNS: closeBound(ctx) }, r2);
  assert.equal(v2.ok, true, v2.problems.join());
  assert.equal(v2.remainingLot, 0n);
  assert.equal((await readPerplState(c.env.rpc, USER)).position, null);
});

test('close: funding is read from the events and shown with its sign', async () => {
  const c = setup();
  const { ctx, plan } = await planFor(c);
  await fundAccount(c, plan);
  confirmed((await openHedge(c, ctx, plan)).r);
  c.chain.opts.fundingOnClose = -77n; // the short paid 77 raw units of funding
  const st = await readPerplState(c.env.rpc, USER);
  const r = confirmed(await sendStep(c.env, planPerplClose(USER, { lot: 500n, boundPNS: closeBound(ctx), lastExecutionBlock: BigInt(ctx.block) + HEDGE.deadlineBlocks }), c.hooks()));
  const v = await verifyPerplClose(c.env, st, { lot: 500n, boundPNS: closeBound(ctx) }, r);
  assert.equal(v.ok, true, v.problems.join());
  assert.equal(v.fundingCNS, -77n);
  assert.match(v.facts.join(), /funding -0\.000077 AUSD \(negative = paid\)/);
});

test('"cannot explain": a missing fill event, collateral that differs from the event, or a changed balance stops the flow', async () => {
  for (const [opt, expect] of [
    [{ dropFillEvent: true }, /no position opening/],
    [{ skewDeposit: 5n }, /free collateral fell by/],
  ] as const) {
    const c = setup();
    const { ctx, plan } = await planFor(c);
    await fundAccount(c, plan);
    Object.assign(c.chain.opts, opt);
    const { before, r } = await openHedge(c, ctx, plan);
    const v = await verifyPerplOpen(c.env, before, plan, confirmed(r));
    assert.equal(v.ok, false);
    assert.match(v.problems.join(), expect);
    assert.match(v.problems[0], /^Cannot explain/);
  }
  // an account creation that credits less than deposited
  const c = setup();
  const { plan } = await planFor(c);
  const s0 = await readPerplState(c.env.rpc, USER);
  confirmed(await sendStep(c.env, planPerplApprove(USER, plan.depositCNS), c.hooks()));
  const cr = confirmed(await sendStep(c.env, planPerplCreate(USER, plan.depositCNS), c.hooks()));
  c.chain.acct!.balance -= 1n;
  const v = await verifyPerplCreate(c.env, s0, plan.depositCNS, cr);
  assert.equal(v.ok, false);
  assert.match(v.problems.join(), /account balance is/);
});

test('approve post-condition: a different allowance than approved is flagged', async () => {
  const c = setup();
  const { plan } = await planFor(c);
  const ap = confirmed(await sendStep(c.env, planPerplApprove(USER, plan.depositCNS), c.hooks()));
  c.chain.s.allowance += 1n;
  assert.equal((await verifyPerplApprove(c.env, plan.depositCNS, ap)).ok, false);
});

test('the transaction fails on chain (status 0): reported as failed, nothing is assumed', async () => {
  const c = setup();
  const { plan } = await planFor(c);
  confirmed(await sendStep(c.env, planPerplApprove(USER, plan.depositCNS), c.hooks()));
  const orig = c.chain.mine.bind(c.chain);
  c.chain.mine = (tx) => {
    c.chain.s.walletAusd = 0n; // the balance disappears between simulation and inclusion
    return orig(tx);
  };
  const r = await sendStep(c.env, planPerplCreate(USER, plan.depositCNS), c.hooks());
  assert.equal(r.status, 'failed');
});

// ---------------------------------------------------------------- the trace check on its own ---------------------------------------------------

test('trace check: tokens leaving the wallet during an order, a foreign account, a short that is not a short, a failed sub-call are all refused', async () => {
  const frames = (logs: unknown[], error?: string) => ({ call: async () => ({ error, logs, calls: [] }) }) as unknown as Env['sim'];
  const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const pad = (a: string) => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const w = (x: bigint | number) => BigInt(x).toString(16).padStart(64, '0');
  const { EVENT_TOPICS } = await import('../src/perpl/events.ts');
  const opened = (acct: number, type: number, lot: number) => ({ address: PERPL.exchange, topics: [EVENT_TOPICS.PositionOpenedV2], data: '0x' + [10, acct, type, 200, 1, 0, 25_000, lot, 0, 0, 0].map(w).join('') });
  const call = { from: USER, to: PERPL.exchange, data: '0x', value: '0x0' };
  const open = (sim: Env['sim']) => perplTraceCheck(sim, USER, { kind: 'open', accountId: 7n, lot: 100n })(call);
  assert.equal(await open(frames([opened(7, 1, 100)])), null);
  assert.match((await open(frames([opened(7, 1, 100), { address: PERPL.ausd, topics: [TRANSFER, pad(USER), pad(PERPL.exchange)], data: '0x' + w(1) }])))!, /move tokens out of your wallet/);
  assert.match((await open(frames([opened(8, 1, 100)])))!, /nothing would fill/);
  assert.match((await open(frames([opened(7, 0, 100)])))!, /something other than a short/);
  assert.match((await open(frames([opened(7, 1, 40)])))!, /only 40 of 100/);
  assert.match((await open(frames([], 'execution reverted')))!, /would fail/);
  const create = (sim: Env['sim'], amount: bigint) => perplTraceCheck(sim, USER, { kind: 'create', amount })(call);
  const created = { address: PERPL.exchange, topics: [EVENT_TOPICS.AccountCreated], data: '0x' + w(BigInt(USER)) + w(9) };
  const pay = (token: string, to: string, n: number) => ({ address: token, topics: [TRANSFER, pad(USER), pad(to)], data: '0x' + w(n) });
  assert.equal(await create(frames([created, pay(PERPL.ausd, PERPL.exchange, 10_000_000)]), 10_000_000n), null);
  assert.match((await create(frames([created, pay(PERPL.ausd, PERPL.exchange, 10_000_001)]), 10_000_000n))!, /instead of exactly/);
  assert.match((await create(frames([created, pay(PERPL.ausd, PERPL.exchange, 10_000_000), pay(PERPL.ausd, '0x2222222222222222222222222222222222222222', 1)]), 10_000_000n))!, /other transfer/);
  assert.match((await create(frames([pay(PERPL.ausd, PERPL.exchange, 10_000_000)]), 10_000_000n))!, /does not create an account/);
  assert.match((await perplTraceCheck({ call: async () => { throw new Error('boom'); } } as unknown as Env['sim'], USER, { kind: 'open', accountId: 7n, lot: 1n })(call))!, /could not be run/);
});

test('a reverting view (no account yet) is answered at once: the read adapter does not retry reverts', async () => {
  const c = setup();
  let n = 0;
  const rpc = new JsonRpc('fake://rpc', { retries: 6, fetch: (async (u: string, init: { body: string }) => (n++, c.chain.fetch(u, init))) as unknown as typeof fetch });
  const st = await readPerplState(rpc, USER);
  assert.equal(st.account, null);
  assert.ok(n <= 6, `${n} requests`);
});
