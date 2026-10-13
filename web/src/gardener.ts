// The Gardener panel on the planting page: the switch, the mandate card the user confirms once, the status (watching,
// acting, waiting for you, stopped), the remaining budget and expiry, Stop, suggestions to confirm, and the timeline.
// All decisions live in ../../src/gardener (pure policy, executor through sendStep); this file is DOM wiring only.
// It runs only while this page is open and the passkey session is signed in: hiding the tab or locking the session
// stops it. Every dynamic string is escaped.
import type { Announcement, Env } from '../../src/flow.ts';
import { LIMITS } from '../../src/plant.ts';
import { PERPL } from '../../src/perpl/guard.ts';
import { readSnapshot } from '../../src/flow.ts';
import { ACTION_KINDS, MANDATE_LIMITS, defaultMandate, validateMandate, type ActionKind, type Mandate } from '../../src/gardener/mandate.ts';
import { jevDecider, rulesDecider, type Decider } from '../../src/gardener/decide.ts';
import { Observer } from '../../src/gardener/observe.ts';
import { Gardener, STATUS_TEXT } from '../../src/gardener/runner.ts';
import type { Answer, Question } from '../../src/gardener/policy.ts';
import { formatUnits, parseUnits } from '../../src/units.ts';
import { loadTimeline, saveEntry, timelineHtml, type Store } from './gardener-timeline.ts';

// The Worker's POST /decide (the Jev key is a Worker secret there). Null hides the Jev choice on the mandate card.
export const DECIDE_URL: string | null = 'https://flip-garden-leaderboard.photogif.workers.dev/decide';
export const CHECK_EVERY_MS = 5_000;

export type GardenerCtx = {
  env(): Env | undefined;
  account(): string | undefined;
  isBusy(): boolean;
  setBusy(b: boolean): void;
  inPageSigner(): boolean; // a signed-in passkey session (or the test page's fake wallet)
  keepAlive?(): void; // restarts the passkey session's idle clock while the mandate runs
  knownIds(): bigint[];
  addOrderIds(ids: bigint[]): void;
  finish(): Promise<void>;
  store: Store;
  fake?: boolean;
  decideUrl?: string | null;
  checkEveryMs?: number;
};

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const usdc = (v: bigint): string => formatUnits(v, 6);
const px = (v: bigint): string => formatUnits(v, 8);
const pct = (bps: bigint): string => formatUnits(bps, 2);
const ACTION_TEXT: Record<ActionKind, string> = {
  requote: 'Re-place a bid that has left the range (cancel it and plant again one tick above the best bid), or prune it',
  replant: 'Plant money that is free at Kuru again after a failed or interrupted planting or move',
  hedge: 'Keep the Perpl short inside the hedge range (reduce it, or open one from your existing Perpl account)',
  harvest: 'Withdraw money that has sat idle at Kuru for five minutes to the wallet',
  refuel: 'Withdraw MON that is free at Kuru to the wallet when the wallet runs low on MON for network fees',
};

const ACTION_SHORT: Record<ActionKind, string> = {
  requote: 're-place or prune a bid that has left the range',
  replant: 'plant free USDC at Kuru again',
  hedge: 'adjust the Perpl hedge',
  harvest: 'withdraw idle money to the wallet',
  refuel: 'withdraw free MON for network fees',
};

export function parseMandateForm(f: Record<string, string>, base: Mandate, actions: ActionKind[], nowMs: number): { ok: true; mandate: Mandate } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const num = (k: string, d: number, label: string): bigint => {
    try {
      return parseUnits(f[k]?.trim() ?? '', d);
    } catch {
      errors.push(`${label}: enter a plain number.`);
      return 0n;
    }
  };
  const hours = Number(f.hours);
  if (!Number.isFinite(hours) || hours <= 0) errors.push('Expiry: enter a number of hours.');
  const tx = Number(f.tx);
  const conf = (k: string, d: number, label: string): number => {
    const v = f[k] === undefined || f[k].trim() === '' ? d : Number(f[k]);
    if (!Number.isFinite(v)) errors.push(`${label}: enter a number between 0 and 1.`);
    return v;
  };
  const actAt = conf('act', base.actAt, 'Act alone at');
  const askAt = conf('ask', base.askAt, 'Ask you at');
  const m: Mandate = {
    ...base,
    startMs: nowMs,
    expiresMs: nowMs + Math.round(hours * 3_600_000),
    usdcBudget: num('usdc', 6, 'USDC budget'),
    ausdBudget: num('ausd', 6, 'AUSD budget'),
    priceMin: num('pmin', 8, 'Lowest price'),
    priceMax: num('pmax', 8, 'Highest price'),
    bandBps: num('band', 2, 'Re-place distance'),
    hedgeMinBps: num('hmin', 2, 'Hedge range'),
    hedgeMaxBps: num('hmax', 2, 'Hedge range'),
    maxTxPerHour: Number.isInteger(tx) ? tx : -1,
    maxFeeWeiPerHour: num('fee', 18, 'Network fees per hour'),
    actions,
    actAt,
    askAt,
  };
  if (errors.length) return { ok: false, errors };
  const v = validateMandate(m, nowMs);
  return v.length ? { ok: false, errors: v } : { ok: true, mandate: m };
}

export function mandateSummary(m: Mandate, decider: string): string {
  const li = (s: string): string => `<li>${s}</li>`;
  return `<ul class="rules">
    ${li(`Bids it keeps planted: at most <strong>${esc(usdc(m.usdcBudget))} USDC</strong> locked at once, only from money already at Kuru (it never approves or deposits).`)}
    ${m.actions.includes('hedge') ? li(`Hedge collateral: at most <strong>${esc(usdc(m.ausdBudget))} AUSD</strong> from your existing Perpl account; hedge ratio kept between <strong>${esc(pct(m.hedgeMinBps))}%</strong> and <strong>${esc(pct(m.hedgeMaxBps))}%</strong> of the MON the garden holds.`) : ''}
    ${li(`Prices: it only plants bids between <strong>${esc(px(m.priceMin))}</strong> and <strong>${esc(px(m.priceMax))}</strong> USDC per MON. A bid more than <strong>${esc(pct(m.bandBps))}%</strong> under the best bid has left the range.`)}
    ${li(`Allowed: ${m.actions.map((a) => esc(ACTION_SHORT[a])).join('; ')}.`)}
    ${li(`At most <strong>${m.maxTxPerHour}</strong> transactions and <strong>${esc(formatUnits(m.maxFeeWeiPerHour, 18))} MON</strong> of network fees per hour.`)}
    ${li(`Expires at <strong>${esc(new Date(m.expiresMs).toLocaleTimeString('en-GB'))}</strong>. Stop halts everything at once.`)}
    ${li(`Decisions: ${decider === 'jev' ? `Jev (TypeSafe AI) picks among the options the code allows; it acts alone at confidence ${m.actAt} or more, asks you between ${m.askAt} and ${m.actAt}, and does nothing below.` : 'fixed rules (no AI model).'} Anything outside this mandate is not done, or shown to you as a normal confirmation.`)}
  </ul>`;
}

export function mountGardener(host: HTMLElement, ctx: GardenerCtx): { stop(reason?: string): void; refresh(): void } {
  const decideUrl = ctx.decideUrl === undefined ? DECIDE_URL : ctx.decideUrl;
  let g: Gardener | null = null;
  let mandate: Mandate | null = null;
  let deciderName: 'rules' | 'jev' = 'rules';
  let timer: ReturnType<typeof setInterval> | undefined;
  let phase: 'off' | 'form' | 'confirm' | 'running' = 'off';
  let draft: Mandate | null = null;
  let pendingAsk: { text: string; resolve: (go: boolean) => void } | null = null;
  const lastCheck = { at: 0 };

  const stopAll = (reason: string): void => {
    if (timer) clearInterval(timer);
    timer = undefined;
    pendingAsk?.resolve(false);
    pendingAsk = null;
    g?.stop(reason);
    render();
  };

  const onMera = (): void => { if (g && !g.isStopped && !ctx.fake && !ctx.inPageSigner()) stopAll('Stopped because the passkey session was locked.'); };
  window.addEventListener('mera-change', onMera);

  function render(): void {
    const account = ctx.account();
    if (!account) { host.hidden = true; return; }
    host.hidden = false;
    const timeline = timelineHtml(g?.timeline.length ? g.timeline : loadTimeline(ctx.store, account), { limit: 15 });
    const head = `<h2>Gardener</h2><p>The Gardener tends your garden while this page is open: it re-places a bid the market has left behind, plants again after a failed move, harvests idle money, keeps MON for network fees and, if you allow it, keeps your hedge in range. <strong>It works only while this page is open and your passkey session is signed in.</strong> It keeps working when the tab is in the background or covered by another window (the browser may then check less often); closing or reloading the page, locking the session or Stop ends it. While a mandate runs, its checks keep the session from locking for inactivity until the mandate ends.</p>`;
    if (!ctx.fake && !ctx.inPageSigner()) {
      host.innerHTML = `${head}<p class="callout">The Gardener signs with a signed-in passkey session, so it needs one: sign in on the Passkey tab and connect "Passkey session" here.</p>${timeline}`;
      return;
    }
    if (phase === 'off') {
      host.innerHTML = `${head}<div class="actions"><button type="button" class="primary" data-g="setup">Set up the Gardener</button></div>${timeline}`;
    } else if (phase === 'form' && draft) {
      const d = draft;
      const hours = (d.expiresMs - d.startMs) / 3_600_000;
      host.innerHTML = `${head}<h3>Mandate</h3><p class="help">What the Gardener may do without asking. Inside it, it acts and tells you; anything outside is not done. The limits below cannot exceed the page's hard caps (${usdc(LIMITS.maxNotionalUsdc)} USDC per planting, ${usdc(PERPL.maxDepositCNS)} AUSD per hedge deposit).</p>
        <div class="row">
          <div><label for="g-usdc">USDC it may keep locked in bids</label><input id="g-usdc" inputmode="decimal" value="${esc(usdc(d.usdcBudget))}" /></div>
          <div><label for="g-ausd">AUSD it may commit to a hedge</label><input id="g-ausd" inputmode="decimal" value="${esc(usdc(d.ausdBudget))}" /></div>
        </div>
        <div class="row">
          <div><label for="g-pmin">Lowest bid price (USDC per MON)</label><input id="g-pmin" inputmode="decimal" value="${esc(px(d.priceMin))}" /></div>
          <div><label for="g-pmax">Highest bid price</label><input id="g-pmax" inputmode="decimal" value="${esc(px(d.priceMax))}" /></div>
        </div>
        <label for="g-band">Re-place a bid that sits more than this far under the best bid (%)</label><input id="g-band" inputmode="decimal" value="${esc(pct(d.bandBps))}" />
        <div class="row">
          <div><label for="g-hmin">Hedge ratio from (%)</label><input id="g-hmin" inputmode="decimal" value="${esc(pct(d.hedgeMinBps))}" /></div>
          <div><label for="g-hmax">to (%)</label><input id="g-hmax" inputmode="decimal" value="${esc(pct(d.hedgeMaxBps))}" /></div>
        </div>
        <fieldset><legend>Allowed actions</legend>${ACTION_KINDS.map((a) => `<label class="radio"><input type="checkbox" name="g-act" value="${a}" ${d.actions.includes(a) ? 'checked' : ''} /> <span>${esc(ACTION_TEXT[a])}</span></label>`).join('')}</fieldset>
        <div class="row">
          <div><label for="g-hours">Expires after (hours, at most ${MANDATE_LIMITS.maxHours})</label><input id="g-hours" inputmode="decimal" value="${hours}" /></div>
          <div><label for="g-tx">Transactions per hour (at most ${MANDATE_LIMITS.maxTxPerHour})</label><input id="g-tx" inputmode="numeric" value="${d.maxTxPerHour}" /></div>
          <div><label for="g-fee">Network fees per hour (MON)</label><input id="g-fee" inputmode="decimal" value="${esc(formatUnits(d.maxFeeWeiPerHour, 18))}" /></div>
        </div>
        ${decideUrl ? `<fieldset><legend>Who decides</legend><label class="radio"><input type="radio" name="g-dec" value="rules" ${deciderName === 'rules' ? 'checked' : ''} /> <span>Fixed rules</span></label><label class="radio"><input type="radio" name="g-dec" value="jev" ${deciderName === 'jev' ? 'checked' : ''} /> <span>Jev (TypeSafe AI) chooses among the options the rules allow, with a confidence</span></label>
          <div class="row">
            <div><label for="g-act">Jev acts alone when its confidence is at least (0 to 1)</label><input id="g-act" inputmode="decimal" value="${d.actAt}" /></div>
            <div><label for="g-ask">Jev asks you when its confidence is at least (below this it does nothing)</label><input id="g-ask" inputmode="decimal" value="${d.askAt}" /></div>
          </div>
          <p class="help">On recorded market data Jev's confidence was between 0.56 and 0.83. A higher number means it acts alone less often.</p></fieldset>` : '<p class="help">Decisions follow fixed rules (no AI model).</p>'}
        <div id="g-err"></div>
        <div class="actions"><button type="button" class="primary" data-g="review">Review the mandate</button><button type="button" class="secondary" data-g="cancel">Cancel</button></div>${timeline}`;
    } else if (phase === 'confirm' && draft) {
      host.innerHTML = `${head}<section class="card announce"><h3>Confirm the mandate</h3>${mandateSummary(draft, deciderName)}
        <p class="help">Each transaction still passes the page's guard, a simulation from your address and a check against the chain afterwards, exactly like one you start yourself. Your passkey session signs it without a further button press while the mandate runs.</p>
        <div class="actions"><button type="button" class="primary" data-g="start">Start the Gardener</button><button type="button" class="secondary" data-g="edit">Change</button></div></section>${timeline}`;
    } else if (phase === 'running' && g && mandate) {
      const r = g.remaining();
      const mins = Math.max(0, Math.round(r.msLeft / 60_000));
      const stopped = g.isStopped;
      host.innerHTML = `${head}<div class="gardener-status" role="status"><span class="pill ${stopped ? 'cancelled' : g.status === 'asking' ? 'filled' : 'open'}">${esc(STATUS_TEXT[g.status])}</span> <span>${esc(g.note)}</span></div>
        <dl class="stats">
          <div class="stat"><dt>Transactions left this hour</dt><dd>${r.txs} of ${mandate.maxTxPerHour}</dd></div>
          <div class="stat"><dt>Network fees left this hour</dt><dd>${esc(formatUnits(r.feeWei, 18, 4))} MON</dd></div>
          <div class="stat"><dt>Mandate expires</dt><dd>${stopped ? '—' : `in ${mins} min`}</dd></div>
          <div class="stat"><dt>Decides with</dt><dd>${deciderName === 'jev' ? 'Jev' : 'rules'}</dd></div>
        </dl>
        ${pendingAsk ? `<section class="card announce"><h3>The Gardener asks</h3><p>${pendingAsk.text}</p><div class="actions"><button type="button" class="primary" data-g="yes">Sign and send</button><button type="button" class="secondary" data-g="no">Not now</button></div></section>` : ''}
        <div class="actions">${stopped ? '<button type="button" class="primary" data-g="setup">Set up a new mandate</button>' : '<button type="button" class="danger primary" data-g="stop">Stop the Gardener</button>'}</div>
        <p class="help">${lastCheck.at ? `Last check ${esc(new Date(lastCheck.at).toLocaleTimeString('en-GB'))}; ` : ''}checks about every ${(ctx.checkEveryMs ?? CHECK_EVERY_MS) / 1000} seconds (less often while the tab is in the background).</p>${timeline}`;
    }
  }

  function formValues(): Record<string, string> {
    const v = (id: string): string => (host.querySelector('#' + id) as HTMLInputElement | null)?.value ?? '';
    return { usdc: v('g-usdc'), ausd: v('g-ausd'), pmin: v('g-pmin'), pmax: v('g-pmax'), band: v('g-band'), hmin: v('g-hmin'), hmax: v('g-hmax'), hours: v('g-hours'), tx: v('g-tx'), fee: v('g-fee'), act: v('g-act'), ask: v('g-ask') };
  }

  async function setup(): Promise<void> {
    const env = ctx.env();
    const account = ctx.account();
    if (!env || !account) return;
    const snap = await readSnapshot(env.rpc, account);
    draft = defaultMandate(account, Date.now(), snap.book, snap.market.tickSize);
    phase = 'form';
    render();
  }

  function start(): void {
    const env = ctx.env();
    const account = ctx.account();
    if (!env || !account || !draft) return;
    mandate = draft;
    const m = mandate;
    const decider: Decider = deciderName === 'jev' && decideUrl ? jevDecider({ url: decideUrl }) : rulesDecider;
    let observer: Observer | null = null;
    g = new Gardener({
      mandate: m, decider,
      observe: async () => {
        // order ids come from the page's own records plus the account's flip-order events from shortly before the start
        observer ??= new Observer(env, Math.max(0, (await env.rpc.blockNumber()) - 600), { hedge: () => m.actions.includes('hedge'), knownIds: () => ctx.knownIds() });
        return observer.read();
      },
      exec: { env, status: () => {} },
      ask: (_q: Question, a: Answer, action: string) => new Promise<boolean>((resolve) => {
        pendingAsk = { text: `${esc(action)} <span class="help">(${a.source === 'jev' ? 'Jev' : 'rules'}, confidence ${a.confidence.toFixed(2)}: between your thresholds, so it asks first)</span>`, resolve: (go) => { pendingAsk = null; resolve(go); render(); } };
        render();
      }),
      confirmTx: (a: Announcement, text: string) => new Promise<boolean>((resolve) => {
        pendingAsk = { text: `${esc(text)} Network fee up to about ${esc(formatUnits(a.gasMonWei, 18, 6))} MON.`, resolve: (go) => { pendingAsk = null; resolve(go); render(); } };
        render();
      }),
      onChange: render,
      onEntry: (e) => { saveEntry(ctx.store, account, e); if (e.txs.length) void ctx.finish(); },
      checkSeconds: (ctx.checkEveryMs ?? CHECK_EVERY_MS) / 1000,
    });
    phase = 'running';
    const tick = async (): Promise<void> => {
      if (!g || g.isStopped || ctx.isBusy()) return;
      // A covered or background tab keeps running (owner's decision, 2026-10-13); the browser may slow its checks down.
      if (!ctx.fake && !ctx.inPageSigner()) return stopAll('Stopped because the passkey session was locked.');
      if (Date.now() < (mandate?.expiresMs ?? 0)) ctx.keepAlive?.(); // the confirmed mandate, not the idle lock, decides how long it runs
      ctx.setBusy(true);
      try {
        await g.tick();
        lastCheck.at = Date.now();
        const ids = g.lastObs?.orders.map((o) => o.id) ?? [];
        if (ids.length) ctx.addOrderIds(ids);
      } finally {
        ctx.setBusy(false);
      }
      if (g.isStopped && timer) { clearInterval(timer); timer = undefined; }
      render();
    };
    timer = setInterval(() => void tick(), ctx.checkEveryMs ?? CHECK_EVERY_MS);
    render();
    void tick();
  }

  host.addEventListener('click', (ev) => {
    const t = (ev.target as HTMLElement).closest('[data-g]') as HTMLElement | null;
    if (!t) return;
    const act = t.dataset.g;
    if (act === 'setup') void setup();
    else if (act === 'cancel') { phase = 'off'; draft = null; render(); }
    else if (act === 'edit') { phase = 'form'; render(); }
    else if (act === 'review' && draft) {
      const actions = [...host.querySelectorAll('input[name="g-act"]:checked')].map((x) => (x as HTMLInputElement).value as ActionKind);
      const dec = (host.querySelector('input[name="g-dec"]:checked') as HTMLInputElement | null)?.value;
      deciderName = dec === 'jev' && decideUrl ? 'jev' : 'rules';
      const r = parseMandateForm(formValues(), draft, actions, Date.now());
      if (!r.ok) { host.querySelector('#g-err')!.innerHTML = `<ul class="warn" role="alert">${r.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`; return; }
      draft = r.mandate;
      phase = 'confirm';
      render();
    } else if (act === 'start') start();
    else if (act === 'stop') stopAll('Stopped by you.');
    else if (act === 'yes') pendingAsk?.resolve(true);
    else if (act === 'no') pendingAsk?.resolve(false);
  });

  render();
  return {
    stop: (reason = 'Stopped because you left the page.') => {
      if (g && !g.isStopped) stopAll(reason);
      window.removeEventListener('mera-change', onMera);
    },
    refresh: render,
  };
}

