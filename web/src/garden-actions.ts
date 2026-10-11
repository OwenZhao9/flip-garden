// Per-plot actions: Prune, Harvest and Move. They add no transaction kind and no shortcut: each one is built from the
// same planners, the same guard (guardTx runs inside sendStep) and the same one-at-a-time executor as planting and
// unwinding, so every transaction is simulated from the visitor's own address, announced in plain words, confirmed by
// the visitor and then verified against the chain. Only orders the chain says belong to the connected account and
// still rest on the book can be selected: ownership is re-checked from the chain right before anything is built.
import { liveOrderIds, readSnapshot, verifyCancel, verifyPlant, verifyWithdraw, type Env, type StepResult, type Verification } from '../../src/flow.ts';
import { CHAIN, USDC_DECIMALS, buildPreview, nextPlantAction, planCancel, planPlant, planWithdraw, type Placement, type PlannedTx, type Preview } from '../../src/plant.ts';
import { NATIVE, formatUnits, quoteForSize } from '../../src/units.ts';
import type { GardenActions } from './garden-ui.ts';

type Confirmed = Extract<StepResult, { status: 'confirmed' }>;
type Kinds = ('approve' | 'deposit' | 'plant' | 'cancel')[];

export type ActionCtx = {
  env(): Env | undefined;
  account(): string | undefined;
  isBusy(): boolean;
  setBusy(b: boolean): void;
  step(tx: PlannedTx, text: string, opts?: { bids?: { price: bigint; flipPrice: bigint; size: bigint }[] }): Promise<StepResult>;
  stepFailed(r: StepResult): boolean;
  report(what: string, r: Confirmed, v: Verification): boolean;
  say(html: string, cls?: string): void;
  seq(html: string): void;
  statement(kind: PlannedTx['kind'], x: { amount?: bigint; bids?: number; locked?: bigint; ids?: bigint[]; tokens?: string[]; orders?: string[] }): string;
  setStepKinds(kinds: Kinds): Kinds; // returns the previous list so it can be restored
  addOrderIds(ids: bigint[]): void;
  finish(): Promise<void>; // re-read balances and the ledger after an action
};

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const usdc = (v: bigint): string => formatUnits(v, USDC_DECIMALS);
const price = (v: bigint): string => formatUnits(v, 8);
const errorCard = (title: string, text: string): string => `<section class="card error"><h2>${esc(title)}</h2><p>${esc(text)}</p></section>`;

export function makeGardenActions(c: ActionCtx): GardenActions {
  // Runs `fn` as one exclusive action; always releases the busy flag and refreshes afterwards.
  async function exclusive(fn: (env: Env, account: string) => Promise<void>): Promise<void> {
    const env = c.env();
    const account = c.account();
    if (c.isBusy() || !env || !account) return;
    c.setBusy(true);
    try {
      await fn(env, account);
    } catch (e) {
      c.say(`Unexpected error: ${esc((e as Error).message)}`, 'bad');
      c.seq(errorCard('Stopped', (e as Error).message));
    } finally {
      c.setBusy(false);
      await c.finish();
    }
  }

  // The chain is the judge: every id must be resting on the book and owned by the connected account.
  async function ownedAndLive(env: Env, account: string, ids: bigint[]): Promise<boolean> {
    const live = await liveOrderIds(env.rpc, account, ids);
    return ids.length > 0 && ids.every((id) => live.includes(id));
  }

  async function prune(idTexts: string[]): Promise<void> {
    await exclusive(async (env, account) => {
      const ids = [...new Set(idTexts.map((t) => BigInt(t)))];
      if (!(await ownedAndLive(env, account, ids))) {
        c.seq(errorCard('Cannot prune', 'At least one of the chosen orders is not resting on the book for your account any more (it filled, was cancelled, or belongs to someone else). Nothing was sent; the garden will refresh.'));
        return;
      }
      const r = await c.step(planCancel(account, ids), c.statement('cancel', { ids }));
      if (c.stepFailed(r)) return;
      const ok = r as Confirmed;
      if (!c.report('Pruned', ok, await verifyCancel(env, ids, ok))) return;
      c.seq(`<section class="card done"><h2>Pruned</h2><p>${ids.length} order${ids.length === 1 ? '' : 's'} cancelled. What they locked is free at Kuru again; Harvest brings it back to your wallet.</p></section>`);
    });
  }

  async function harvest(): Promise<void> {
    await exclusive(async (env, account) => {
      const snap = await readSnapshot(env.rpc, account);
      const tokens: string[] = [];
      if (snap.marginUsdc > 0n) tokens.push(CHAIN.usdc);
      if (snap.marginMon > 0n) tokens.push(NATIVE);
      if (tokens.length === 0) {
        c.seq(`<section class="card"><h2>Nothing to harvest</h2><p>Nothing is free at Kuru right now. Money locked inside resting orders is not free until the orders fill or you prune them.</p></section>`);
        return;
      }
      const note = ` This returns money that is free at Kuru (${usdc(snap.marginUsdc)} USDC and ${formatUnits(snap.marginMon, 18, 6)} MON right now). It is not a profit figure and it is not limited to one plot.`;
      const r = await c.step(planWithdraw(account, tokens), c.statement('withdraw', { tokens }) + esc(note));
      if (c.stepFailed(r)) return;
      const ok = r as Confirmed;
      if (!c.report('Harvested', ok, await verifyWithdraw(env, snap, tokens, ok))) return;
      c.seq(`<section class="card done"><h2>Harvested</h2><p>The free money at Kuru is back in your wallet. That is not profit: the ledger shows what the garden earned or lost.</p></section>`);
    });
  }

  // What a Move would do right now, from the current book. Used for the preview and again just before the steps.
  type MovePlan = { ok: false; text: string } | { ok: true; text: string; preview: Preview; locked: bigint; block: number };
  async function planMove(env: Env, account: string, id: bigint, placement: Placement): Promise<MovePlan> {
    if (!(await ownedAndLive(env, account, [id]))) return { ok: false, text: 'This order is not resting on the book for your account any more.' };
    const o = await env.rpc.order(CHAIN.market, id);
    if (!o.isBuy) return { ok: false, text: 'Only a resting bid can be moved. A sell holds coin; prune it to get the coin back.' };
    const snap = await readSnapshot(env.rpc, account);
    const locked = quoteForSize(o.size, o.price, snap.market, 'up').value;
    const p = buildPreview({ market: snap.market, book: snap.book, budget: locked, levels: 1, placement });
    if (!p.ok) return { ok: false, text: `The new bid cannot be placed now: ${p.errors.join(' ')}` };
    const l = p.levels[0];
    return {
      ok: true,
      preview: p,
      locked,
      block: snap.block,
      text: `Cancel #${id} (bid at ${price(o.price)}; frees about ${usdc(locked)} USDC), then plant ${l.baseWhole} MON at ${price(l.price)}, flipping to ${price(l.flipPrice)}, locking ${usdc(l.locked)} USDC. Prices are from block ${snap.block.toLocaleString('en-US')} and are read again before each step.`,
    };
  }

  async function previewMove(idText: string, placement: Placement): Promise<string> {
    const env = c.env();
    const account = c.account();
    if (!env || !account) return 'Connect a wallet first.';
    try {
      return (await planMove(env, account, BigInt(idText), placement)).text;
    } catch (e) {
      return `The preview could not be built: ${(e as Error).message}`;
    }
  }

  async function move(idText: string, placement: Placement): Promise<void> {
    await exclusive(async (env, account) => {
      const id = BigInt(idText);
      const plan = await planMove(env, account, id, placement);
      if (!plan.ok) {
        c.seq(errorCard('Cannot move', plan.text + ' Nothing was sent.'));
        return;
      }
      const before = c.setStepKinds(['cancel', 'plant']);
      try {
        const r1 = await c.step(planCancel(account, [id]), c.statement('cancel', { ids: [id] }) + ' A second confirmation will then plant the new bid.');
        if (c.stepFailed(r1)) return;
        const ok1 = r1 as Confirmed;
        if (!c.report('Pruned', ok1, await verifyCancel(env, [id], ok1))) return;

        // second step from a fresh book: the old order's money is free now, so no deposit is ever needed
        const snap = await readSnapshot(env.rpc, account);
        const p = buildPreview({ market: snap.market, book: snap.book, budget: plan.locked, levels: 1, placement });
        const why = (t: string): string => `${t} The old order is pruned and its money is free at Kuru; you can plant again from the form or Harvest it.`;
        if (!p.ok) return void c.seq(errorCard('Pruned, but not replanted', why(`The new bid cannot be placed now: ${p.errors.join(' ')}`)));
        const act = nextPlantAction({ lockedNeeded: p.totalLocked, walletUsdc: snap.walletUsdc, walletMon: snap.walletMon, allowance: snap.allowance, marginUsdc: snap.marginUsdc, openOrders: 0 });
        if (act.type !== 'plant') return void c.seq(errorCard('Pruned, but not replanted', why(act.type === 'blocked' ? act.reason : 'Planting would need a new deposit, which a move never makes.')));
        const bids = p.levels.map((l) => ({ price: l.price, flipPrice: l.flipPrice, size: l.size }));
        const orders = p.levels.map((l) => `${l.baseWhole} MON at ${price(l.price)}, flipping to ${price(l.flipPrice)}`);
        const r2 = await c.step(planPlant(account, bids), c.statement('plant', { bids: 1, locked: p.totalLocked, orders }), { bids });
        if (c.stepFailed(r2)) return void c.say(esc(why('The new bid was not placed.')), 'note');
        const ok2 = r2 as Confirmed;
        const v = await verifyPlant(env, snap, bids, ok2);
        c.addOrderIds(v.orderIds);
        if (!c.report('Moved', ok2, v)) return;
        c.seq(`<section class="card done"><h2>Moved</h2><p>Order #${esc(String(id))} was pruned and a new bid is resting: ${esc(orders[0])}.</p></section>`);
      } finally {
        c.setStepKinds(before);
      }
    });
  }

  return { prune, harvest, previewMove, move };
}
