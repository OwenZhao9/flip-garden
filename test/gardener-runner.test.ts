// Whole tending sessions against the fake chain and the fake wallet (nothing is signed; the wallet records requests and
// applies them to an in-memory chain), with the rules decider or a fake Jev that answers from a script.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JsonRpc } from '../src/rpc.ts';
import type { Env } from '../src/flow.ts';
import { Gardener, type GardenerDeps } from '../src/gardener/runner.ts';
import { Observer } from '../src/gardener/observe.ts';
import { defaultMandate, type Mandate } from '../src/gardener/mandate.ts';
import { rulesDecider, type Decider } from '../src/gardener/decide.ts';
import { POLICY, type Answer } from '../src/gardener/policy.ts';
import { FakeChain, FakeWallet } from './helpers/fakechain.ts';

const USER = '0x39FdC1B554FCF0B7478E58ff671f3d0FEA64DA38';
const MON = 10n ** 18n;

function setup(o: { mandate?: Partial<Mandate>; decider?: Decider; ask?: GardenerDeps['ask']; confirmTx?: GardenerDeps['confirmTx'] } = {}) {
  const chain = new FakeChain(USER);
  const wallet = new FakeWallet(chain, USER);
  const clock = { t: 1_800_000_000_000 };
  const now = () => clock.t;
  const env: Env = {
    rpc: new JsonRpc('fake://rpc', { retries: 0, fetch: chain.fetch as unknown as typeof fetch }),
    sim: new JsonRpc('fake://rpc', { retries: 0, fetch: chain.fetch as unknown as typeof fetch }),
    wallet, account: USER, sleep: async () => {},
  };
  const mandate: Mandate = { ...defaultMandate(USER, clock.t, { bestBid: chain.bestBid, bestAsk: chain.bestAsk }, 100n), ...o.mandate };
  const observer = new Observer(env, chain.block, { hedge: () => false, now });
  const asked: string[] = [];
  const g = new Gardener({
    mandate, decider: o.decider ?? rulesDecider, now,
    observe: () => observer.read(),
    exec: { env },
    ask: o.ask ?? (async (_q, _a, action) => (asked.push(action), false)),
    confirmTx: o.confirmTx ?? (async () => true),
  });
  const sends = () => wallet.requests.filter((r) => r.method === 'eth_sendTransaction').length;
  // advance time and the chain a little between checks (a check reads the head; a frozen head is a stop condition)
  const tick = async (ms = 5_000) => { clock.t += ms; chain.block += 10; await g.tick(); };
  return { chain, wallet, env, g, clock, sends, tick, asked, observer, mandate };
}

const plantBid = async (s: ReturnType<typeof setup>, price: bigint) => {
  s.chain.marginUsdc = 6_000_000n;
  s.chain.orders.set(4000n, { owner: USER.toLowerCase(), size: 234n * 10n ** 10n, price, flip: price + 2600n, isBuy: true });
  s.chain.marginUsdc -= (234n * price) / 100n; // what the bid locks (234 MON x price / 1e8, in raw USDC)
  s.observer.addIds([4000n]);
};

test('recover: free USDC and no bid -> the Gardener plants one bid one tick above the best bid, verified on chain', async () => {
  const s = setup();
  s.chain.marginUsdc = 5_998_884n; // the money a failed move left free
  await s.tick();
  assert.equal(s.sends(), 1);
  const live = [...s.chain.orders.values()].filter((x) => x.size > 0n);
  assert.equal(live.length, 1);
  assert.equal(live[0].price, s.chain.bestBid + 100n);
  assert.equal(live[0].size, 242n * 10n ** 10n, '5.998884 USDC buys 242 MON at 0.024761');
  const e = s.g.timeline[0];
  assert.equal(e.question, 'recover');
  assert.equal(e.choice, 'replant');
  assert.equal(e.source, 'rules');
  assert.equal(e.ok, true);
  assert.equal(e.txs.length, 1);
  assert.equal(e.txs[0].kind, 'plant');
  assert.match(e.txs[0].facts.join(' '), /locked USDC equals the preview/);
  assert.equal(s.g.spend.length, 1);
  // the next check sees the new bid (learned from its own event) and does nothing more
  await s.tick();
  assert.equal(s.sends(), 1);
  assert.equal(s.g.status, 'watching');
});

test('requote: a bid left behind by a rising market is cancelled and planted again near the market', async () => {
  const s = setup();
  await plantBid(s, 2_476_000n);
  s.chain.bestBid = 2_490_000n; // +0.57%: out of the 0.20% band
  s.chain.bestAsk = 2_490_500n;
  await s.tick();
  assert.equal(s.sends(), 2, 'cancel, then plant');
  assert.equal(s.chain.orders.get(4000n)!.size, 0n);
  const live = [...s.chain.orders.values()].filter((x) => x.size > 0n);
  assert.equal(live.length, 1);
  assert.equal(live[0].price, 2_490_100n);
  assert.equal(live[0].size, 240n * 10n ** 10n, 'what the freed 6 USDC buy at 0.024901 (the default 6 USDC budget)');
  assert.deepEqual(s.g.timeline[0].txs.map((t) => t.kind), ['cancel', 'plant']);
  assert.equal(s.g.timeline[0].ok, true);
  // a cool-down keeps it from churning on the next check even if the book moves again
  s.chain.bestBid = 2_500_000n;
  s.chain.bestAsk = 2_500_500n;
  await s.tick(1_000);
  assert.equal(s.sends(), 2);
});

test('a bid that would leave the price range is not re-placed; the rules keep it', async () => {
  const s = setup({ mandate: { priceMax: 2_480_000n } });
  await plantBid(s, 2_476_000n);
  s.chain.bestBid = 2_490_000n;
  s.chain.bestAsk = 2_490_500n;
  await s.tick();
  assert.equal(s.sends(), 0);
  assert.equal(s.g.timeline[0].choice, 'keep');
});

test('a plant that loses the race on chain is recorded as failed; three failures stop the Gardener', async () => {
  const s = setup();
  s.chain.marginUsdc = 6_000_000n;
  // the market moves between the last book check and inclusion (as on 2026-10-11): the bid crosses at inclusion
  const send = s.wallet.request.bind(s.wallet);
  s.wallet.request = async (a) => {
    if (a.method === 'eth_sendTransaction') { s.chain.bestAsk = s.chain.bestBid + 100n; }
    const r = await send(a);
    if (a.method === 'eth_sendTransaction') { s.chain.bestAsk = s.chain.bestBid + 500n; }
    return r;
  };
  await s.tick();
  assert.equal(s.sends(), 1);
  assert.equal(s.g.timeline[0].ok, false);
  assert.equal(s.g.timeline[0].txs[0].status, 'failed');
  assert.ok(BigInt(s.g.timeline[0].txs[0].feeWei) > 0n, 'a failed transaction still pays the gas limit');
  await s.tick(1_000);
  assert.equal(s.sends(), 1, 'backs off after a failure');
  await s.tick(POLICY.firstBackoffMs);
  assert.equal(s.sends(), 2);
  await s.tick(2 * POLICY.firstBackoffMs);
  assert.equal(s.sends(), 3);
  await s.tick(4 * POLICY.firstBackoffMs);
  assert.equal(s.g.status, 'stopped');
  assert.match(s.g.note, /3 transactions failed/);
  await s.tick(10 * 60_000);
  assert.equal(s.sends(), 3, 'nothing after the stop');
});

test('Stop halts everything at once, including a check that is waiting for the user', async () => {
  let release: (v: boolean) => void = () => {};
  const scripted: Decider = { name: 'jev', decide: async (qs) => qs.map(() => ({ choice: 'replant', confidence: 0.7, source: 'jev' }) as Answer) };
  const s = setup({ decider: scripted, ask: () => new Promise((r) => { release = r; }) });
  s.chain.marginUsdc = 6_000_000n;
  const running = s.tick();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.g.status, 'asking');
  s.g.stop();
  release(true); // the user presses "do it" after Stop: nothing may be sent
  await running;
  assert.equal(s.sends(), 0);
  assert.equal(s.g.status, 'stopped');
  await s.tick();
  assert.equal(s.sends(), 0);
});

test('confidence routing with a scripted Jev: high acts, middle asks (declined -> nothing; accepted -> the user confirms each transaction), low does nothing', async () => {
  const at = (c: number): Decider => ({ name: 'jev', decide: async (qs) => qs.map(() => ({ choice: 'replant', confidence: c, source: 'jev' }) as Answer) });
  const low = setup({ decider: at(0.4) });
  low.chain.marginUsdc = 6_000_000n;
  await low.tick();
  assert.equal(low.sends(), 0);
  assert.equal(low.g.timeline[0].route, 'skip');

  const mid = setup({ decider: at(0.7) });
  mid.chain.marginUsdc = 6_000_000n;
  await mid.tick();
  assert.equal(mid.sends(), 0);
  assert.equal(mid.asked.length, 1);
  assert.match(mid.g.timeline[0].outcome, /declined/);

  const confirmed: string[] = [];
  const yes = setup({ decider: at(0.7), ask: async () => true, confirmTx: async (a) => (confirmed.push(a.kind), true) });
  yes.chain.marginUsdc = 6_000_000n;
  await yes.tick();
  assert.deepEqual(confirmed, ['plant'], 'the transaction itself was confirmed by the user');
  assert.equal(yes.sends(), 1);

  const high = setup({ decider: at(0.9) });
  high.chain.marginUsdc = 6_000_000n;
  await high.tick();
  assert.equal(high.sends(), 1);
  assert.equal(high.g.timeline[0].route, 'act');
});

test('Jev unreachable: no answer, no transaction; the timeline says so once', async () => {
  const down: Decider = { name: 'jev', decide: async (qs) => qs.map(() => null) };
  const s = setup({ decider: down });
  s.chain.marginUsdc = 6_000_000n;
  await s.tick();
  await s.tick();
  assert.equal(s.sends(), 0);
  assert.equal(s.g.timeline.length, 1);
  assert.match(s.g.timeline[0].outcome, /No valid answer/);
});

test('refuel: the wallet runs low on MON and MON is free at Kuru -> it is withdrawn to the wallet', async () => {
  const s = setup();
  s.chain.walletMon = MON / 10n;
  s.chain.marginMon = 234n * MON;
  await s.tick();
  assert.equal(s.sends(), 1);
  assert.equal(s.chain.marginMon, 0n);
  assert.equal(s.g.timeline[0].question, 'refuel');
  assert.equal(s.g.timeline[0].ok, true);
});

test('harvest: idle money at Kuru is withdrawn after five minutes when the mandate allows it', async () => {
  const s = setup({ mandate: { actions: ['harvest'] } });
  s.chain.marginMon = 234n * MON;
  await s.tick();
  assert.equal(s.sends(), 0);
  await s.tick(POLICY.idleBeforeHarvestMs);
  assert.equal(s.sends(), 1);
  assert.equal(s.chain.marginMon, 0n);
  assert.deepEqual(s.g.timeline[0].txs.map((t) => t.kind), ['withdraw']);
});

test('the hourly fee budget is checked against the real gas before anything is sent', async () => {
  const s = setup({ mandate: { maxFeeWeiPerHour: 10n ** 15n } }); // 0.001 MON: below one transaction
  s.chain.marginUsdc = 6_000_000n;
  await s.tick();
  assert.equal(s.sends(), 0);
  assert.equal(s.g.status, 'waiting', 'the budget stop waits instead of acting');
});

test('expiry stops the Gardener', async () => {
  const s = setup();
  s.chain.marginUsdc = 6_000_000n;
  s.clock.t = s.mandate.expiresMs;
  await s.tick(0);
  assert.equal(s.g.status, 'stopped');
  assert.equal(s.sends(), 0);
});

test('the Gardener only ever asks the wallet for chain id, accounts and transactions to the allowed contracts', async () => {
  const s = setup();
  s.chain.marginUsdc = 5_998_884n;
  await s.tick();
  await plantBid(s, 2_400_000n);
  await s.tick(60_000);
  const methods = new Set(s.wallet.methods());
  assert.deepEqual([...methods].sort(), ['eth_accounts', 'eth_chainId', 'eth_sendTransaction']);
  for (const r of s.wallet.requests.filter((x) => x.method === 'eth_sendTransaction')) {
    const tx = r.params![0] as { to: string; value: string };
    assert.ok(['0x065c9d28e428a0db40191a54d33d5b7c71a9c394', '0x2a68ba1833cdf93fa9da1eebd7f46242ad8e90c5'].includes(tx.to.toLowerCase()));
    assert.equal(tx.value, '0x0');
  }
});

test('a re-place whose plant loses the race: the cancel stands, the failed plant is logged with its fee, and the money is planted again', async () => {
  const s = setup();
  await plantBid(s, 2_476_000n);
  s.chain.bestBid = 2_490_000n;
  s.chain.bestAsk = 2_490_500n;
  const send = s.wallet.request.bind(s.wallet);
  let n = 0;
  s.wallet.request = async (a) => {
    if (a.method === 'eth_sendTransaction' && ++n === 2) {
      const ask = s.chain.bestAsk;
      s.chain.bestAsk = s.chain.bestBid + 100n;
      try { return await send(a); } finally { s.chain.bestAsk = ask; }
    }
    return send(a);
  };
  await s.tick();
  const e = s.g.timeline[0];
  assert.equal(e.ok, false);
  assert.deepEqual(e.txs.map((t) => [t.kind, t.status]), [['cancel', 'confirmed'], ['plant', 'failed']]);
  assert.ok(BigInt(e.txs[1].feeWei) > 0n, 'the failed plant paid its gas limit');
  await s.tick();
  assert.equal(s.g.timeline[0].question, 'recover');
  assert.equal(s.g.timeline[0].ok, true);
});
