// The garden on the web side, against the fake wallet and the fake chain: the view built from a scanned bundle, and the
// three actions (Prune, Harvest, Move) driven through the real engine. Nothing is signed; the wallet only records requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JsonRpc } from '../src/rpc.ts';
import { CHAIN, buildPreview, planApprove, planDeposit, planPlant, type PlannedTx } from '../src/plant.ts';
import { readSnapshot, sendStep, verifyPlant, type Env, type StepResult, type Verification } from '../src/flow.ts';
import { gardenSpan } from '../src/garden.ts';
import { fetchBundle, MAINNET } from '../web/src/pipeline.ts';
import { buildGardenView, ledgerOfBundle, type GardenView } from '../web/src/garden-view.ts';
import { makeGardenActions, type ActionCtx } from '../web/src/garden-actions.ts';
import { ageSecondsBetween, clearBlockTimes } from '../web/src/blocktimes.ts';
import { startLive } from '../web/src/garden-live.ts';
import { stageArt } from '../web/src/garden-art.ts';
import { FakeChain, FakeWallet } from './helpers/fakechain.ts';

const USER = '0x39FdC1B554FCF0B7478E58ff671f3d0FEA64DA38';

async function world(levels = 1, budget = 6_000_000n) {
  clearBlockTimes();
  const chain = new FakeChain(USER);
  const wallet = new FakeWallet(chain, USER);
  const f = chain.fetch as unknown as typeof fetch;
  const env: Env = { rpc: new JsonRpc('fake://rpc', { retries: 0, fetch: f }), sim: new JsonRpc('fake://rpc', { retries: 0, fetch: f }), wallet, account: USER, sleep: async () => {} };
  const hooks = { announce: async () => true };
  const snap = await readSnapshot(env.rpc, USER);
  const start = snap.block - 1;
  const p = buildPreview({ market: snap.market, book: snap.book, budget, levels, placement: 'close' });
  assert.equal(p.ok, true, p.errors.join());
  const bids = p.levels.map((l) => ({ price: l.price, flipPrice: l.flipPrice, size: l.size }));
  await sendStep(env, planApprove(USER, p.totalLocked), hooks);
  await sendStep(env, planDeposit(USER, p.totalLocked), hooks);
  const funded = await readSnapshot(env.rpc, USER);
  const r = (await sendStep(env, planPlant(USER, bids), hooks, { bids })) as Extract<StepResult, { status: 'confirmed' }>;
  const v = await verifyPlant(env, funded, bids, r);
  assert.equal(v.ok, true, v.problems.join());
  const view = async (): Promise<GardenView> => {
    const b = await fetchBundle({ account: USER, startBlock: start, cfg: { ...MAINNET, rpcUrl: 'fake://rpc', confirmations: 0 }, fetchImpl: f });
    const ledger = ledgerOfBundle(b);
    const span = gardenSpan(ledger, b.market.address);
    return buildGardenView(ledger, b.market, b.symbols, await ageSecondsBetween(env.rpc, span.firstBlock, span.lastBlock));
  };
  return { chain, wallet, env, hooks, ids: v.orderIds, view, snap };
}

test('plots grow with fills: seed, sprout, flower, fruit, and a cut stem after a prune', async () => {
  const w = await world();
  const [bid] = w.ids;
  let v = await w.view();
  assert.deepEqual(v.plots.map((p) => p.stage), ['seed']);
  assert.equal(v.plots[0].live.length, 1);
  assert.equal(v.plots[0].live[0].movable, true);

  const half = w.chain.orders.get(bid)!.size / 2n;
  const part = w.chain.fillOrder(bid, half);
  v = await w.view();
  assert.equal(v.plots[0].stage, 'sprout');
  assert.equal(v.plots[0].live.length, 2, 'the partly filled bid and the sell flipped out of the filled half');

  const rest = w.chain.fillOrder(bid);
  v = await w.view();
  assert.equal(v.plots[0].stage, 'flower');

  w.chain.fillOrder(part);
  w.chain.fillOrder(rest);
  v = await w.view();
  assert.equal(v.plots[0].stage, 'fruit');
  assert.equal(v.roundTrips, 1, "three fully filled legs make one completed pair");
  assert.equal(v.notSeenNote, '');
  assert.ok(v.achievements.find((a) => a.id === 'first-round-trip')!.earned);
});

test('garden age comes from block timestamps, not from an assumed block time', async () => {
  const w = await world();
  let v = await w.view();
  assert.equal(v.achievements.find((a) => a.id === 'seven-days')!.earned, false);
  assert.match(v.level.summary, /under a day old/);
  w.chain.ageBy(8 * 86_400);
  v = await w.view();
  assert.equal(v.achievements.find((a) => a.id === 'seven-days')!.earned, true);
  assert.match(v.level.summary, /8 days old/);
  assert.equal(v.level.name, 'Sprout');
  assert.equal(await ageSecondsBetween(w.env.rpc, null, 5), null);
  const broken = new JsonRpc('x://y', { retries: 0, fetch: (async () => ({ json: async () => ({ jsonrpc: '2.0', id: 1, error: { message: 'nope' } }) })) as unknown as typeof fetch });
  assert.equal(await ageSecondsBetween(broken, 1, 2), null, 'unreadable timestamps mean unknown, never a guess');
});

function ctxFor(w: Awaited<ReturnType<typeof world>>) {
  const log = { steps: [] as string[], seq: [] as string[], said: [] as string[], busy: false, kinds: [] as string[], added: [] as bigint[], finished: 0, texts: [] as string[] };
  const ctx: ActionCtx = {
    env: () => w.env,
    account: () => USER,
    isBusy: () => log.busy,
    setBusy: (b) => { log.busy = b; },
    step: async (tx: PlannedTx, text: string, opts) => { log.steps.push(tx.kind); log.texts.push(text); return sendStep(w.env, tx, w.hooks, opts); },
    stepFailed: (r) => r.status !== 'confirmed',
    report: (_w: string, _r, v: Verification) => v.ok,
    say: (h) => { log.said.push(h); },
    seq: (h) => { log.seq.push(h); },
    statement: (kind) => `statement:${kind}`,
    setStepKinds: (k) => { const b = log.kinds; log.kinds = k; return b as never; },
    addOrderIds: (ids) => { log.added.push(...ids); },
    finish: async () => { log.finished++; },
  };
  return { ctx, log, actions: makeGardenActions(ctx) };
}

test('Prune cancels exactly the chosen live orders, and refuses an order the chain does not show as live and yours', async () => {
  const w = await world(2, 12_000_000n);
  const [a, b] = w.ids;
  const { actions, log } = ctxFor(w);
  await actions.prune([String(a)]);
  assert.deepEqual(log.steps, ['cancel']);
  assert.equal(w.chain.orders.get(a)!.size, 0n);
  assert.ok(w.chain.orders.get(b)!.size > 0n, 'the other order is untouched');
  assert.equal(log.busy, false);
  assert.equal(log.finished, 1);

  // the same order again: it no longer rests, so nothing is built or sent
  const sent = w.wallet.requests.filter((r) => r.method === 'eth_sendTransaction').length;
  await actions.prune([String(a)]);
  assert.equal(w.wallet.requests.filter((r) => r.method === 'eth_sendTransaction').length, sent);
  assert.match(log.seq.at(-1)!, /not resting on the book for your account/);

  // an order that belongs to someone else (planted directly in the fake chain)
  w.chain.orders.set(9999n, { owner: '0x' + '12'.repeat(20), size: 5n, price: 100n, flip: 200n, isBuy: true });
  await actions.prune([String(9999n)]);
  assert.equal(w.wallet.requests.filter((r) => r.method === 'eth_sendTransaction').length, sent);
  assert.equal(w.chain.orders.get(9999n)!.size, 5n);
});

test('Harvest withdraws only what is free, says nothing when nothing is free, and uses the withdraw planner', async () => {
  const w = await world();
  const { actions, log } = ctxFor(w);
  await actions.harvest();
  assert.deepEqual(log.steps, [], 'all money is locked in the resting order, so there is nothing to harvest');
  assert.match(log.seq.at(-1)!, /Nothing to harvest/);

  await actions.prune([String(w.ids[0])]);
  const before = w.chain.walletUsdc;
  await actions.harvest();
  assert.deepEqual(log.steps, ['cancel', 'withdraw']);
  assert.ok(w.chain.walletUsdc > before);
  assert.equal(w.chain.marginUsdc, 0n);
  assert.match(log.texts.at(-1)!, /not a profit figure/);
});

test('Move prunes the bid, then plants a new one from a fresh book, in two separate confirmed steps', async () => {
  const w = await world();
  const [bid] = w.ids;
  const { actions, log } = ctxFor(w);
  const text = await actions.previewMove(String(bid), 'passive');
  assert.match(text, /Cancel #\d+ .*then plant \d+ MON at /);
  w.chain.bestBid += 400n; // the book moves between the preview and the click
  w.chain.bestAsk += 400n;
  await actions.move(String(bid), 'passive');
  assert.deepEqual(log.steps, ['cancel', 'plant']);
  assert.equal(w.chain.orders.get(bid)!.size, 0n);
  assert.equal(log.added.length, 1);
  const fresh = w.chain.orders.get(log.added[0])!;
  assert.equal(fresh.isBuy, true);
  assert.equal(fresh.price, w.chain.bestBid + 100n, 'one tick over the CURRENT best bid, not the one from the preview');
  assert.deepEqual(log.kinds, [], 'the step list is restored');
  assert.equal(log.busy, false);
  assert.equal(w.wallet.requests.filter((r) => r.method === 'eth_sendTransaction').length, 3 + 2);
});

test('Move stops after the prune when the second step is rejected, and says the money is free', async () => {
  const w = await world();
  const [bid] = w.ids;
  const { actions, log } = ctxFor(w);
  let n = 0;
  const realStep = w.hooks.announce;
  w.hooks.announce = async () => (++n === 1 ? realStep() : false); // the visitor cancels the second confirmation
  await actions.move(String(bid), 'close');
  assert.deepEqual(log.steps, ['cancel', 'plant']);
  assert.equal(w.chain.orders.get(bid)!.size, 0n);
  assert.equal(log.added.length, 0);
  assert.ok(w.chain.marginUsdc > 0n, 'the money is free at Kuru');
  assert.match(log.said.at(-1)!, /pruned/i);
});

test('Move refuses a sell, and a bid that left the book', async () => {
  const w = await world();
  const [bid] = w.ids;
  const sell = w.chain.fillOrder(bid);
  const { actions, log } = ctxFor(w);
  assert.match(await actions.previewMove(String(sell), 'close'), /Only a resting bid can be moved/);
  await actions.move(String(sell), 'close');
  await actions.move(String(bid), 'close');
  assert.deepEqual(log.steps, []);
  assert.equal(w.wallet.requests.filter((r) => r.method === 'eth_sendTransaction').length, 3);
});

test('actions do nothing while another action is running', async () => {
  const w = await world();
  const { actions, log } = ctxFor(w);
  log.busy = true;
  await actions.prune([String(w.ids[0])]);
  await actions.harvest();
  await actions.move(String(w.ids[0]), 'close');
  assert.deepEqual(log.steps, []);
});

test('every growth stage has a picture with a text label', () => {
  for (const s of ['seed', 'sprout', 'flower', 'fruit', 'pruned'] as const) assert.match(stageArt(s), /<svg class="ga"[^>]*role="img" aria-label="[^"]+"/);
});

test('live refresh: runs on a timer, pauses while hidden, never overlaps, catches up when visible again, and stops', async () => {
  const listeners = new Set<() => void>();
  const doc = { hidden: false, addEventListener: (_: string, f: () => void) => void listeners.add(f), removeEventListener: (_: string, f: () => void) => void listeners.delete(f) };
  let runs = 0;
  let release: (() => void) | undefined;
  let allow = true;
  const stop = startLive({
    everyMs: 20,
    doc: doc as never,
    canRun: () => allow,
    run: () => { runs++; return new Promise<void>((r) => { release = r; setTimeout(r, 5); }); },
  });
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  await wait(120);
  const whileVisible = runs;
  assert.ok(whileVisible >= 2, `ran ${whileVisible} times`);
  doc.hidden = true;
  await wait(40);
  const atHide = runs;
  await wait(100);
  assert.equal(runs, atHide, 'hidden tabs do not read the chain');
  doc.hidden = false;
  listeners.forEach((f) => f());
  await wait(10);
  assert.ok(runs > atHide, 'catches up when the tab is visible again');
  allow = false;
  await wait(40);
  const atPause = runs;
  await wait(100);
  assert.equal(runs, atPause, 'skips ticks while an action is running');
  allow = true;
  stop();
  const atStop = runs;
  await wait(100);
  assert.equal(runs, atStop);
  assert.equal(listeners.size, 0);
  release?.();
});
