// The transaction engine against a fake wallet and a fake chain. Nothing is signed; the wallet only records requests.
import test from 'node:test';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { JsonRpc } from '../src/rpc.ts';
import { CHAIN, buildPreview, nextPlantAction, nextUnwindAction, planApprove, planCancel, planDeposit, planPlant, planWithdraw } from '../src/plant.ts';
import { connectWallet, liveOrderIds, marginSlot, readSnapshot, sendStep, simulatePreview, switchToMonad, verifyApprove, verifyCancel, verifyDeposit, verifyPlant, verifyWithdraw, type Env, type Hooks, type StepResult } from '../src/flow.ts';
import { parseUnits } from '../src/units.ts';
import { FakeChain, FakeWallet } from './helpers/fakechain.ts';

const USER = '0x39FdC1B554FCF0B7478E58ff671f3d0FEA64DA38';
const usdc = (s: string): bigint => parseUnits(s, 6);

function setup() {
  const chain = new FakeChain(USER);
  const wallet = new FakeWallet(chain, USER);
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

async function preview(ctx: Ctx, budget = '6', levels = 1) {
  const snap = await readSnapshot(ctx.env.rpc, USER);
  const p = buildPreview({ market: snap.market, book: snap.book, budget: usdc(budget), levels, placement: 'close' });
  assert.equal(p.ok, true, p.errors.join());
  return { p, bids: p.levels.map((l) => ({ price: l.price, flipPrice: l.flipPrice, size: l.size })) };
}
const confirmed = (r: StepResult) => {
  assert.equal(r.status, 'confirmed', JSON.stringify(r, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
  return r as Extract<StepResult, { status: 'confirmed' }>;
};

test('happy path: approve exact, deposit, plant, cancel, withdraw, each verified on chain and one pop-up each', async () => {
  const c = setup();
  const { p, bids } = await preview(c);
  const need = p.totalLocked;

  let snap = await readSnapshot(c.env.rpc, USER);
  assert.deepEqual(nextPlantAction({ lockedNeeded: need, ...snap, openOrders: 0 }), { type: 'approve', amount: need });
  const ap = confirmed(await sendStep(c.env, planApprove(USER, need), c.hooks()));
  assert.equal((await verifyApprove(c.env, need, ap)).ok, true);

  // "reload": a brand-new engine, no memory, only the chain
  const env2 = c.mk();
  snap = await readSnapshot(env2.rpc, USER);
  assert.deepEqual(nextPlantAction({ lockedNeeded: need, ...snap, openOrders: 0 }), { type: 'deposit', amount: need });
  const before = snap;
  const dep = confirmed(await sendStep(env2, planDeposit(USER, need), c.hooks()));
  const vd = await verifyDeposit(env2, before, need, dep);
  assert.equal(vd.ok, true, vd.problems.join());
  assert.equal(c.chain.allowance, 0n, 'the exact approval is fully used');

  snap = await readSnapshot(env2.rpc, USER);
  assert.deepEqual(nextPlantAction({ lockedNeeded: need, ...snap, openOrders: 0 }), { type: 'plant' });
  const pl = confirmed(await sendStep(env2, planPlant(USER, bids), c.hooks(), { bids }));
  const vp = await verifyPlant(env2, snap, bids, pl);
  assert.equal(vp.ok, true, vp.problems.join());
  assert.equal(vp.orderIds.length, 1);
  assert.equal(c.chain.marginUsdc, 0n);

  // a taker fills the bid; the flipped sell has a new id. Unwind cancels the live order only.
  const sell = c.chain.fillBid(vp.orderIds[0]);
  const live = await liveOrderIds(env2.rpc, USER, [...vp.orderIds, sell]);
  assert.deepEqual(live, [sell]);
  snap = await readSnapshot(env2.rpc, USER);
  const act = nextUnwindAction({ liveOrderIds: live, marginUsdc: snap.marginUsdc, marginMon: snap.marginMon });
  assert.equal(act.type, 'cancel');
  const ca = confirmed(await sendStep(env2, planCancel(USER, live), c.hooks()));
  assert.equal((await verifyCancel(env2, live, ca)).ok, true);

  snap = await readSnapshot(env2.rpc, USER);
  const act2 = nextUnwindAction({ liveOrderIds: [], marginUsdc: snap.marginUsdc, marginMon: snap.marginMon });
  assert.equal(act2.type, 'withdraw');
  const wd = confirmed(await sendStep(env2, planWithdraw(USER, (act2 as { tokens: string[] }).tokens), c.hooks()));
  const vw = await verifyWithdraw(env2, snap, (act2 as { tokens: string[] }).tokens, wd);
  assert.equal(vw.ok, true, vw.problems.join());
  assert.equal(nextUnwindAction({ liveOrderIds: [], marginUsdc: c.chain.marginUsdc, marginMon: c.chain.marginMon }).type, 'done');

  // exactly one announcement and one send per transaction, and nothing but those methods ever reached the wallet
  assert.deepEqual(c.announced, ['approve', 'deposit', 'plant', 'cancel', 'withdraw']);
  assert.equal(c.wallet.methods().filter((m) => m === 'eth_sendTransaction').length, 5);
  for (const m of c.wallet.methods()) assert.ok(['eth_chainId', 'eth_accounts', 'eth_sendTransaction'].includes(m), `unexpected wallet method ${m}`);
});

test('a user who rejects in the wallet: nothing is sent, nothing is retried', async () => {
  const c = setup();
  c.wallet.rejectNext = true;
  const r = await sendStep(c.env, planApprove(USER, usdc('6')), c.hooks());
  assert.equal(r.status, 'rejected');
  assert.equal(c.wallet.methods().filter((m) => m === 'eth_sendTransaction').length, 1, 'asked once, never again');
  assert.equal(c.chain.allowance, 0n);
});

test('a user who cancels at the statement never sees a wallet pop-up', async () => {
  const c = setup();
  const r = await sendStep(c.env, planApprove(USER, usdc('6')), c.hooks(false));
  assert.equal(r.status, 'declined');
  assert.equal(c.wallet.methods().includes('eth_sendTransaction'), false);
});

test('wrong chain: refuses before simulating or sending; switching works, also when the wallet does not know Monad', async () => {
  const c = setup();
  c.wallet.chainIdHex = '0x1';
  const r = await sendStep(c.env, planApprove(USER, usdc('6')), c.hooks());
  assert.equal(r.status, 'wrong-network');
  assert.equal(c.chain.calls.some((x) => x.method === 'eth_call'), false);
  assert.equal(c.wallet.methods().includes('eth_sendTransaction'), false);

  c.wallet.knowsMonad = false;
  const s = await switchToMonad(c.wallet);
  assert.equal(s.ok, true);
  assert.deepEqual(c.wallet.methods().filter((m) => m.startsWith('wallet_')), ['wallet_switchEthereumChain', 'wallet_addEthereumChain']);
  confirmed(await sendStep(c.env, planApprove(USER, usdc('6')), c.hooks()));

  const d = setup();
  d.wallet.chainIdHex = '0x38';
  d.wallet.switchRejected = true;
  const s2 = await switchToMonad(d.wallet);
  assert.equal(s2.ok, false);
  assert.match(s2.message, /declined/);
});

test('connect: a rejected connection is explained, an empty wallet too', async () => {
  const c = setup();
  assert.deepEqual(await connectWallet(c.wallet), { ok: true, account: USER });
  const bad = { request: async () => { throw Object.assign(new Error('User rejected the request.'), { code: 4001 }); } };
  const r = await connectWallet(bad);
  assert.equal(r.ok, false);
  assert.match((r as { message: string }).message, /declined/);
  assert.equal((await connectWallet({ request: async () => [] })).ok, false);
});

test('account switched in the wallet: refuses', async () => {
  const c = setup();
  c.wallet.accounts = ['0x1111111111111111111111111111111111111111'];
  assert.equal((await sendStep(c.env, planApprove(USER, usdc('6')), c.hooks())).status, 'wrong-account');
});

test('a failing simulation never opens the pop-up and says why in plain words', async () => {
  const c = setup();
  const { p, bids } = await preview(c);
  confirmed(await sendStep(c.env, planApprove(USER, p.totalLocked), c.hooks()));
  confirmed(await sendStep(c.env, planDeposit(USER, p.totalLocked), c.hooks()));
  c.chain.opts.failWith = 'SizeError';
  const before = c.wallet.methods().filter((m) => m === 'eth_sendTransaction').length;
  const r = await sendStep(c.env, planPlant(USER, bids), c.hooks(), { bids });
  assert.equal(r.status, 'simulation-failed');
  assert.match((r as { message: string }).message, /SizeError.*nothing was sent/);
  assert.equal(c.wallet.methods().filter((m) => m === 'eth_sendTransaction').length, before);
});

test('simulation from the user\'s own address catches missing allowance and missing margin', async () => {
  const c = setup();
  const d = await sendStep(c.env, planDeposit(USER, usdc('6')), c.hooks());
  assert.equal(d.status, 'simulation-failed');
  assert.match((d as { message: string }).message, /insufficient allowance/);
  const { bids } = await preview(c);
  const p = await sendStep(c.env, planPlant(USER, bids), c.hooks(), { bids });
  assert.equal(p.status, 'simulation-failed');
  assert.match((p as { message: string }).message, /InsufficientBalance/);
  assert.equal(c.wallet.methods().includes('eth_sendTransaction'), false);
});

test('the book moves: before the simulation, and again after the user read the statement', async () => {
  const c = setup();
  const { p, bids } = await preview(c);
  confirmed(await sendStep(c.env, planApprove(USER, p.totalLocked), c.hooks()));
  confirmed(await sendStep(c.env, planDeposit(USER, p.totalLocked), c.hooks()));
  // 1) the market drops under our bid before we start
  c.chain.bestAsk = bids[0].price;
  c.chain.bestBid = bids[0].price - 100n;
  const r1 = await sendStep(c.env, planPlant(USER, bids), c.hooks(), { bids });
  assert.equal(r1.status, 'book-moved');
  // 2) it drops while the user is reading the statement
  c.chain.bestAsk = bids[0].price + 500n;
  c.chain.bestBid = bids[0].price - 100n;
  const moving: Hooks = { announce: async () => { c.chain.bestAsk = bids[0].price; return true; } };
  const sends = c.wallet.methods().filter((m) => m === 'eth_sendTransaction').length;
  const r2 = await sendStep(c.env, planPlant(USER, bids), moving, { bids });
  assert.equal(r2.status, 'book-moved');
  assert.equal(c.wallet.methods().filter((m) => m === 'eth_sendTransaction').length, sends, 'no pop-up for a stale ladder');
});

test('a transaction that fails on chain is reported as failed, with its hash', async () => {
  const c = setup();
  const { p } = await preview(c);
  confirmed(await sendStep(c.env, planApprove(USER, p.totalLocked), c.hooks()));
  // the wallet balance vanishes between simulation and inclusion
  const hooks: Hooks = { announce: async () => { c.chain.walletUsdc = 0n; return true; } };
  const r = await sendStep(c.env, planDeposit(USER, p.totalLocked), hooks);
  assert.equal(r.status, 'failed');
  assert.match((r as { hash: string }).hash, /^0x[0-9a-f]{64}$/);
});

test('no receipt in time is "pending", not success', async () => {
  const c = setup();
  const env = { ...c.env, maxReceiptPolls: 3 };
  const orig = c.wallet.request.bind(c.wallet);
  c.wallet.request = async (a) => (a.method === 'eth_sendTransaction' ? '0x' + 'ab'.repeat(32) : orig(a));
  const r = await sendStep(env, planApprove(USER, usdc('6')), c.hooks());
  assert.equal(r.status, 'pending');
});

test('verification says "cannot explain" when the chain disagrees', async () => {
  // a deposit that credits one unit less than paid
  const c = setup();
  const { p } = await preview(c);
  confirmed(await sendStep(c.env, planApprove(USER, p.totalLocked), c.hooks()));
  c.chain.opts.shortDeposit = 1n;
  const before = await readSnapshot(c.env.rpc, USER);
  const dep = confirmed(await sendStep(c.env, planDeposit(USER, p.totalLocked), c.hooks()));
  const v = await verifyDeposit(c.env, before, p.totalLocked, dep);
  assert.equal(v.ok, false);
  assert.match(v.problems[0], /Cannot explain/);

  // a plant transaction with one missing creation event
  const d = setup();
  const pv = await preview(d, '12', 2);
  confirmed(await sendStep(d.env, planApprove(USER, pv.p.totalLocked), d.hooks()));
  confirmed(await sendStep(d.env, planDeposit(USER, pv.p.totalLocked), d.hooks()));
  const snap = await readSnapshot(d.env.rpc, USER);
  d.chain.opts.dropFlipEvent = true;
  const pl = confirmed(await sendStep(d.env, planPlant(USER, pv.bids), d.hooks(), { bids: pv.bids }));
  const vp = await verifyPlant(d.env, snap, pv.bids, pl);
  assert.equal(vp.ok, false);
  assert.match(vp.problems.join(' '), /1 of 2 orders were created/);
});

test('three levels are planted in one transaction and all three are verified', async () => {
  const c = setup();
  c.chain.walletUsdc = usdc('20');
  const pv = await preview(c, '15', 3);
  assert.equal(pv.bids.length, 3);
  confirmed(await sendStep(c.env, planApprove(USER, pv.p.totalLocked), c.hooks()));
  confirmed(await sendStep(c.env, planDeposit(USER, pv.p.totalLocked), c.hooks()));
  const snap = await readSnapshot(c.env.rpc, USER);
  const pl = confirmed(await sendStep(c.env, planPlant(USER, pv.bids), c.hooks(), { bids: pv.bids }));
  const v = await verifyPlant(c.env, snap, pv.bids, pl);
  assert.equal(v.ok, true, v.problems.join());
  assert.equal(v.orderIds.length, 3);
  assert.equal(CHAIN.chainId, 143);
});

test('the engine refuses a transaction from another account or one the guard rejects', async () => {
  const c = setup();
  const other = planApprove('0x1111111111111111111111111111111111111111', usdc('1'));
  assert.equal((await sendStep(c.env, other, c.hooks())).status, 'refused');
  const unlimited = { ...planApprove(USER, usdc('1')), data: planApprove(USER, usdc('1')).data.slice(0, 74) + 'f'.repeat(64) };
  assert.equal((await sendStep(c.env, unlimited, c.hooks())).status, 'refused');
  assert.equal(c.wallet.methods().includes('eth_sendTransaction'), false);
});

test('preview simulation: a throwaway sender with pretend funds; crossing bids and tiny sizes are rejected', async () => {
  const c = setup();
  const { bids } = await preview(c);
  assert.deepEqual(await simulatePreview(c.env.sim, bids), { ok: true });
  assert.deepEqual(await simulatePreview(c.env.sim, [{ ...bids[0], price: c.chain.bestAsk + 100n, flipPrice: c.chain.bestAsk + 300n }]), { ok: false, reason: 'ProvisionError' });
  assert.deepEqual(await simulatePreview(c.env.sim, [{ ...bids[0], size: 199n * 10n ** 10n }]), { ok: false, reason: 'SizeError' });
  const last = c.chain.calls.filter((x) => x.method === 'eth_call').at(-1)!;
  assert.notEqual((last.params[0] as { from: string }).from.toLowerCase(), USER.toLowerCase(), 'never simulated as the visitor');
  assert.equal(c.wallet.requests.length, 0, 'the preview never touches the wallet');
});

test('margin storage slot equals the formula in scripts/gate.cjs (checked with ethers)', () => {
  const { ethers } = createRequire(import.meta.url)('ethers');
  for (const [owner, token] of [[USER, CHAIN.usdc], ['0x1111111111111111111111111111111111111111', '0x0000000000000000000000000000000000000000']]) {
    const key = ethers.utils.keccak256(ethers.utils.solidityPack(['address', 'address'], [owner, token]));
    const expected = ethers.utils.keccak256(ethers.utils.concat([key, ethers.utils.hexZeroPad('0x01', 32)]));
    assert.equal(marginSlot(owner, token), expected);
  }
});
