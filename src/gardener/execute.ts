// Turns an intent into transactions. Every transaction goes through the same gate as a manual one: the planners in
// src/plant.ts and src/perpl/hedgeflow.ts, sendStep (guard, network and account check, book check, simulation from the
// user's address, gas estimate, announcement, ONE signature, receipt) and the existing post-conditions. The only
// difference is who answers the announcement: inside the mandate the Gardener answers it after checking the real gas
// against the hourly fee budget; for a choice it must ask about, the user answers it on the confirmation card.
import { liveOrderIds, readSnapshot, sendStep, verifyCancel, verifyPlant, verifyWithdraw, type Announcement, type Env, type StepResult, type Verification } from '../flow.ts';
import { CHAIN, planCancel, planPlant, planWithdraw, type PlannedTx } from '../plant.ts';
import { HEDGE, closeBound, nextOpenAction, perplTraceCheck, planHedge, planPerplClose, planPerplOpen, readHedgeContext, readPerplState, verifyPerplClose, verifyPerplOpen } from '../perpl/hedgeflow.ts';
import { NATIVE, quoteForSize } from '../units.ts';
import { hasRoom, type Mandate, type Spend, type SpendEvent } from './mandate.ts';
import { checkBid, gardenMon, passiveBid, replantSize, describe, type Intent, type Observation } from './policy.ts';
import { readOrder } from './observe.ts';

type Confirmed = Extract<StepResult, { status: 'confirmed' }>;
export type TxRecord = { kind: PlannedTx['kind']; status: StepResult['status']; hash?: string; feeWei: bigint; facts: string[]; problems: string[] };
export type Outcome = { ok: boolean; text: string; txs: TxRecord[]; newOrderIds: bigint[]; cannotExplain: boolean };

export type ExecCtx = {
  env: Env;
  mandate: Mandate;
  spend: () => Spend;
  record: (e: SpendEvent) => void;
  now: () => number;
  // Called once per transaction after simulation and gas estimate. Inside the mandate this resolves true at once; when the
  // user must be asked it shows the confirmation card. The fee budget is checked before it is called.
  confirm: (a: Announcement, text: string) => Promise<boolean>;
  status?: (msg: string) => void;
  stopped: () => boolean; // the Stop button: checked before every transaction
};

const lockedOf = (o: Observation, exceptId?: bigint): bigint => o.orders.filter((x) => x.isBuy && x.id !== exceptId).reduce((a, x) => a + quoteForSize(x.size, x.price, o.market, 'up').value, 0n);

export async function execute(ctx: ExecCtx, intent: Intent, obs: Observation): Promise<Outcome> {
  const txs: TxRecord[] = [];
  const newOrderIds: bigint[] = [];
  let halt = false; // a transaction without a receipt: nothing more until a person has looked
  const done = (ok: boolean, text: string, cannotExplain = false): Outcome => ({ ok, text, txs, newOrderIds, cannotExplain: cannotExplain || halt });
  const { env, mandate } = ctx;
  const account = env.account;

  // One transaction through sendStep. Returns the confirmed result or null (with the reason recorded).
  async function step(tx: PlannedTx, text: string, opts: Parameters<typeof sendStep>[3] = {}): Promise<Confirmed | null> {
    if (ctx.stopped()) {
      txs.push({ kind: tx.kind, status: 'declined', feeWei: 0n, facts: [], problems: ['Stopped before sending.'] });
      return null;
    }
    let announced: Announcement | null = null;
    const r = await sendStep(env, tx, {
      status: ctx.status,
      announce: async (a) => {
        announced = a;
        if (ctx.stopped()) return false;
        if (!hasRoom(mandate, ctx.spend(), ctx.now(), 1, a.gasMonWei)) return false; // the real gas, against the hourly budget
        return ctx.confirm(a, text);
      },
    }, opts);
    const a = announced as Announcement | null;
    if (r.status === 'confirmed') {
      ctx.record({ atMs: ctx.now(), kind: tx.kind, feeWei: r.gasPaidWei, ok: true });
      return r;
    }
    if (r.status === 'pending') halt = true;
    // Included but failed: Monad charges the gas limit.
    const fee = r.status === 'failed' && a ? a.gasMonWei : 0n;
    if ('hash' in r) ctx.record({ atMs: ctx.now(), kind: tx.kind, feeWei: fee, ok: r.status !== 'failed' });
    txs.push({ kind: tx.kind, status: r.status, hash: 'hash' in r ? r.hash : undefined, feeWei: fee, facts: [], problems: [r.message] });
    return null;
  }
  const verified = (kind: PlannedTx['kind'], r: Confirmed, v: Verification): boolean => {
    txs.push({ kind, status: 'confirmed', hash: r.hash, feeWei: r.gasPaidWei, facts: v.facts, problems: v.problems });
    return v.ok;
  };
  const lastProblem = (): string => txs[txs.length - 1]?.problems.join(' ') ?? '';

  // Plant one bid from a freshly read book, checked against the mandate right before it is offered.
  async function plantFresh(size: (o: Observation) => bigint, lockedOther: bigint): Promise<Outcome | null> {
    const snap = await readSnapshot(env.rpc, account);
    const view: Observation = { ...obs, book: snap.book, market: snap.market, marginUsdc: snap.marginUsdc };
    const sz = size(view);
    if (sz <= 0n) return done(false, 'Not enough free USDC at Kuru for a minimum order within the budget. Nothing was planted.');
    const bid = passiveBid(view, sz);
    const refusal = checkBid(bid, view, mandate, lockedOther);
    if (refusal) return done(false, `${refusal} Nothing was planted.`);
    const locked = quoteForSize(bid.size, bid.price, snap.market, 'up').value;
    if (snap.marginUsdc < locked) return done(false, 'The free USDC at Kuru does not cover the bid; the Gardener never deposits. Nothing was planted.');
    const r = await step(planPlant(account, [bid]), `Plant ${bid.size / snap.market.sizePrecision} MON at ${bid.price} (flip ${bid.flipPrice}).`, { bids: [bid] });
    if (!r) return done(false, `The bid was not placed: ${lastProblem()}`);
    const v = await verifyPlant(env, snap, [bid], r);
    newOrderIds.push(...v.orderIds);
    if (!verified('plant', r, v)) return done(false, 'Cannot explain the planting; the Gardener stops.', true);
    return null;
  }

  switch (intent.type) {
    case 'requote': {
      const live = await liveOrderIds(env.rpc, account, [intent.cancelId]);
      if (!live.includes(intent.cancelId)) return done(false, `Order #${intent.cancelId} is no longer resting for this account. Nothing was sent.`);
      const o = await readOrder(env.rpc, intent.cancelId);
      if (!o.isBuy) return done(false, 'Only a resting bid is re-placed. Nothing was sent.');
      const r1 = await step(planCancel(account, [intent.cancelId]), `Cancel #${intent.cancelId}.`);
      if (!r1) return done(false, `The cancel was not made: ${lastProblem()}`);
      if (!verified('cancel', r1, await verifyCancel(env, [intent.cancelId], r1))) return done(false, 'Cannot explain the cancel; the Gardener stops.', true);
      const fail = await plantFresh(() => o.size, lockedOf(obs, intent.cancelId));
      if (fail) return { ...fail, ok: false, text: `Cancelled #${intent.cancelId}; ${fail.text} The money is free at Kuru.` };
      return done(true, `Re-placed #${intent.cancelId} as #${newOrderIds.join(', #')}.`);
    }
    case 'prune': {
      const live = await liveOrderIds(env.rpc, account, intent.ids);
      if (!intent.ids.every((i) => live.includes(i))) return done(false, 'An order is no longer resting for this account. Nothing was sent.');
      const r = await step(planCancel(account, intent.ids), `Cancel ${intent.ids.map((i) => '#' + i).join(', ')}.`);
      if (!r) return done(false, `The cancel was not made: ${lastProblem()}`);
      if (!verified('cancel', r, await verifyCancel(env, intent.ids, r))) return done(false, 'Cannot explain the cancel; the Gardener stops.', true);
      return done(true, `Cancelled ${intent.ids.map((i) => '#' + i).join(', ')}.`);
    }
    case 'replant': {
      const fail = await plantFresh((v) => replantSize(v, mandate, passiveBid(v, v.market.minSize).price), lockedOf(obs));
      return fail ?? done(true, `Planted #${newOrderIds.join(', #')}.`);
    }
    case 'harvest':
    case 'refuel': {
      const snap = await readSnapshot(env.rpc, account);
      const want = intent.type === 'refuel' ? [NATIVE] : intent.tokens;
      const tokens = want.filter((t) => (t === NATIVE ? snap.marginMon > 0n : snap.marginUsdc > 0n)).map((t) => (t === NATIVE ? NATIVE : CHAIN.usdc));
      if (!tokens.length) return done(false, 'Nothing is free at Kuru any more. Nothing was sent.');
      const r = await step(planWithdraw(account, tokens), describe(intent));
      if (!r) return done(false, `The withdrawal was not made: ${lastProblem()}`);
      if (!verified('withdraw', r, await verifyWithdraw(env, snap, tokens, r))) return done(false, 'Cannot explain the withdrawal; the Gardener stops.', true);
      return done(true, intent.type === 'refuel' ? 'MON moved from Kuru to the wallet for network fees.' : 'Idle money moved from Kuru to the wallet.');
    }
    case 'hedgeReduce': {
      const st = await readPerplState(env.rpc, account);
      if (!st.account || !st.position || st.position.positionType !== 1) return done(false, 'No Perpl short is open any more. Nothing was sent.');
      const lot = intent.lot < st.position.lotLNS ? intent.lot : st.position.lotLNS;
      const c = await readHedgeContext(env.rpc);
      const bound = closeBound(c);
      const tx = planPerplClose(account, { lot, boundPNS: bound, lastExecutionBlock: BigInt(c.block) + HEDGE.deadlineBlocks });
      const r = await step(tx, `Buy back ${lot} MON of the short.`, { extraCheck: perplTraceCheck(env.sim, account, { kind: 'close', accountId: st.account.accountId, lot, positionLot: st.position.lotLNS }) });
      if (!r) return done(false, `The hedge was not reduced: ${lastProblem()}`);
      const v = await verifyPerplClose(env, st, { lot, boundPNS: bound }, r);
      if (!verified('perplClose', r, v)) return done(false, 'Cannot explain the hedge close; the Gardener stops.', true);
      return done(true, `Bought back ${v.closedLot} MON; ${v.remainingLot} MON still short.`);
    }
    case 'hedgeOpen': {
      const st = await readPerplState(env.rpc, account);
      if (!st.account) return done(false, 'There is no Perpl account; the Gardener never creates one. Open the first hedge on the Hedge page.');
      const c = await readHedgeContext(env.rpc);
      const free = st.account.balanceCNS < mandate.ausdBudget ? st.account.balanceCNS : mandate.ausdBudget;
      const plan = planHedge({ inventoryRaw: gardenMon(obs) * 10n ** 18n, ratioBps: intent.ratioBps, ctx: c, freeCNS: free });
      if (!plan.ok) return done(false, `No hedge: ${plan.reason}`);
      if (plan.depositCNS !== 0n || plan.margin.requiredCNS > mandate.ausdBudget) return done(false, 'The hedge would need more AUSD than the mandate allows. Nothing was sent.');
      const next = nextOpenAction(st, plan);
      if (next.type !== 'open') return done(false, next.type === 'blocked' ? next.reason : 'A hedge is already open. Nothing was sent.');
      const tx = planPerplOpen(account, { lot: plan.lot, boundPNS: plan.boundPNS, lastExecutionBlock: BigInt(c.block) + HEDGE.deadlineBlocks });
      const r = await step(tx, `Sell ${plan.lot} MON short on Perpl.`, { extraCheck: perplTraceCheck(env.sim, account, { kind: 'open', accountId: st.account.accountId, lot: plan.lot }) });
      if (!r) return done(false, `The hedge was not opened: ${lastProblem()}`);
      const v = await verifyPerplOpen(env, st, { lot: plan.lot, boundPNS: plan.boundPNS }, r);
      if (!verified('perplOpen', r, v)) return done(false, 'Cannot explain the hedge; the Gardener stops.', true);
      return done(true, `Sold ${v.filledLot} MON short.`);
    }
  }
}
