// The planting page. The visitor's own browser wallet signs; this page never sees a key.
// Every transaction: plain statement -> simulation -> gas -> the visitor presses a button -> ONE wallet pop-up -> receipt -> check.
// All logic lives in ../../src (flow.ts, plant.ts); this file is only DOM wiring. Every dynamic string is escaped.
import { JsonRpc } from '../../src/rpc.ts';
import { decodeLog } from '../../src/events.ts';
import {
  connectWallet, liveOrderIds, readSnapshot, sendStep, simulatePreview, switchToMonad, verifyApprove, verifyCancel, verifyDeposit, verifyPlant, verifyWithdraw, walletChainId,
  type Announcement, type Eip1193, type Env, type Snapshot, type StepResult, type Verification,
} from '../../src/flow.ts';
import { CHAIN, LIMITS, USDC_DECIMALS, buildPreview, nextPlantAction, nextUnwindAction, planApprove, planCancel, planDeposit, planPlant, planWithdraw, type Placement, type PlannedTx, type Preview } from '../../src/plant.ts';
import { NATIVE, formatUnits, parseUnits } from '../../src/units.ts';
import { fetchBundle, MAINNET, type Store } from './pipeline.ts';
import { txUrl, addressUrl, short } from './model.ts';
import { stepper, type StepState } from './ui.ts';
import { parseNote, serializeNote } from './plantnote.ts';
import { gardenSpan } from '../../src/garden.ts';
import { makeGardenActions, type ActionCtx } from './garden-actions.ts';
import { applyTweens, captureTweens } from './garden-fx-dom.ts';
import { startLive } from './garden-live.ts';
import { mountGardenPanel } from './garden-ui.ts';
import { buildGardenView, ledgerOfBundle } from './garden-view.ts';
import { ageSecondsBetween } from './blocktimes.ts';
import { mountGardener } from './gardener.ts';

export type ProviderInfo = { name: string; provider: Eip1193 };
const LIVE_EVERY_MS = 10_000;
export type PlantDeps = { providers?: ProviderInfo[]; extraProviders?: ProviderInfo[]; fetchImpl?: typeof fetch; fake?: boolean };

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const usdc = (v: bigint): string => formatUnits(v, USDC_DECIMALS);
const mon = (v: bigint): string => formatUnits(v, 18, 6);
const price = (v: bigint): string => formatUnits(v, 8);
const link = (href: string, text: string): string => `<a class="tap" href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>`;

const browserStore: Store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode: the page still works */ } },
};

async function discover(): Promise<ProviderInfo[]> {
  const found = new Map<string, ProviderInfo>();
  const on = (e: Event): void => {
    const d = (e as CustomEvent<{ info: { uuid: string; name: string }; provider: Eip1193 }>).detail;
    if (d?.info && d.provider) found.set(d.info.uuid, { name: d.info.name, provider: d.provider });
  };
  window.addEventListener('eip6963:announceProvider', on);
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  await new Promise((r) => setTimeout(r, 250));
  window.removeEventListener('eip6963:announceProvider', on);
  const eth = (window as unknown as { ethereum?: Eip1193 }).ethereum;
  if (found.size === 0 && eth) found.set('window.ethereum', { name: 'Browser wallet', provider: eth });
  return [...found.values()];
}

const RISKS = [
  'You can lose money. A bid that sits right under the best ask is usually hit at once, and the price can then drift down: the position shows a paper loss (the real test on 2026-10-10 showed about one cent on $5).',
  'Flip orders do not guarantee profit. "Up to" profit assumes both sides fill completely and fees stay at 0, which is how the market reads today.',
  'You hold the coin (MON) you bought until the matching sell fills. If the sell never fills you keep the coin; you can cancel and withdraw whenever you like.',
  'Start with a throwaway wallet and a few dollars.',
];

// Returns a function that stops the background refresh (called when the visitor leaves the page).
export function mountPlant(root: HTMLElement, deps: PlantDeps = {}): () => void {
  // The test page starts a fresh fake chain on every load, so it must not read what an earlier load saved.
  const memory = new Map<string, string>();
  const store: Store = deps.fake ? { get: (k) => memory.get(k) ?? null, set: (k, v) => void memory.set(k, v) } : browserStore;
  const fetchImpl = deps.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const S: {
    prov?: ProviderInfo; account?: string; env?: Env; snap?: Snapshot; preview?: Preview; previewNote: string; busy: boolean;
    startBlock?: number; orderIds: bigint[]; log: string[]; liveIds: bigint[] | null; stepKinds: ('approve' | 'deposit' | 'plant' | 'cancel')[]; announce?: { a: Announcement; resolve: (go: boolean) => void };
  } = { previewNote: '', busy: false, orderIds: [], log: [], liveIds: null, stepKinds: [] };

  root.innerHTML = `
    <section class="card" id="p-intro"></section>
    <section class="card" id="p-wallet" hidden></section>
    <section class="card" id="p-garden" hidden></section>
    <section class="card" id="p-gardener" hidden></section>
    <section class="card" id="p-form" hidden></section>
    <section id="p-preview"></section>
    <section id="p-seq" aria-live="polite"></section>
    <section class="card" id="p-unwind" hidden></section>
    <section id="p-log"></section>`;
  const $ = <T extends HTMLElement>(id: string): T => root.querySelector('#' + id) as T;

  const sessionKey = (): string => `flipgarden:plant:v1:${S.account!.toLowerCase()}`;
  const saveSession = (): void => store.set(sessionKey(), serializeNote({ startBlock: S.startBlock, orderIds: S.orderIds }));
  const loadSession = (): void => {
    const n = parseNote(store.get(sessionKey())); // validated: a corrupt or foreign note is ignored, never trusted
    S.startBlock = n.startBlock;
    S.orderIds = n.orderIds;
  };
  const stepLabel = { approve: 'Approve', deposit: 'Deposit', plant: 'Plant', cancel: 'Prune' } as const;
  const stepperFor = (current?: PlannedTx['kind']): string => {
    if (!S.stepKinds.length || (current && !S.stepKinds.includes(current as (typeof S.stepKinds)[number]))) return '';
    const at = current ? S.stepKinds.indexOf(current) : -1;
    return stepper(S.stepKinds.map((k, i) => ({ label: stepLabel[k as keyof typeof stepLabel] ?? k, state: (at < 0 ? 'todo' : i < at ? 'done' : i === at ? 'current' : 'todo') as StepState })));
  };
  let gardenPanel: ReturnType<typeof mountGardenPanel> | undefined;
  let gardener: ReturnType<typeof mountGardener> | undefined;
  let stopLive: (() => void) | undefined;
  const setBusy = (b: boolean): void => { S.busy = b; gardenPanel?.setBusy(b); };
  const say = (html: string, cls = ''): void => { S.log.unshift(`<li class="${cls}">${html}</li>`); $('p-log').innerHTML = `<section class="card"><h2>What happened</h2><ul class="events">${S.log.join('')}</ul></section>`; };

  // ---------------------------------------------------------------- intro and wallet
  function renderIntro(): void {
    $('p-intro').innerHTML = `
      <h2>Plant a few dollars</h2>
      <p>Spread a small budget over up to ${LIMITS.maxOrdersPerPlant} price levels as <strong>Kuru flip orders</strong>: limit buy orders that, once filled, put the matching sell order in place by themselves. You sign every step in <strong>your own wallet</strong>; with a browser wallet this page never sees a key (a signed-in passkey session is the one exception: its key lives in memory only, see the Passkey tab), and it can only talk to Kuru's contracts and USDC on Monad mainnet.</p>
      <ul class="rules">
        <li>One wallet pop-up per transaction, always preceded by a plain statement of what it does.</li>
        <li>Approvals are for the exact amount, never unlimited. Hard caps: ${usdc(LIMITS.maxDepositUsdc)} USDC per deposit, ${LIMITS.maxOrdersPerPlant} orders and ${usdc(LIMITS.maxNotionalUsdc)} USDC per planting.</li>
        <li>Every transaction is simulated first from your address. If the simulation fails, no pop-up opens.</li>
        <li>You can unwind at any time: cancel all orders and withdraw everything.</li>
      </ul>
      <p class="callout warning" role="note"><strong>Real money: use a throwaway wallet and a few dollars.</strong></p>
      ${deps.fake ? '<p class="note fakebanner" role="status"><strong>Test mode:</strong> a fake wallet and a fake chain in this browser tab. No real network, no real money.</p>' : ''}
      <div id="p-connect"></div>`;
    void renderConnect();
  }

  async function renderConnect(): Promise<void> {
    const host = $('p-connect');
    const provs = [...(deps.extraProviders ?? []), ...(deps.providers ?? (await discover()))];
    if (!provs.length) {
      host.innerHTML = `<p class="warn" role="alert">No browser wallet was found on this page. Open this page in a browser or in a wallet app's built-in browser where your wallet is available, then reload.</p>`;
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
    if (!r.ok) return void ($('p-connect').insertAdjacentHTML('beforeend', `<p class="warn" role="alert">${esc(r.message)}</p>`));
    S.prov = p;
    S.account = r.account;
    S.env = {
      account: r.account,
      wallet: p.provider,
      rpc: new JsonRpc(CHAIN.rpcUrl, { fetch: fetchImpl }),
      sim: new JsonRpc(CHAIN.rpcUrl, { retries: 0, fetch: fetchImpl }),
    };
    loadSession();
    (p.provider as unknown as { on?: (e: string, f: () => void) => void }).on?.('chainChanged', () => void renderWallet());
    (p.provider as unknown as { on?: (e: string, f: () => void) => void }).on?.('accountsChanged', () => location.reload());
    $('p-intro').querySelector('#p-connect')!.innerHTML = `<p>Connected: ${link(addressUrl(r.account), short(r.account))} via ${esc(p.name)}.</p>`;
    $('p-wallet').hidden = false;
    await renderWallet();
    await refreshLive();
    gardener ??= mountGardener($('p-gardener'), {
      env: () => S.env, account: () => S.account, isBusy: () => S.busy, setBusy, store, fake: deps.fake,
      inPageSigner: () => { const p = S.prov?.provider as { isMera?: boolean; unlocked?: boolean } | undefined; return p?.isMera === true && p.unlocked === true; },
      keepAlive: () => (S.prov?.provider as { keepAlive?: () => void } | undefined)?.keepAlive?.(),
      knownIds: () => [...S.orderIds, ...(S.liveIds ?? [])],
      addOrderIds: (ids) => { S.liveIds = [...new Set([...(S.liveIds ?? []), ...ids])]; },
      finish: async () => { await renderWallet(); await refreshLive(); },
      checkEveryMs: deps.fake ? 2_000 : undefined,
    });
    gardener.refresh();
    stopLive?.();
    stopLive = startLive({ run: refreshLive, everyMs: deps.fake ? 3_000 : LIVE_EVERY_MS, canRun: () => !S.busy && S.startBlock !== undefined && S.env !== undefined });
  }

  async function renderWallet(): Promise<void> {
    const host = $('p-wallet');
    const chainId = await walletChainId(S.prov!.provider).catch(() => 0);
    if (chainId !== CHAIN.chainId) {
      host.innerHTML = `<h2>Network</h2><p class="warn" role="alert">Your wallet is on another network (chain id ${chainId || 'unknown'}). This page only works on Monad mainnet (chain id 143).</p><button type="button" class="primary" data-act="switch">Switch to Monad mainnet</button><div id="p-switchmsg"></div>`;
      host.onclick = async (ev) => {
        if (!(ev.target as HTMLElement).closest('[data-act="switch"]')) return;
        const r = await switchToMonad(S.prov!.provider);
        $('p-switchmsg').innerHTML = `<p class="${r.ok ? 'ok' : 'warn'}">${esc(r.message)}</p>`;
        if (r.ok) await renderWallet();
      };
      $('p-form').hidden = true;
      return;
    }
    try {
      S.snap = await readSnapshot(S.env!.rpc, S.account!);
    } catch (e) {
      host.innerHTML = `<h2>Balances</h2><p class="warn" role="alert">Could not read the chain: ${esc((e as Error).message)}</p><button type="button" class="secondary" data-act="refresh">Try again</button>`;
      host.onclick = (ev) => { if ((ev.target as HTMLElement).closest('[data-act="refresh"]')) void renderWallet(); };
      return;
    }
    const s = S.snap;
    const low = s.walletMon < LIMITS.minWalletMon;
    const shown = captureTweens(host); // the numbers on screen now; they glide to the newly read ones
    host.innerHTML = `<h2>Balances</h2>
      <dl class="stats">
        <div class="stat"><dt>Wallet USDC</dt><dd data-tween="walletUsdc">${esc(usdc(s.walletUsdc))}</dd></div>
        <div class="stat"><dt>Wallet MON (pays network fees)</dt><dd data-tween="walletMon">${esc(mon(s.walletMon))}</dd></div>
        <div class="stat"><dt>Free at Kuru (USDC)</dt><dd data-tween="marginUsdc">${esc(usdc(s.marginUsdc))}</dd></div>
        <div class="stat"><dt>Free at Kuru (MON)</dt><dd data-tween="marginMon">${esc(mon(s.marginMon))}</dd></div>
      </dl>
      <p class="help">Money locked inside resting orders is not part of the free balance; the ledger shows it. Block ${s.block.toLocaleString('en-US')}. Best bid ${esc(price(s.book.bestBid))}, best ask ${esc(price(s.book.bestAsk))} USDC per MON.</p>
      ${low ? `<p class="warn" role="alert">The wallet holds less than ${esc(mon(LIMITS.minWalletMon))} MON, which this page requires for network fees.</p>` : ''}
      <button type="button" class="secondary" data-act="refresh">Refresh balances and prices</button>`;
    applyTweens(host, shown);
    host.onclick = (ev) => { if ((ev.target as HTMLElement).closest('[data-act="refresh"]')) void renderWallet().then(() => { renderPreview(); void refreshLive(); }); };
    renderForm();
    renderUnwind();
  }

  // ---------------------------------------------------------------- form and preview
  function renderForm(): void {
    const host = $('p-form');
    if (!host.hidden && host.dataset.ready) return;
    host.hidden = false;
    host.dataset.ready = '1';
    host.innerHTML = `<h2>Plan your planting</h2>
      <label for="f-budget">Budget in USDC (at most ${usdc(LIMITS.maxNotionalUsdc)})</label>
      <input id="f-budget" inputmode="decimal" value="6" autocomplete="off" />
      <p class="help">Each level must hold at least 200 MON (about $5 today), so a bigger budget is needed for more levels.</p>
      <label for="f-levels">Price levels</label>
      <select id="f-levels">${[1, 2, 3].map((n) => `<option value="${n}">${n}</option>`).join('')}</select>
      <fieldset><legend>Where the bids sit</legend>
        <label class="radio"><input type="radio" name="place" value="close" checked /> <span><strong>Right under the best ask</strong>: filled soon (usually within seconds), bought a little dearer, and more exposed to a quick price drop.</span></label>
        <label class="radio"><input type="radio" name="place" value="passive" /> <span><strong>Just above the best bid</strong>: cheaper if it fills, but market-maker bots re-quote several times a second and queue ahead of you, so it may wait a long time.</span></label>
      </fieldset>`;
    host.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(renderPreview, 250); });
    renderPreview();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let previewToken = 0;

  function readForm(): { budget: bigint | null; levels: number; placement: Placement } {
    const raw = ($('p-form').querySelector('#f-budget') as HTMLInputElement).value.trim();
    let budget: bigint | null = null;
    try { budget = parseUnits(raw, USDC_DECIMALS); } catch { budget = null; }
    const levels = Number(($('p-form').querySelector('#f-levels') as HTMLSelectElement).value);
    const placement = (($('p-form').querySelector('input[name="place"]:checked') as HTMLInputElement)?.value ?? 'close') as Placement;
    return { budget, levels, placement };
  }

  function renderPreview(): void {
    const host = $('p-preview');
    if (!S.snap || $('p-form').hidden) { host.innerHTML = ''; return; }
    const f = readForm();
    if (f.budget === null) { S.preview = undefined; host.innerHTML = `<section class="card"><p class="warn" role="alert">Enter the budget as a plain number such as 6 or 12.5 (at most 6 decimals).</p></section>`; return; }
    const p = buildPreview({ market: S.snap.market, book: S.snap.book, budget: f.budget, levels: f.levels, placement: f.placement });
    S.preview = p;
    S.previewNote = '';
    if (!p.ok) { host.innerHTML = `<section class="card"><h2>Preview</h2><ul class="warn" role="alert">${p.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></section>`; return; }
    const rows = p.levels.map((l, i) => `<tr><td data-l="Level">${i + 1}</td><td data-l="Bid price (USDC)">${esc(price(l.price))}</td><td data-l="Flip (sell) price">${esc(price(l.flipPrice))}</td><td data-l="Size (MON)">${esc(l.baseWhole.toString())}</td><td data-l="USDC locked">${esc(usdc(l.locked))}</td><td data-l="Profit, up to (USDC)">${esc(usdc(l.grossPerRoundTrip))}</td></tr>`).join('');
    const sim = ++previewToken;
    host.innerHTML = `<section class="card preview"><h2>Preview <span class="pill open">Preview, nothing sent</span></h2>
      <table class="grid"><thead><tr><th>Level</th><th>Bid price (USDC)</th><th>Flip (sell) price</th><th>Size (MON)</th><th>USDC locked</th><th>Profit, up to (USDC)</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="big"><span>Total locked</span> <strong>${esc(usdc(p.totalLocked))} USDC</strong> · <span>up to</span> <strong>${esc(usdc(p.totalGross))} USDC</strong> <span>per full round trip</span></p>
      <p class="help">Minimum order check: every level holds at least 200 MON (a minimum order costs about ${esc(formatUnits(p.minOrderQuote, USDC_DECIMALS, 2))} USDC at the current ask). Fees: Kuru reads ${esc(p.makerFeeBps.toString())} bps for makers today. "Up to" ignores price moves and assumes both sides fill completely. Prices are from block ${S.snap.block.toLocaleString('en-US')} and move several times a second; they are checked again right before every wallet pop-up.</p>
      <p id="p-sim" class="help">Preview simulation: checking with the contract…</p>
      <h3>Risks, in plain words</h3><ul class="risks">${RISKS.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
      ${stepsHtml(p)}
      <button type="button" class="primary" data-act="plant" ${S.busy ? 'disabled' : ''}>Plant these orders</button>
      <p class="help">Pressing the button does not open your wallet yet. It simulates the first transaction and shows you what it will do and what it costs; you open the pop-up with a second button.</p></section>`;
    host.onclick = (ev) => { if ((ev.target as HTMLElement).closest('[data-act="plant"]')) void runPlant(); };
    void simulatePreview(S.env!.sim, p.levels.map((l) => ({ price: l.price, flipPrice: l.flipPrice, size: l.size }))).then((r) => {
      if (sim !== previewToken) return;
      const el = $('p-sim');
      if (el) el.innerHTML = r.ok ? 'Preview simulation: the contract accepts these orders (simulated from a throwaway address with pretend funds; it does not prove you have the money).' : `<span class="warn">Preview simulation: the contract would reject these orders (${esc(r.reason)}). Refresh the prices and try again.</span>`;
    });
  }

  function stepsHtml(p: Preview): string {
    const s = S.snap!;
    const steps: string[] = [];
    const kinds: typeof S.stepKinds = [];
    const missing = p.totalLocked > s.marginUsdc ? p.totalLocked - s.marginUsdc : 0n;
    if (missing > 0n) {
      if (s.allowance < missing) { steps.push(`approve exactly ${usdc(missing)} USDC`); kinds.push('approve'); }
      steps.push(`deposit ${usdc(missing)} USDC into Kuru`);
      kinds.push('deposit');
    }
    steps.push(`place ${p.levels.length} flip bid${p.levels.length > 1 ? 's' : ''}`);
    kinds.push('plant');
    S.stepKinds = kinds;
    return `${stepperFor()}<p><strong>${steps.length} wallet confirmation${steps.length > 1 ? 's' : ''}, one at a time:</strong> ${steps.map(esc).join(', then ')}.</p>`;
  }

  // ---------------------------------------------------------------- executing steps
  const seq = (html: string): void => { $('p-seq').innerHTML = html; };

  const statement = (kind: PlannedTx['kind'], x: { amount?: bigint; bids?: number; locked?: bigint; ids?: bigint[]; tokens?: string[]; orders?: string[] }): string => {
    switch (kind) {
      case 'approve': return `<strong>Approve exactly ${usdc(x.amount!)} USDC.</strong> This lets Kuru's margin account (${link(addressUrl(CHAIN.marginAccount), short(CHAIN.marginAccount))}) take exactly that amount from your wallet in the next step. Nothing moves yet, and it is not an unlimited approval.`;
      case 'deposit': return `<strong>Deposit ${usdc(x.amount!)} USDC into Kuru's margin account.</strong> The money leaves your wallet and becomes your balance at Kuru. You can take it back at any time with Unwind.`;
      case 'plant': return `<strong>Place ${x.bids} flip bid${x.bids! > 1 ? 's' : ''} on the MON-USDC market.</strong> ${usdc(x.locked!)} USDC of your Kuru balance is locked in them until they fill or you cancel. When a bid fills, Kuru places the matching sell at the flip price by itself.${x.orders?.length ? ` Exactly: ${x.orders.map(esc).join('; ')}.` : ''}`;
      case 'cancel': return `<strong>Cancel ${x.ids!.length} live order${x.ids!.length > 1 ? 's' : ''}</strong> (${x.ids!.map((i) => '#' + i).join(', ')}). What they lock returns to your free balance at Kuru. Nothing is sold.`;
      case 'withdraw': return `<strong>Withdraw everything from Kuru's margin account to your wallet:</strong> ${x.tokens!.map((t) => (t === NATIVE ? 'MON' : 'USDC')).join(' and ')}.`;
    }
  };

  // One transaction. Shows the statement, simulates, shows the gas, and waits for the visitor's button.
  async function step(tx: PlannedTx, text: string, opts: { bids?: { price: bigint; flipPrice: bigint; size: bigint }[] } = {}): Promise<StepResult> {
    seq(`<section class="card"><h2>Next transaction</h2>${stepperFor(tx.kind)}<p>${text}</p><p class="help" id="p-st">Preparing…</p></section>`);
    const r = await sendStep(S.env!, tx, {
      status: (m) => { const el = root.querySelector('#p-st'); if (el) el.textContent = m; },
      announce: (a) => new Promise<boolean>((resolve) => {
        S.announce = { a, resolve };
        const inPage = (S.prov?.provider as { isMera?: boolean } | undefined)?.isMera === true; // passkey session: signed inside this page, no pop-up
        seq(`<section class="card announce"><h2>${inPage ? 'Ready: sign with your passkey session' : 'Ready: one wallet pop-up'}</h2>${stepperFor(tx.kind)}<p>${text}</p>
          <p class="ok">Simulation passed from your address.</p>
          <p>Network fee: up to about <strong>${esc(formatUnits(a.gasMonWei, 18, 6))} MON</strong> (gas limit ${a.gasLimit.toLocaleString('en-US')} at ${esc(formatUnits(a.gasPriceWei / 10n ** 9n, 0))} gwei; Monad charges the limit).</p>
          <div class="actions"><button type="button" class="primary" data-act="go">${inPage ? 'Sign and send' : 'Open the wallet pop-up'}</button><button type="button" class="secondary" data-act="stop">Cancel</button></div>
          <p class="help">${inPage ? 'This button is your confirmation: the page signs this one transaction with your signed-in passkey session. No wallet pop-up will appear.' : 'Check the pop-up shows the same action before you confirm there.'}</p></section>`);
        $('p-seq').scrollIntoView?.({ behavior: 'smooth', block: 'nearest' }); // an action started from the garden card above must not hide its own confirmation
        $('p-seq').onclick = (ev) => {
          const t = (ev.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
          if (!t) return;
          $('p-seq').onclick = null;
          seq(`<section class="card"><p>Waiting for the wallet and the network…</p></section>`);
          resolve(t.dataset.act === 'go');
        };
      }),
    }, opts);
    S.announce = undefined;
    return r;
  }

  const stepFailed = (r: StepResult): boolean => {
    if (r.status === 'confirmed') return false;
    const hash = 'hash' in r ? ` ${link(txUrl(r.hash), short(r.hash))}` : '';
    say(`${esc(r.message)}${hash}`, r.status === 'declined' || r.status === 'rejected' ? 'note' : 'bad');
    seq(`<section class="card ${r.status === 'declined' || r.status === 'rejected' ? '' : 'error'}"><h2>Stopped</h2><p>${esc(r.message)}</p><p class="help">You can press the button again; the page works out where to continue from what is on the chain.</p></section>`);
    return true;
  };

  const report = (what: string, r: Extract<StepResult, { status: 'confirmed' }>, v: Verification): boolean => {
    say(`${esc(what)}: ${link(txUrl(r.hash), short(r.hash))} · network fee ${esc(formatUnits(r.gasPaidWei, 18, 6))} MON · ${v.ok ? esc(v.facts.join(' ')) : esc(v.problems.join(' '))}`, v.ok ? 'ok' : 'bad');
    if (!v.ok) seq(`<section class="card error"><h2>Stopped: cannot explain</h2><p>${v.problems.map(esc).join('<br>')}</p><p>Nothing more will be sent automatically. Open the ledger and the transaction on the explorer; unwinding is still available.</p></section>`);
    return v.ok;
  };

  async function runPlant(): Promise<void> {
    if (S.busy || !S.preview?.ok || !S.env) return;
    setBusy(true);
    try {
      // The preview on screen may be minutes old and the book re-quotes several times a second: read the book again
      // and rebuild the preview from the current form before anything is simulated or offered to the wallet.
      const shown = S.preview.levels.map((l) => `${l.price}:${l.size}`).join();
      S.snap = await readSnapshot(S.env.rpc, S.account!);
      renderPreview();
      const p = S.preview;
      if (!p?.ok) { seq(`<section class="card error"><h2>Cannot plant right now</h2><p>The refreshed preview is not valid (see above). Nothing was sent.</p></section>`); return; }
      if (p.levels.map((l) => `${l.price}:${l.size}`).join() !== shown) say('The order book moved since the preview was built, so the preview was rebuilt from the current prices. The next screen shows the exact orders.', 'note');
      const bids = p.levels.map((l) => ({ price: l.price, flipPrice: l.flipPrice, size: l.size }));
      if (S.liveIds === null) await refreshLive();
      for (let guard = 0; guard < 6; guard++) {
        const snap = await readSnapshot(S.env.rpc, S.account!);
        S.snap = snap;
        const act = nextPlantAction({ lockedNeeded: p.totalLocked, walletUsdc: snap.walletUsdc, walletMon: snap.walletMon, allowance: snap.allowance, marginUsdc: snap.marginUsdc, openOrders: S.liveIds?.length ?? 0 });
        if (act.type === 'blocked') { seq(`<section class="card error"><h2>Cannot continue</h2><p>${esc(act.reason)}</p></section>`); break; }
        if (act.type === 'planted') { seq(`<section class="card"><p>You already have live orders. Unwind them before planting again.</p></section>`); break; }
        // the ledger starts at the block before the first transaction; a half-finished planting keeps its earlier start
        if (S.startBlock === undefined || (S.orderIds.length > 0 && S.liveIds?.length === 0)) { S.startBlock = snap.block - 1; S.orderIds = []; saveSession(); }
        if (act.type === 'approve') {
          const r = await step(planApprove(S.account!, act.amount), statement('approve', { amount: act.amount }));
          if (stepFailed(r)) break;
          if (!report('Approved', r as Extract<StepResult, { status: 'confirmed' }>, await verifyApprove(S.env, act.amount, r as Extract<StepResult, { status: 'confirmed' }>))) break;
        } else if (act.type === 'deposit') {
          const r = await step(planDeposit(S.account!, act.amount), statement('deposit', { amount: act.amount }));
          if (stepFailed(r)) break;
          if (!report('Deposited', r as Extract<StepResult, { status: 'confirmed' }>, await verifyDeposit(S.env, snap, act.amount, r as Extract<StepResult, { status: 'confirmed' }>))) break;
        } else if (act.type === 'plant') {
          const r = await step(planPlant(S.account!, bids), statement('plant', { bids: bids.length, locked: p.totalLocked, orders: p.levels.map((l) => `${l.baseWhole} MON at ${price(l.price)}, flipping to ${price(l.flipPrice)}`) }), { bids });
          if (stepFailed(r)) break;
          const c = r as Extract<StepResult, { status: 'confirmed' }>;
          const v = await verifyPlant(S.env, snap, bids, c);
          S.orderIds = v.orderIds;
          saveSession();
          if (!report('Planted', c, v)) break;
          S.liveIds = v.orderIds;
          renderPlanted();
          break;
        }
      }
    } catch (e) {
      say(`Unexpected error: ${esc((e as Error).message)}`, 'bad');
      seq(`<section class="card error"><h2>Stopped</h2><p>${esc((e as Error).message)}</p></section>`);
    } finally {
      setBusy(false);
      await renderWallet();
      renderUnwind();
    }
  }

  function renderPlanted(): void {
    const href = `#a=${S.account}&s=${S.startBlock}`;
    seq(`<section class="card done"><h2>Planted</h2><p>Your flip bids are on Kuru's order book. Fills show up in the ledger within seconds to minutes depending on the market.</p>
      <p><a class="button primary" href="${esc(href)}">Open the ledger for this wallet</a> <a class="button secondary" href="${esc(`#board&a=${S.account}&s=${S.startBlock}`)}">Join the leaderboard</a></p>
      <p class="help">The ledger reads from block ${S.startBlock?.toLocaleString('en-US')}, the block before your first transaction. Unwind below is always available.</p></section>`);
  }

  // ---------------------------------------------------------------- live orders and unwind
  let gardenFailed = false;
  async function refreshGarden(b: Awaited<ReturnType<typeof fetchBundle>>): Promise<void> {
    try {
      const ledger = ledgerOfBundle(b);
      const span = gardenSpan(ledger, b.market.address);
      const age = await ageSecondsBetween(S.env!.rpc, span.firstBlock, span.lastBlock);
      const lastRead = `Last read ${new Date().toLocaleTimeString('en-GB')} at block ${b.endBlock.toLocaleString('en-US')}. Refreshes about every ${(deps.fake ? 3_000 : LIVE_EVERY_MS) / 1000} seconds while this tab is visible.`;
      $('p-garden').hidden = false;
      gardenPanel ??= mountGardenPanel($('p-garden'), makeGardenActions(actionCtx), { address: S.account!, celebrate: true });
      gardenPanel.update(buildGardenView(ledger, b.market, b.symbols, age), { lastRead });
      gardenFailed = false;
    } catch (e) {
      if (!gardenFailed) say(`The garden view could not be built: ${esc((e as Error).message)}`, 'note');
      gardenFailed = true;
    }
  }

  async function refreshLive(): Promise<void> {
    if (!S.env) return;
    let stage = 'reading your history';
    try {
      let candidates = [...S.orderIds];
      if (S.startBlock !== undefined) {
        const b = await fetchBundle({ account: S.account!, startBlock: S.startBlock, cfg: { ...MAINNET, rpcUrl: CHAIN.rpcUrl, confirmations: 0 }, store, fetchImpl });
        await refreshGarden(b);
        for (const l of b.logs) {
          const e = decodeLog(l);
          if (e && (e.name === 'FlipOrderCreated' || e.name === 'FlippedOrderCreated') && e.owner === S.account!.toLowerCase()) candidates.push(e.orderId);
        }
      }
      candidates = [...new Set(candidates)];
      stage = 'asking the chain which orders are still resting';
      S.liveIds = await liveOrderIds(S.env.rpc, S.account!, candidates);
    } catch (e) {
      S.liveIds = null;
      say(`Could not look up your orders while ${stage}: ${esc((e as Error).message)}`, 'note');
    }
    renderUnwind();
  }

  function renderUnwind(): void {
    const host = $('p-unwind');
    const s = S.snap;
    if (!s || !S.account) { host.hidden = true; return; }
    const live = S.liveIds ?? [];
    const hasMargin = s.marginUsdc > 0n || s.marginMon > 0n;
    if (live.length === 0 && !hasMargin && S.liveIds !== null) { host.hidden = true; return; }
    host.hidden = false;
    host.innerHTML = `<h2>Unwind</h2>
      <p>${S.liveIds === null ? 'Your live orders could not be looked up yet.' : `You have <strong>${live.length}</strong> live order${live.length === 1 ? '' : 's'}`}${hasMargin ? ` and ${esc(usdc(s.marginUsdc))} USDC / ${esc(mon(s.marginMon))} MON free at Kuru` : ''}.</p>
      <p class="help">Unwind cancels every live order, then withdraws everything from Kuru to your wallet. Two transactions at most, each with its own pop-up.</p>
      ${S.startBlock === undefined ? `<label for="u-start">Start block of your planting (so the page can find your orders)</label><input id="u-start" inputmode="numeric" placeholder="e.g. 112209462" />` : ''}
      <div class="actions"><button type="button" class="primary" data-act="unwind" ${S.busy ? 'disabled' : ''}>Unwind: cancel all and withdraw</button><button type="button" class="secondary" data-act="lookup">Look up my orders again</button></div>`;
    host.onclick = (ev) => {
      const t = (ev.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
      if (!t) return;
      const start = host.querySelector('#u-start') as HTMLInputElement | null;
      if (start?.value && /^\d+$/.test(start.value.trim())) { S.startBlock = Number(start.value.trim()); saveSession(); }
      if (t.dataset.act === 'unwind') void runUnwind();
      if (t.dataset.act === 'lookup') void refreshLive();
    };
  }

  async function runUnwind(): Promise<void> {
    if (S.busy || !S.env) return;
    setBusy(true);
    try {
      await refreshLive();
      if (S.liveIds === null) {
        // Never claim "nothing to unwind" when the lookup itself failed.
        seq(`<section class="card error"><h2>Cannot unwind yet</h2><p>Your live orders could not be looked up, so nothing was sent. Try again in a moment; if it keeps failing, enter the start block of your planting below or cancel from Kuru's own interface.</p></section>`);
        return;
      }
      for (let guard = 0; guard < 4; guard++) {
        const snap = await readSnapshot(S.env.rpc, S.account!);
        S.snap = snap;
        const act = nextUnwindAction({ liveOrderIds: S.liveIds ?? [], marginUsdc: snap.marginUsdc, marginMon: snap.marginMon });
        if (act.type === 'done') { seq(`<section class="card done"><h2>Unwound</h2><p>No live orders were found and nothing is left in Kuru's margin account. Open the ledger to double-check; it reads every order of this wallet from the chain.</p>${S.startBlock !== undefined ? `<p><a class="button primary" href="#a=${esc(S.account!)}&s=${S.startBlock}">Open the ledger for this wallet</a></p>` : ''}</section>`); break; }
        if (act.type === 'cancel') {
          const r = await step(planCancel(S.account!, act.ids), statement('cancel', { ids: act.ids }));
          if (stepFailed(r)) break;
          const c = r as Extract<StepResult, { status: 'confirmed' }>;
          if (!report('Cancelled', c, await verifyCancel(S.env, act.ids, c))) break;
          S.liveIds = await liveOrderIds(S.env.rpc, S.account!, act.ids);
        } else {
          const r = await step(planWithdraw(S.account!, act.tokens), statement('withdraw', { tokens: act.tokens }));
          if (stepFailed(r)) break;
          const c = r as Extract<StepResult, { status: 'confirmed' }>;
          if (!report('Withdrawn', c, await verifyWithdraw(S.env, snap, act.tokens, c))) break;
        }
      }
    } catch (e) {
      say(`Unexpected error: ${esc((e as Error).message)}`, 'bad');
      seq(`<section class="card error"><h2>Stopped</h2><p>${esc((e as Error).message)}</p></section>`);
    } finally {
      setBusy(false);
      await renderWallet();
      renderUnwind();
    }
  }

  const actionCtx: ActionCtx = {
    env: () => S.env,
    account: () => S.account,
    isBusy: () => S.busy,
    setBusy,
    step,
    stepFailed,
    report: (what, r, v) => report(what, r, v),
    say,
    seq,
    statement,
    setStepKinds: (k) => { const before = S.stepKinds; S.stepKinds = k; return before; },
    addOrderIds: (ids) => { S.orderIds = [...new Set([...S.orderIds, ...ids])]; saveSession(); S.liveIds = [...new Set([...(S.liveIds ?? []), ...ids])]; },
    finish: async () => { await renderWallet(); await refreshLive(); renderUnwind(); },
  };

  renderIntro();
  return () => { stopLive?.(); gardener?.stop(); };
}
