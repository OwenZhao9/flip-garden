// The hedge page: offset the MON that flip orders pile up with a short on Perpl's MON perpetual, see what it costs and
// risks, and close it again. The visitor's own wallet (or passkey session) signs; this page never sees a key it did not
// get from the passkey session. All logic lives in ../../src/perpl/hedgeflow.ts; this file is DOM wiring only.
// Every dynamic string is escaped. Numbers come from the chain; anything that is a forecast is labelled "estimate".
import { JsonRpc } from '../../src/rpc.ts';
import { connectWallet, sendStep, switchToMonad, walletChainId, type Announcement, type Env, type StepResult, type Verification } from '../../src/flow.ts';
import { CHAIN, LIMITS, type PlannedTx } from '../../src/plant.ts';
import { PERPL } from '../../src/perpl/guard.ts';
import { FUNDING_INTERVAL_BLOCKS, liquidationPricePNS, measuredShortFundingCNS } from '../../src/perpl/hedge.ts';
import {
  AUSD_DECIMALS, HEDGE, closeBound, nextCloseAction, nextOpenAction, perplTraceCheck, planHedge, planPerplApprove, planPerplClose, planPerplCreate, planPerplOpen, planPerplWithdraw, readFundingFacts,
  readHedgeContext, readPerplState, verifyPerplApprove, verifyPerplClose, verifyPerplCreate, verifyPerplOpen, verifyPerplWithdraw,
  type FundingFacts, type HedgeContext, type HedgePlan, type PerplState,
} from '../../src/perpl/hedgeflow.ts';
import { BPS, NATIVE, formatUnits } from '../../src/units.ts';
import { addressUrl, short, txUrl } from './model.ts';
import type { ProviderInfo } from './plant.ts';
import type { Position } from '../../src/perpl/state.ts';

type ExtraCheck = NonNullable<NonNullable<Parameters<typeof sendStep>[3]>['extraCheck']>;
export type HedgeDeps = { providers?: ProviderInfo[]; extraProviders?: ProviderInfo[]; fetchImpl?: typeof fetch; fake?: boolean };

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const ausd = (v: bigint, max = 6): string => formatUnits(v, AUSD_DECIMALS, max);
const mon = (v: bigint): string => formatUnits(v, 18, 4);
const px = (v: bigint): string => formatUnits(v, 6);
const link = (href: string, text: string): string => `<a class="tap" href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>`;
const pct = (num: bigint, den: bigint, digits = 2): string => {
  if (den === 0n) return '0';
  const scaled = (num * 10n ** BigInt(digits + 2)) / den;
  return formatUnits(scaled, digits);
};

const risks = (liqUpPct?: string): string[] => [
  `A short loses when MON goes up. ${liqUpPct ? `At 2x, if MON rises about ${liqUpPct}% above the entry price` : 'If MON rises far enough'}, the exchange closes the short by force (liquidation) and you can lose all the collateral you put into it. The liquidation price is an estimate.`,
  'The hedge is not free: you pay a trading fee to open and again to close, you cross the spread, and you pay or receive funding while it is open. The figures above are what the chain shows today; funding changes at every funding event, about every 43 minutes.',
  'A hedge only offsets the MON you hold. MON locked in resting Kuru sell orders is not counted here, so the hedge can be smaller than your real exposure; if you sell the MON, the short no longer offsets anything. Close the hedge when you are done.',
  'Orders are immediate-or-cancel with a 1% price bound. If the market moves further before your order runs, it can fill partly or not at all. The page reads the receipt and tells you exactly what happened.',
  'Not verified with real money yet: this flow has only run against simulations and a fake chain. Use a small amount (docs/HEDGE-TEST-RUNBOOK.md).',
];

export function mountHedge(root: HTMLElement, deps: HedgeDeps = {}): void {
  const fetchImpl = deps.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const S: {
    prov?: ProviderInfo; account?: string; env?: Env; ctx?: HedgeContext; st?: PerplState; plan?: HedgePlan; inventory: bigint; kuruMon: bigint; walletMon: bigint;
    funding?: FundingFacts; ratioBps: bigint; busy: boolean; log: string[];
  } = { inventory: 0n, kuruMon: 0n, walletMon: 0n, ratioBps: HEDGE.defaultRatioBps, busy: false, log: [] };

  root.innerHTML = `
    <section class="card" id="h-intro"></section>
    <section class="card" id="h-state" hidden></section>
    <section class="card" id="h-position" hidden></section>
    <section class="card" id="h-plan" hidden></section>
    <section id="h-seq" aria-live="polite"></section>
    <section id="h-log"></section>`;
  const $ = <T extends HTMLElement>(id: string): T => root.querySelector('#' + id) as T;
  const seq = (html: string): void => { $('h-seq').innerHTML = html; };
  const say = (html: string, cls = ''): void => { S.log.unshift(`<li class="${cls}">${html}</li>`); $('h-log').innerHTML = `<section class="card"><h2>What happened</h2><ul class="events">${S.log.join('')}</ul></section>`; };

  // ---------------------------------------------------------------- intro and connect
  async function discover(): Promise<ProviderInfo[]> {
    const found = new Map<string, ProviderInfo>();
    const on = (e: Event): void => {
      const d = (e as CustomEvent<{ info: { uuid: string; name: string }; provider: ProviderInfo['provider'] }>).detail;
      if (d?.info && d.provider) found.set(d.info.uuid, { name: d.info.name, provider: d.provider });
    };
    window.addEventListener('eip6963:announceProvider', on);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    await new Promise((r) => setTimeout(r, 250));
    window.removeEventListener('eip6963:announceProvider', on);
    const eth = (window as unknown as { ethereum?: ProviderInfo['provider'] }).ethereum;
    if (found.size === 0 && eth) found.set('window.ethereum', { name: 'Browser wallet', provider: eth });
    return [...found.values()];
  }

  function renderIntro(): void {
    $('h-intro').innerHTML = `
      <h2>Hedge your MON</h2>
      <p>Flip orders can leave you holding MON. Here you offset part of that with a <strong>short on Perpl's MON perpetual</strong> (a "perp" is a bet on the MON price with borrowed size and no expiry; a short gains when MON falls and loses when it rises). If MON falls, the short pays you roughly what the MON you hold lost. You sign every step in <strong>your own wallet</strong> or with your passkey session.</p>
      <ul class="rules">
        <li>Hard caps: at most ${esc(ausd(PERPL.maxNotionalCNS))} USD of hedge, 2x leverage, ${esc(ausd(PERPL.maxDepositCNS))} AUSD deposited, shorts only, MON market only.</li>
        <li>One signature per transaction, each with a plain statement first. Approvals are for the exact amount.</li>
        <li>Every transaction is simulated from your address and traced before you are asked. If it would not fill or would move anything unexpected, you are not asked.</li>
        <li><strong>Close hedge</strong> is always visible while a position exists.</li>
      </ul>
      <p class="callout warning" role="note"><strong>Real money: use a small amount.</strong> You need AUSD (swap for it on the Passkey page) and a little MON for network fees.</p>
      ${deps.fake ? '<p class="note fakebanner" role="status"><strong>Test mode:</strong> a fake wallet and a fake Perpl chain in this browser tab. Nothing is real.</p>' : ''}
      <div id="h-connect"></div>`;
    void renderConnect();
  }

  async function renderConnect(): Promise<void> {
    const host = $('h-connect');
    const provs = [...(deps.extraProviders ?? []), ...(deps.providers ?? (await discover()))];
    if (!provs.length) {
      host.innerHTML = `<p class="warn" role="alert">No browser wallet was found and no passkey session is signed in. Sign in on the Passkey page, or open this page where your wallet is available, then reload.</p>`;
      return;
    }
    host.innerHTML = provs.map((p, i) => `<button type="button" class="primary" data-act="connect" data-i="${i}">Connect ${esc(p.name)}</button>`).join(' ') + `<p class="help">Connecting only shares your public address. It cannot move money.</p>`;
    host.onclick = (ev) => {
      const b = (ev.target as HTMLElement).closest('[data-act="connect"]') as HTMLElement | null;
      if (b) void onConnect(provs[Number(b.dataset.i)]);
    };
  }

  async function onConnect(p: ProviderInfo): Promise<void> {
    const r = await connectWallet(p.provider);
    if (!r.ok) return void $('h-connect').insertAdjacentHTML('beforeend', `<p class="warn" role="alert">${esc(r.message)}</p>`);
    S.prov = p;
    S.account = r.account;
    S.env = { account: r.account, wallet: p.provider, rpc: new JsonRpc(CHAIN.rpcUrl, { fetch: fetchImpl }), sim: new JsonRpc(CHAIN.rpcUrl, { retries: 0, fetch: fetchImpl }) };
    (p.provider as unknown as { on?: (e: string, f: () => void) => void }).on?.('chainChanged', () => void refresh());
    (p.provider as unknown as { on?: (e: string, f: () => void) => void }).on?.('accountsChanged', () => location.reload());
    $('h-connect').innerHTML = `<p>Connected: ${link(addressUrl(r.account), short(r.account))} via ${esc(p.name)}.</p>`;
    await refresh();
  }

  // ---------------------------------------------------------------- reading the chain
  async function refresh(): Promise<void> {
    if (!S.env || !S.prov) return;
    const host = $('h-state');
    host.hidden = false;
    const chainId = await walletChainId(S.prov.provider).catch(() => 0);
    if (chainId !== CHAIN.chainId) {
      host.innerHTML = `<h2>Network</h2><p class="warn" role="alert">Your wallet is on another network (chain id ${chainId || 'unknown'}). This page only works on Monad mainnet (chain id 143).</p><button type="button" class="primary" data-act="switch">Switch to Monad mainnet</button><div id="h-switchmsg"></div>`;
      host.onclick = async (ev) => {
        if (!(ev.target as HTMLElement).closest('[data-act="switch"]')) return;
        const r = await switchToMonad(S.prov!.provider);
        $('h-switchmsg').innerHTML = `<p class="${r.ok ? 'ok' : 'warn'}">${esc(r.message)}</p>`;
        if (r.ok) await refresh();
      };
      $('h-plan').hidden = true;
      $('h-position').hidden = true;
      return;
    }
    try {
      const [walletMon, kuruMon] = await Promise.all([S.env.rpc.walletBalance(S.account!, NATIVE), S.env.rpc.marginBalance(CHAIN.marginAccount, S.account!, NATIVE)]);
      S.walletMon = walletMon;
      S.kuruMon = kuruMon;
      S.inventory = (walletMon > LIMITS.minWalletMon ? walletMon - LIMITS.minWalletMon : 0n) + kuruMon;
      S.st = await readPerplState(S.env.rpc, S.account!);
      S.ctx = await readHedgeContext(S.env.rpc);
      S.funding = await readFundingFacts(S.env.rpc, S.ctx).catch(() => undefined);
    } catch (e) {
      host.innerHTML = `<h2>Balances</h2><p class="warn" role="alert">Could not read the chain: ${esc((e as Error).message)}</p><button type="button" class="secondary" data-act="refresh">Try again</button>`;
      host.onclick = (ev) => { if ((ev.target as HTMLElement).closest('[data-act="refresh"]')) void refresh(); };
      return;
    }
    renderState();
    renderPosition();
    renderPlan();
  }

  function renderState(): void {
    const s = S.st!;
    const c = S.ctx!;
    const a = s.account;
    $('h-state').innerHTML = `<h2>Your MON and your Perpl account</h2>
      <dl class="stats">
        <div class="stat"><dt>MON in wallet</dt><dd>${esc(mon(S.walletMon))}</dd></div>
        <div class="stat"><dt>MON free at Kuru</dt><dd>${esc(mon(S.kuruMon))}</dd></div>
        <div class="stat"><dt>MON that can be hedged</dt><dd>${esc(mon(S.inventory))}</dd><p class="help">Wallet plus Kuru, minus ${esc(formatUnits(LIMITS.minWalletMon, 18))} MON kept for fees. MON locked in resting Kuru orders is not counted.</p></div>
        <div class="stat"><dt>AUSD in wallet</dt><dd>${esc(ausd(s.walletAusd))}</dd></div>
        <div class="stat"><dt>Perpl account (free AUSD)</dt><dd>${a ? esc(ausd(a.balanceCNS)) : 'none yet'}</dd></div>
        <div class="stat"><dt>MON price (mark / best bid / best ask)</dt><dd>${esc(px(c.mark))} / ${esc(px(c.bestBid))} / ${esc(px(c.bestAsk))}</dd><p class="help">AUSD per MON, block ${c.block.toLocaleString('en-US')}.</p></div>
      </dl>
      <button type="button" class="secondary" data-act="refresh">Refresh</button>`;
    $('h-state').onclick = (ev) => { if ((ev.target as HTMLElement).closest('[data-act="refresh"]')) void refresh(); };
  }

  // ---------------------------------------------------------------- the open position (Close is always visible)
  function renderPosition(): void {
    const host = $('h-position');
    const s = S.st!;
    const c = S.ctx!;
    const p = s.position;
    const a = s.account;
    if (!p && !(a && a.balanceCNS > 0n)) { host.hidden = true; return; }
    host.hidden = false;
    if (p) {
      const lot = p.lotLNS;
      const notional = lot * c.mark;
      const liq = HEDGE_LIQ(p, c);
      host.innerHTML = `<h2>Your hedge <span class="pill open">${p.positionType === 1 ? 'Short open' : 'Long (not from this page)'}</span></h2>
        <dl class="stats">
          <div class="stat"><dt>Size</dt><dd>${esc(lot.toString())} MON ${p.positionType === 1 ? 'short' : 'long'}</dd></div>
          <div class="stat"><dt>Entry price</dt><dd>${esc(px(p.pricePNS))}</dd></div>
          <div class="stat"><dt>Mark price now</dt><dd>${esc(px(c.mark))}</dd></div>
          <div class="stat"><dt>Profit or loss so far</dt><dd>${esc(ausd(p.pnlCNS))} AUSD</dd><p class="help">At the mark price, before the closing fee and the spread. Funding so far: ${esc(ausd(p.premiumPnlCNS))} AUSD (negative = paid).</p></div>
          <div class="stat"><dt>Collateral in the position</dt><dd>${esc(ausd(p.depositCNS))} AUSD</dd></div>
          <div class="stat"><dt>Liquidation price (estimate)</dt><dd>${esc(px(liq))}</dd><p class="help">Indicative: it ignores the exchange's dynamic margin and price tolerances. About ${esc(pct(liq - c.mark, c.mark, 1))}% above the mark.</p></div>
        </dl>
        <p class="help">Notional about ${esc(ausd(notional))} AUSD. Closing buys the MON back with an immediate-or-cancel order priced at most 1% above the best ask (${esc(px(closeBound(c)))}).</p>
        ${p.positionType === 1 ? `<div class="actions"><button type="button" class="primary" data-act="close" ${S.busy ? 'disabled' : ''}>Close hedge</button></div>` : ''}`;
    } else {
      host.innerHTML = `<h2>Collateral left in your Perpl account</h2><p><strong>${esc(ausd(a!.balanceCNS))} AUSD</strong> is free in your Perpl account and no position is open. It stays there until you withdraw it.</p>
        <div class="actions"><button type="button" class="primary" data-act="withdraw" ${S.busy ? 'disabled' : ''}>Withdraw ${esc(ausd(a!.balanceCNS))} AUSD to my wallet</button></div>`;
    }
    host.onclick = (ev) => {
      const t = (ev.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
      if (t?.dataset.act === 'close') void runClose();
      if (t?.dataset.act === 'withdraw') void runWithdraw();
    };
  }

  // ---------------------------------------------------------------- the plan
  function renderPlan(): void {
    const host = $('h-plan');
    const s = S.st!;
    const c = S.ctx!;
    if (s.position) { host.hidden = true; return; }
    host.hidden = false;
    S.plan = planHedge({ inventoryRaw: S.inventory, ratioBps: S.ratioBps, ctx: c, freeCNS: s.account ? s.account.balanceCNS : null });
    const p = S.plan;
    const pctNow = formatUnits(S.ratioBps, 2, 0);
    const form = `<h2>Plan a hedge</h2>
      <label for="h-ratio">Hedge ratio (share of your MON to offset)</label>
      <input id="h-ratio" inputmode="numeric" value="${esc(pctNow)}" autocomplete="off" /> <span class="help">percent, default 50. The short is rounded down to whole MON, at least 1.</span>`;
    if (!p.ok) {
      host.innerHTML = `${form}<p class="warn" role="alert">${esc(p.reason)}</p>`;
      bindRatio();
      return;
    }
    const f = S.funding;
    const week = f ? measuredShortFundingCNS(f.sumNow, f.sumThen, p.lot, c.market) : null;
    const act = nextOpenAction(s, p);
    const steps = act.type === 'approve' ? `approve exactly ${ausd(p.depositCNS)} AUSD, create your Perpl account with that deposit, then open the short` : act.type === 'create' ? `create your Perpl account with a ${ausd(p.depositCNS)} AUSD deposit, then open the short` : 'open the short';
    host.innerHTML = `${form}
      <h3>Preview <span class="pill open">Preview, nothing sent</span></h3>
      <dl class="stats">
        <div class="stat"><dt>Short size</dt><dd>${esc(p.lot.toString())} MON</dd><p class="help">${p.cappedBy === 'notional' ? `Capped by the ${esc(ausd(PERPL.maxNotionalCNS))} USD safety cap (you asked for ${esc(p.requestedLot.toString())}). ` : p.cappedBy === 'margin' ? 'Reduced to what your free Perpl collateral supports. ' : ''}Hedges ${esc(mon(p.hedgedInventoryRaw))} MON.</p></div>
        <div class="stat"><dt>Notional</dt><dd>${esc(ausd(p.notionalCNS))} AUSD</dd><p class="help">At the best bid ${esc(px(p.refPricePNS))}.</p></div>
        <div class="stat"><dt>Collateral needed at 2x</dt><dd>${esc(ausd(p.margin.requiredCNS))} AUSD</dd><p class="help">Half the notional (${esc(ausd(p.margin.initialMarginCNS))}), plus the fee (${esc(ausd(p.margin.entryFeeCNS))}) and a ${esc(formatUnits(HEDGE.bufferBps, 2, 0))}% buffer. The exchange also locks (mark - fill) x size on top when the fill is below the mark (estimate ${esc(ausd(p.extraCollateralEstCNS))}); unused collateral stays free in your account.</p></div>
        <div class="stat"><dt>Liquidation price (estimate)</dt><dd>${esc(px(p.liquidationPNS))}</dd><p class="help">Indicative only.</p></div>
        <div class="stat"><dt>Funding at the current rate</dt><dd>${esc(ausd(p.fundingPerDayCNS))} AUSD a day</dd><p class="help">Rate ${esc(c.perp.fundingRatePct100k.toString())} per 100,000 of notional per funding event, one event every ${esc(FUNDING_INTERVAL_BLOCKS.toString())} blocks (about 43 minutes, roughly 33 a day). Positive = the short pays. The rate changes at every event and was 0 in three of the last five.${week === null ? '' : ` Measured on chain, a short of this size would have paid ${esc(ausd(week))} AUSD over the last 7 days (estimated window).`}</p></div>
        <div class="stat"><dt>Opening and closing, estimate</dt><dd>${esc(ausd(p.roundTripCostCNS))} AUSD</dd><p class="help">The spread plus two taker fees (${esc(c.takerFeePpm.toString())} per million of notional each) at today's book.</p></div>
      </dl>
      <h3>Risks, in plain words</h3><ul class="risks">${risks(pct(p.liquidationPNS - p.refPricePNS, p.refPricePNS, 0)).map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
      ${act.type === 'blocked' ? `<p class="warn" role="alert">${esc(act.reason)}</p>` : act.type === 'opened' ? '' : `<p><strong>Your wallet will be asked, one at a time:</strong> ${esc(steps)}.</p><div class="actions"><button type="button" class="primary" data-act="open" ${S.busy ? 'disabled' : ''}>Open the hedge</button></div><p class="help">Pressing the button does not sign anything yet. It simulates the first transaction and shows what it does and what it costs; you confirm with a second button.</p>`}`;
    bindRatio();
    host.querySelector('[data-act="open"]')?.addEventListener('click', () => void runOpen());
  }

  function bindRatio(): void {
    const input = $('h-plan').querySelector('#h-ratio') as HTMLInputElement | null;
    input?.addEventListener('change', () => {
      const v = input.value.trim();
      if (!/^\d{1,3}(\.\d{1,2})?$/.test(v)) return renderPlan();
      const [w, f = ''] = v.split('.');
      const bps = BigInt(w) * 100n + BigInt(f.padEnd(2, '0') || '0');
      S.ratioBps = bps > BPS ? BPS : bps;
      renderPlan();
    });
  }

  // ---------------------------------------------------------------- executing steps
  const statement = (tx: PlannedTx, x: { amount?: bigint; lot?: bigint; price?: bigint }): string => {
    switch (tx.kind) {
      case 'perplApprove': return `<strong>Approve exactly ${esc(ausd(x.amount!))} AUSD.</strong> This lets the Perpl exchange (${link(addressUrl(PERPL.exchange), short(PERPL.exchange))}) take exactly that amount from your wallet in the next step. It is not an unlimited approval.`;
      case 'perplCreate': return `<strong>Create your Perpl account with a ${esc(ausd(x.amount!))} AUSD deposit.</strong> The AUSD leaves your wallet and becomes your collateral at Perpl. You can take it back with Withdraw once no position is open.`;
      case 'perplOpen': return `<strong>Sell ${esc(x.lot!.toString())} MON short on Perpl at 2x leverage</strong>, immediate-or-cancel, at no worse than ${esc(px(x.price!))} AUSD per MON (1% below the best bid). Collateral is taken from your Perpl account; the order fills now or not at all.`;
      case 'perplClose': return `<strong>Buy back ${esc(x.lot!.toString())} MON to close your short</strong>, immediate-or-cancel, at no worse than ${esc(px(x.price!))} AUSD per MON (1% above the best ask). Collateral and the result come back to your Perpl account.`;
      case 'perplWithdraw': return `<strong>Withdraw ${esc(ausd(x.amount!))} AUSD from your Perpl account to your wallet.</strong> Press Cancel instead if you plan to hedge again: a new hedge uses the collateral that stays in your Perpl account.`;
      default: return '';
    }
  };

  async function step(tx: PlannedTx, text: string, extraCheck?: ExtraCheck): Promise<StepResult> {
    seq(`<section class="card"><h2>Next transaction</h2><p>${text}</p><p class="help" id="h-st">Preparing…</p></section>`);
    const r = await sendStep(S.env!, tx, {
      status: (m) => { const el = root.querySelector('#h-st'); if (el) el.textContent = m; },
      announce: (a: Announcement) => new Promise<boolean>((resolve) => {
        const inPage = (S.prov?.provider as { isMera?: boolean } | undefined)?.isMera === true;
        seq(`<section class="card announce"><h2>${inPage ? 'Ready: sign with your passkey session' : 'Ready: one wallet pop-up'}</h2><p>${text}</p>
          <p class="ok">Simulation passed from your address${tx.kind === 'perplApprove' ? '' : ', and a trace shows the events it would produce'}.</p>
          <p>Network fee: up to about <strong>${esc(formatUnits(a.gasMonWei, 18, 6))} MON</strong> (gas limit ${a.gasLimit.toLocaleString('en-US')} at ${esc(formatUnits(a.gasPriceWei / 10n ** 9n, 0))} gwei; Monad charges the limit).</p>
          <div class="actions"><button type="button" class="primary" data-act="go">${inPage ? 'Sign and send' : 'Open the wallet pop-up'}</button><button type="button" class="secondary" data-act="stop">Cancel</button></div>
          <p class="help">${inPage ? 'This button is your confirmation: the page signs this one transaction with your signed-in passkey session. No wallet pop-up will appear.' : 'Check the pop-up shows the same action before you confirm there.'}</p></section>`);
        $('h-seq').onclick = (ev) => {
          const t = (ev.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
          if (!t) return;
          $('h-seq').onclick = null;
          seq(`<section class="card"><p>Waiting for the wallet and the network…</p></section>`);
          resolve(t.dataset.act === 'go');
        };
      }),
    }, extraCheck ? { extraCheck } : {});
    return r;
  }

  const stopped = (r: StepResult): boolean => {
    if (r.status === 'confirmed') return false;
    const hash = 'hash' in r ? ` ${link(txUrl(r.hash), short(r.hash))}` : '';
    const soft = r.status === 'declined' || r.status === 'rejected';
    say(`${esc(r.message)}${hash}`, soft ? 'note' : 'bad');
    seq(`<section class="card ${soft ? '' : 'error'}"><h2>Stopped</h2><p>${esc(r.message)}</p><p class="help">You can press the button again; the page works out where to continue from what is on the chain.</p></section>`);
    return true;
  };

  const report = (what: string, r: Extract<StepResult, { status: 'confirmed' }>, v: Verification): boolean => {
    say(`${esc(what)}: ${link(txUrl(r.hash), short(r.hash))} · network fee ${esc(formatUnits(r.gasPaidWei, 18, 6))} MON · ${v.ok ? esc(v.facts.join(' ')) : esc(v.problems.join(' '))}`, v.ok ? 'ok' : 'bad');
    if (!v.ok) seq(`<section class="card error"><h2>Stopped: cannot explain</h2><p>${v.problems.map(esc).join('<br>')}</p><p>Nothing more will be sent automatically. Check the transaction on the explorer; Close hedge stays available if a position exists.</p></section>`);
    return v.ok;
  };

  const deadline = (): bigint => BigInt(S.ctx!.block) + HEDGE.deadlineBlocks;

  async function runOpen(): Promise<void> {
    if (S.busy || !S.env || !S.plan?.ok) return;
    S.busy = true;
    const user = S.account!;
    try {
      for (let guard = 0; guard < 5; guard++) {
        S.ctx = await readHedgeContext(S.env.rpc);
        const st = await readPerplState(S.env.rpc, user);
        S.st = st;
        const plan = planHedge({ inventoryRaw: S.inventory, ratioBps: S.ratioBps, ctx: S.ctx, freeCNS: st.account ? st.account.balanceCNS : null });
        if (!plan.ok) { seq(`<section class="card error"><h2>Cannot continue</h2><p>${esc(plan.reason)}</p></section>`); break; }
        const act = nextOpenAction(st, plan);
        if (act.type === 'blocked') { seq(`<section class="card error"><h2>Cannot continue</h2><p>${esc(act.reason)}</p></section>`); break; }
        if (act.type === 'opened') break;
        if (act.type === 'approve') {
          const tx = planPerplApprove(user, act.amount);
          const r = await step(tx, statement(tx, { amount: act.amount }));
          if (stopped(r)) break;
          if (!report('Approved', r as Extract<StepResult, { status: 'confirmed' }>, await verifyPerplApprove(S.env, act.amount, r as Extract<StepResult, { status: 'confirmed' }>))) break;
        } else if (act.type === 'create') {
          const tx = planPerplCreate(user, act.amount, S.ctx.minOpenCNS);
          const r = await step(tx, statement(tx, { amount: act.amount }), perplTraceCheck(S.env.sim, user, { kind: 'create', amount: act.amount }));
          if (stopped(r)) break;
          if (!report('Account created', r as Extract<StepResult, { status: 'confirmed' }>, await verifyPerplCreate(S.env, st, act.amount, r as Extract<StepResult, { status: 'confirmed' }>))) break;
        } else {
          const tx = planPerplOpen(user, { lot: plan.lot, boundPNS: plan.boundPNS, lastExecutionBlock: deadline() });
          const r = await step(tx, statement(tx, { lot: plan.lot, price: plan.boundPNS }), perplTraceCheck(S.env.sim, user, { kind: 'open', accountId: st.account!.accountId, lot: plan.lot }));
          if (stopped(r)) break;
          const c = r as Extract<StepResult, { status: 'confirmed' }>;
          const v = await verifyPerplOpen(S.env, st, plan, c);
          if (!report(v.filledLot > 0n ? 'Hedge opened' : 'Order ran', c, v)) break;
          seq(v.filledLot > 0n
            ? `<section class="card done"><h2>${v.filledLot < plan.lot ? 'Hedge partly opened' : 'Hedge opened'}</h2><p>${esc(v.facts.join(' '))}</p><p class="help">Close hedge is below whenever you want out.</p></section>`
            : `<section class="card"><h2>Nothing was filled</h2><p>${esc(v.facts.join(' '))}</p><p class="help">Your AUSD is still in your Perpl account. Press the button again to retry at the new price.</p></section>`);
          break;
        }
      }
    } catch (e) {
      say(`Unexpected error: ${esc((e as Error).message)}`, 'bad');
      seq(`<section class="card error"><h2>Stopped</h2><p>${esc((e as Error).message)}</p></section>`);
    } finally {
      S.busy = false;
      await refresh();
    }
  }

  async function runClose(): Promise<void> {
    if (S.busy || !S.env) return;
    S.busy = true;
    const user = S.account!;
    try {
      for (let guard = 0; guard < 4; guard++) {
        S.ctx = await readHedgeContext(S.env.rpc);
        const st = await readPerplState(S.env.rpc, user);
        S.st = st;
        const act = nextCloseAction(st);
        if (act.type === 'blocked') { seq(`<section class="card error"><h2>Cannot continue</h2><p>${esc(act.reason)}</p></section>`); break; }
        if (act.type === 'done') { seq(`<section class="card done"><h2>Closed</h2><p>No position is open and your Perpl account is empty.</p></section>`); break; }
        if (act.type === 'close') {
          const lot = st.position!.lotLNS;
          const bound = closeBound(S.ctx);
          const tx = planPerplClose(user, { lot, boundPNS: bound, lastExecutionBlock: deadline() });
          const r = await step(tx, statement(tx, { lot, price: bound }), perplTraceCheck(S.env.sim, user, { kind: 'close', accountId: st.account!.accountId, lot, positionLot: lot }));
          if (stopped(r)) break;
          const c = r as Extract<StepResult, { status: 'confirmed' }>;
          const v = await verifyPerplClose(S.env, st, { lot, boundPNS: bound }, c);
          if (!report(v.closedLot > 0n ? 'Hedge closed' : 'Order ran', c, v)) break;
          if (v.remainingLot > 0n || v.closedLot === 0n) { seq(`<section class="card"><h2>${v.closedLot === 0n ? 'Nothing was bought back' : 'Partly closed'}</h2><p>${esc(v.facts.join(' '))}</p></section>`); break; }
        } else {
          const tx = planPerplWithdraw(user, act.amount);
          const r = await step(tx, statement(tx, { amount: act.amount }), perplTraceCheck(S.env.sim, user, { kind: 'withdraw', accountId: st.account!.accountId, amount: act.amount }));
          if (stopped(r)) break;
          const c = r as Extract<StepResult, { status: 'confirmed' }>;
          if (!report('Withdrawn', c, await verifyPerplWithdraw(S.env, st, act.amount, c))) break;
        }
      }
    } catch (e) {
      say(`Unexpected error: ${esc((e as Error).message)}`, 'bad');
      seq(`<section class="card error"><h2>Stopped</h2><p>${esc((e as Error).message)}</p></section>`);
    } finally {
      S.busy = false;
      await refresh();
    }
  }

  const runWithdraw = runClose; // with no position the close loop goes straight to the withdrawal

  renderIntro();
}

// Liquidation estimate for an open position, from the position as the chain reports it.
function HEDGE_LIQ(p: Position, c: HedgeContext): bigint {
  return liquidationPricePNS({ side: p.positionType === 1 ? 'short' : 'long', entryPricePNS: p.pricePNS, lotLNS: p.lotLNS, depositCNS: p.depositCNS, fundingOwedCNS: p.premiumPnlCNS }, c.market);
}
