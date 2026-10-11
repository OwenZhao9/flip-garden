// The Passkey page: sign in with Face ID / Touch ID through Mera, see MON, USDC and AUSD, swap a few dollars of USDC
// into AUSD through Kuru Flow. The key lives only in memory for one signing session (web/src/mera-provider.ts).
// Every transaction: quote or plan -> guard -> simulate from your address -> trace where the money goes -> plain statement
// -> YOUR button (that is the confirmation; no wallet pop-up exists on this path) -> sign -> receipt -> verify on chain.
// All logic lives in ../../src; this file is DOM wiring. Every dynamic string is escaped.
import { JsonRpc } from '../../src/rpc.ts';
import { sendStep, type Announcement, type Env, type StepResult, type Verification } from '../../src/flow.ts';
import { CHAIN, USDC_DECIMALS } from '../../src/plant.ts';
import { AUSD, AUSD_DECIMALS, FLOW_ROUTER, MAX_SWAP_USDC, SLIPPAGE_BPS, fetchSwapQuote, nextSwapAction, parseSwapAmount, planSwap, planSwapApprove, readFlowAllowance, readSwapBalances, swapTraceCheck, verifySwap, verifySwapApprove, type SwapQuote } from '../../src/swap.ts';
import { NATIVE, formatUnits } from '../../src/units.ts';
import { PRODUCTION_HOST, describePasskeyError } from './mera-provider.ts';
import { mera } from './session.ts';
import { addressUrl, short, txUrl } from './model.ts';
import { stepper, type StepState } from './ui.ts';

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const usdc = (v: bigint): string => formatUnits(v, USDC_DECIMALS);
const ausd = (v: bigint): string => formatUnits(v, AUSD_DECIMALS);
const mon = (v: bigint): string => formatUnits(v, 18, 6);
const link = (href: string, text: string): string => `<a class="tap" href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>`;

export function mountPasskey(root: HTMLElement, deps: { fetchImpl?: typeof fetch } = {}): () => void {
  const fetchImpl = deps.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const m = mera();
  const rpc = new JsonRpc(CHAIN.rpcUrl, { fetch: fetchImpl });
  const sim = new JsonRpc(CHAIN.rpcUrl, { retries: 0, fetch: fetchImpl });
  const S: { busy: boolean; log: string[]; quote?: SwapQuote; steps: ('swapApprove' | 'swap')[]; snap?: { walletMon: bigint; walletUsdc: bigint; walletAusd: bigint; allowance: bigint } } = { busy: false, log: [], steps: [] };

  root.innerHTML = `
    <section class="card" id="k-intro"></section>
    <section class="card" id="k-balances" hidden></section>
    <section class="card" id="k-swap" hidden></section>
    <section id="k-seq" aria-live="polite"></section>
    <section id="k-log"></section>`;
  const $ = <T extends HTMLElement>(id: string): T => root.querySelector('#' + id) as T;
  const say = (html: string, cls = ''): void => { S.log.unshift(`<li class="${cls}">${html}</li>`); $('k-log').innerHTML = `<section class="card"><h2>What happened</h2><ul class="events">${S.log.join('')}</ul></section>`; };
  const seq = (html: string): void => { $('k-seq').innerHTML = html; };
  const env = (): Env => ({ rpc, sim, wallet: m, account: m.address! });

  // ---------------------------------------------------------------- sign in
  function renderIntro(): void {
    const host = $('k-intro');
    const offHost = location.hostname !== PRODUCTION_HOST;
    if (m.unlocked) {
      host.innerHTML = `<h2>Passkey account</h2><p>Signed in as ${link(addressUrl(m.address!), m.address!)}. The Lock bar at the top ends the session; it also ends by itself after 5 minutes without activity, when the page is hidden, and on reload.</p>
        <p class="help">This is an ordinary Monad address derived from your passkey. The same passkey on this site always gives the same address.</p>`;
      return;
    }
    host.innerHTML = `<h2>Sign in with a passkey</h2>
      <p>Use Face ID, Touch ID or your device PIN instead of a browser wallet. Your passkey gives this page a secret that exists <strong>only in memory</strong> while you are signed in: it is never stored, logged or sent anywhere, and it is wiped when you lock, after 5 minutes of inactivity, when the page is hidden, or on reload.</p>
      <ul class="rules">
        <li>Signing happens inside this page, so there is <strong>no wallet pop-up</strong>. Instead, every transaction is preceded by a plain statement, a simulation and a check of where the money goes, and it is sent only when you press its button.</li>
        <li>Hard caps stay: at most ${usdc(MAX_SWAP_USDC)} USDC per swap, exact approvals only, and the page can only talk to the contracts it lists.</li>
        <li>First time: choose <em>Create passkey</em> (one or two prompts). Next time: <em>Sign in</em>.</li>
      </ul>
      <p class="callout warning" role="note"><strong>Real money: use a few dollars.</strong> Needs Safari or Chrome on iOS 18 or later with iCloud Keychain, Chrome on Android, or desktop Chrome with Google Password Manager (desktop Chrome without it offers only a phone or a USB key and does not work).</p>
      ${offHost ? `<p class="warn" role="alert">This page runs on <code>${esc(location.hostname)}</code>, not on ${esc(PRODUCTION_HOST)}. A passkey account belongs to the host it was created on, so an account made here is a different account.</p>` : ''}
      <div class="actions"><button type="button" class="primary" data-act="signin">Sign in with passkey</button><button type="button" class="secondary" data-act="create">Create passkey</button></div>
      <div id="k-err"></div>`;
    host.onclick = async (ev) => {
      const b = (ev.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
      if (!b || S.busy) return;
      S.busy = true;
      $('k-err').innerHTML = '<p class="help">Waiting for your passkey…</p>';
      try {
        await m.unlock(b.dataset.act === 'create' ? 'create' : 'signin');
        say(`Signed in as ${link(addressUrl(m.address!), short(m.address!))}.`, 'ok');
      } catch (e) {
        $('k-err').innerHTML = `<p class="warn" role="alert">${esc(describePasskeyError(e))}</p>`;
      } finally {
        S.busy = false;
      }
    };
  }

  // ---------------------------------------------------------------- balances and the swap form
  async function renderBalances(): Promise<void> {
    const host = $('k-balances');
    host.hidden = false;
    host.innerHTML = '<h2>Balances</h2><p class="help">Reading the chain…</p>';
    try {
      const a = m.address!;
      const [walletMon, bal, allowance] = await Promise.all([rpc.walletBalance(a, NATIVE), readSwapBalances(rpc, a), readFlowAllowance(rpc, a)]);
      S.snap = { walletMon, ...bal, allowance };
      host.innerHTML = `<h2>Balances</h2><div class="tokens">
        ${[['M', 'MON', mon(walletMon), 'pays network fees'], ['U', 'USDC', usdc(bal.walletUsdc), 'wallet'], ['A', 'AUSD', ausd(bal.walletAusd), 'wallet']]
          .map(([c, sym, v, note]) => `<div class="token"><div class="token-head"><span class="token-sym"><span class="chip" aria-hidden="true">${c}</span>${sym}</span><span class="token-main"><strong>${esc(v)}</strong><span>${esc(note)}</span></span></div></div>`).join('')}
        </div>
        <p class="help">AUSD is Agora's dollar stablecoin (${link(addressUrl(AUSD), short(AUSD))}). To get funds onto Monad, send MON and USDC to the address above from an exchange or a bridge; this page does not move money between chains.</p>
        <button type="button" class="secondary" data-act="refresh">Refresh balances</button>`;
      host.onclick = (ev) => { if ((ev.target as HTMLElement).closest('[data-act="refresh"]')) void renderBalances(); };
      renderSwap();
    } catch (e) {
      host.innerHTML = `<h2>Balances</h2><p class="warn" role="alert">Could not read the chain: ${esc((e as Error).message)}</p><button type="button" class="secondary" data-act="refresh">Try again</button>`;
      host.onclick = (ev) => { if ((ev.target as HTMLElement).closest('[data-act="refresh"]')) void renderBalances(); };
    }
  }

  function renderSwap(): void {
    const host = $('k-swap');
    host.hidden = false;
    if (host.dataset.ready) return;
    host.dataset.ready = '1';
    host.innerHTML = `<h2>Swap USDC to AUSD</h2>
      <p>Buys AUSD with USDC through <strong>Kuru Flow</strong>, the aggregator that finds the best route across Monad's markets. Two transactions at most: an exact-amount approval, then the swap.</p>
      <label for="k-amt">USDC to swap (at most ${usdc(MAX_SWAP_USDC)})</label>
      <input id="k-amt" inputmode="decimal" value="5" autocomplete="off" />
      <p class="help">Slippage allowed: ${SLIPPAGE_BPS / 100}%. The quote is refused if it returns less than 98% of the amount; both coins are dollar stablecoins.</p>
      <div class="actions"><button type="button" class="primary" data-act="quote">Preview the swap</button></div>
      <div id="k-preview"></div>`;
    host.onclick = (ev) => {
      if ((ev.target as HTMLElement).closest('[data-act="quote"]')) void preview();
      if ((ev.target as HTMLElement).closest('[data-act="go"]')) void run();
    };
  }

  const amountNow = (): bigint | null => {
    const r = parseSwapAmount(($('k-swap').querySelector('#k-amt') as HTMLInputElement).value);
    if (!r.ok) { $('k-preview').innerHTML = `<p class="warn" role="alert">${esc(r.message)}</p>`; return null; }
    return r.amount;
  };

  async function preview(): Promise<void> {
    const amount = amountNow();
    if (amount === null || !m.unlocked) return;
    $('k-preview').innerHTML = '<p class="help">Asking Kuru Flow for a route…</p>';
    const q = await fetchSwapQuote(fetchImpl as never, m.address!, amount);
    if (!q.ok) return void ($('k-preview').innerHTML = `<p class="warn" role="alert">${esc(q.message)}</p>`);
    S.quote = q.quote;
    const snap = S.snap!;
    const next = nextSwapAction({ amount, ...snap });
    $('k-preview').innerHTML = `<div class="callout"><p><strong>Preview, not yet sent.</strong> You pay exactly <strong>${esc(usdc(amount))} USDC</strong> and receive about <strong>${esc(ausd(q.quote.output))} AUSD</strong>, never less than <strong>${esc(ausd(q.quote.minOut))} AUSD</strong>.</p>
      <p class="help">The route runs through the Kuru Flow router ${link(addressUrl(q.quote.to), short(q.quote.to))}. Prices move; the quote is fetched again right before the swap itself, and the swap is simulated and traced from your address first.</p></div>
      ${next.type === 'blocked' ? `<p class="warn" role="alert">${esc(next.reason)}</p>` : `<p>${next.type === 'approve' ? 'Step 1 of 2: approve exactly this amount. Step 2: swap.' : 'The approval is already in place; one step left: the swap.'}</p><div class="actions"><button type="button" class="primary" data-act="go">${next.type === 'approve' ? 'Start: approve ' + esc(usdc(amount)) + ' USDC' : 'Swap ' + esc(usdc(amount)) + ' USDC'}</button></div>`}`;
  }

  // ---------------------------------------------------------------- one transaction at a time
  const stepperHtml = (current: 'swapApprove' | 'swap'): string => {
    const label = { swapApprove: 'Approve', swap: 'Swap' } as const;
    const at = S.steps.indexOf(current);
    return S.steps.length > 1 ? stepper(S.steps.map((k, i) => ({ label: label[k], state: (i < at ? 'done' : i === at ? 'current' : 'todo') as StepState }))) : '';
  };

  async function step(kind: 'swapApprove' | 'swap', text: string, tx: Parameters<typeof sendStep>[1], extra: Parameters<typeof sendStep>[3] = {}): Promise<StepResult> {
    seq(`<section class="card"><h2>Next transaction</h2>${stepperHtml(kind)}<p>${text}</p><p class="help" id="k-st">Preparing…</p></section>`);
    return sendStep(env(), tx, {
      status: (s) => { const el = root.querySelector('#k-st'); if (el) el.textContent = s; },
      announce: (a: Announcement) => new Promise<boolean>((resolve) => {
        seq(`<section class="card announce"><h2>Ready: sign with your passkey session</h2>${stepperHtml(kind)}<p>${text}</p>
          <p class="ok">Simulation passed from your address${kind === 'swap' ? ', and a trace shows exactly where the tokens would go' : ''}.</p>
          <p>Network fee: up to about <strong>${esc(formatUnits(a.gasMonWei, 18, 6))} MON</strong> (gas limit ${a.gasLimit.toLocaleString('en-US')} at ${esc(formatUnits(a.gasPriceWei / 10n ** 9n, 0))} gwei; Monad charges the limit).</p>
          <div class="actions"><button type="button" class="primary" data-act="go">Sign and send</button><button type="button" class="secondary" data-act="stop">Cancel</button></div>
          <p class="help">This button is your confirmation. The page signs this one transaction with your signed-in session; no wallet pop-up will appear.</p></section>`);
        $('k-seq').onclick = (ev) => {
          const t = (ev.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
          if (!t) return;
          $('k-seq').onclick = null;
          seq('<section class="card"><p>Signing and waiting for the network…</p></section>');
          resolve(t.dataset.act === 'go');
        };
      }),
    }, extra);
  }

  const failed = (r: StepResult): boolean => {
    if (r.status === 'confirmed') return false;
    const soft = r.status === 'declined' || r.status === 'rejected';
    const hash = 'hash' in r ? ` ${link(txUrl(r.hash), short(r.hash))}` : '';
    say(`${esc(r.message)}${hash}`, soft ? 'note' : 'bad');
    seq(`<section class="card ${soft ? '' : 'error'}"><h2>Stopped</h2><p>${esc(r.message)}</p><p class="help">You can press the button again; the page works out where to continue from what is on the chain.</p></section>`);
    return true;
  };
  const report = (what: string, r: Extract<StepResult, { status: 'confirmed' }>, v: Verification): boolean => {
    say(`${esc(what)}: ${link(txUrl(r.hash), short(r.hash))} · network fee ${esc(formatUnits(r.gasPaidWei, 18, 6))} MON · ${v.ok ? esc(v.facts.join(' ')) : esc(v.problems.join(' '))}`, v.ok ? 'ok' : 'bad');
    if (!v.ok) seq(`<section class="card error"><h2>Stopped: cannot explain</h2><p>${v.problems.map(esc).join('<br>')}</p><p>Nothing more will be sent automatically. Check the transaction on the explorer.</p></section>`);
    return v.ok;
  };

  async function run(): Promise<void> {
    if (S.busy || !m.unlocked) return;
    const amount = amountNow();
    if (amount === null) return;
    S.busy = true;
    try {
      const a = m.address!;
      const [walletMon, bal, allowance] = await Promise.all([rpc.walletBalance(a, NATIVE), readSwapBalances(rpc, a), readFlowAllowance(rpc, a)]);
      let next = nextSwapAction({ amount, walletMon, walletUsdc: bal.walletUsdc, allowance });
      if (next.type === 'blocked') return void ($('k-preview').innerHTML = `<p class="warn" role="alert">${esc(next.reason)}</p>`);
      S.steps = next.type === 'approve' ? ['swapApprove', 'swap'] : ['swap'];
      if (next.type === 'approve') {
        const r = await step('swapApprove', `<strong>Approve exactly ${esc(usdc(next.amount))} USDC.</strong> This lets the Kuru Flow router (${link(addressUrl(FLOW_ROUTER), short(FLOW_ROUTER))}) take exactly that amount from your wallet in the next step. Nothing is swapped yet, and it is not an unlimited approval.`, planSwapApprove(a, next.amount));
        if (failed(r) || r.status !== 'confirmed') return;
        if (!report('Approval', r, await verifySwapApprove(env(), next.amount, r))) return;
      }
      // a fresh quote right before the swap: the route and the minimum may have moved while the user read
      seq('<section class="card"><p class="help">Asking Kuru Flow for a fresh route…</p></section>');
      const q = await fetchSwapQuote(fetchImpl as never, a, amount);
      if (!q.ok) return void seq(`<section class="card error"><h2>Stopped</h2><p>${esc(q.message)}</p></section>`);
      S.quote = q.quote;
      const before = await readSwapBalances(rpc, a);
      const r = await step('swap', `<strong>Swap exactly ${esc(usdc(amount))} USDC for AUSD</strong> at Kuru Flow. You should receive about <strong>${esc(ausd(q.quote.output))} AUSD</strong> and never less than <strong>${esc(ausd(q.quote.minOut))} AUSD</strong>; if the market moves further, the transaction fails and costs only the network fee.`, planSwap(a, q.quote), { extraCheck: swapTraceCheck(sim, a, q.quote) });
      if (failed(r) || r.status !== 'confirmed') return;
      const v = await verifySwap(env(), before, q.quote, r);
      if (report('Swap', r, v)) seq(`<section class="card"><h2>Done</h2><p class="ok">You now hold ${esc(ausd(before.walletAusd + v.received))} AUSD. Both balances were re-read from the chain and match the swap.</p></section>`);
    } catch (e) {
      seq(`<section class="card error"><h2>Stopped</h2><p>${esc(m.unlocked ? (e as Error).message : 'The passkey session ended. Sign in again; nothing more was sent.')}</p></section>`);
    } finally {
      S.busy = false;
      if (m.unlocked) void renderBalances();
    }
  }

  // ---------------------------------------------------------------- follow the session
  const onChange = (): void => {
    renderIntro();
    if (m.unlocked) void renderBalances();
    else {
      $('k-balances').hidden = true;
      $('k-swap').hidden = true;
      $('k-swap').dataset.ready = '';
      seq('');
    }
  };
  window.addEventListener('mera-change', onChange);
  renderIntro();
  if (m.unlocked) void renderBalances();
  return () => window.removeEventListener('mera-change', onChange);
}
