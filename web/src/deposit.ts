// The Deposit page: bring USDC from another chain to your Monad account with Aurora Intents, then plant.
// This page signs and sends nothing. It asks Aurora for a quote with YOUR Monad address as the recipient, shows a one-time
// deposit address on the other chain, and you send USDC there from your own wallet on that chain (that wallet signs in its
// own pop-up). The page then follows Aurora's status and, on success, re-reads your Monad USDC balance.
// All logic lives in ../../src/aurora.ts; this file is DOM wiring. Every dynamic string is escaped.
import { JsonRpc } from '../../src/rpc.ts';
import { CHAIN, USDC_DECIMALS } from '../../src/plant.ts';
import { MAX_DEPOSIT_USDC, MIN_DEPOSIT_USDC, SOURCES, fetchDepositQuote, fetchDepositStatus, isEvmAddress, parseDepositAmount, readUsdc, verifyArrival, type DepositQuote, type FetchLike, type Source } from '../../src/aurora.ts';
import { formatUnits } from '../../src/units.ts';
import { addressUrl, short } from './model.ts';
import { mera, renderSignIn } from './session.ts';

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const usdc = (v: bigint): string => formatUnits(v, USDC_DECIMALS);
const POLL_MS = 6000;

export function mountDeposit(root: HTMLElement, deps: { fetchImpl?: typeof fetch; pollMs?: number } = {}): () => void {
  const fetchImpl = (deps.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a))) as unknown as FetchLike;
  const m = mera();
  const rpc = new JsonRpc(CHAIN.rpcUrl, { fetch: deps.fetchImpl });
  let timer: ReturnType<typeof setInterval> | null = null;
  let busy = false;
  const stop = (): void => { if (timer !== null) clearInterval(timer); timer = null; };

  root.innerHTML = `<section class="card" id="d-intro"></section><section class="card" id="d-form" hidden></section><section id="d-preview"></section><section id="d-track" aria-live="polite"></section>`;
  const $ = <T extends HTMLElement>(id: string): T => root.querySelector('#' + id) as T;

  function renderIntro(): void {
    $('d-intro').innerHTML = `<h2>Deposit from another chain</h2>
      <p>Move USDC from Base, Arbitrum, Ethereum, Optimism or Polygon to your Monad account with <strong>Aurora Intents</strong> (powered by NEAR Intents), then plant it. The page asks Aurora for a one-time deposit address; <strong>you send the USDC from your own wallet on that chain</strong>, so this page never signs or sends anything here. USDC lands on your Monad address, between ${esc(usdc(MIN_DEPOSIT_USDC))} and ${esc(usdc(MAX_DEPOSIT_USDC))} USDC per deposit.</p>
      ${m.unlocked ? `<p>Funds will arrive at ${`<a class="tap" href="${esc(addressUrl(m.address!))}" target="_blank" rel="noopener">${esc(m.address!)}</a>`}, your passkey account.</p>` : '<p>Sign in first: the funds arrive at your passkey account.</p><div id="d-signin"></div>'}`;
    if (!m.unlocked) renderSignIn($('d-signin'), () => render());
  }

  function renderForm(): void {
    const host = $('d-form');
    host.hidden = !m.unlocked;
    if (!m.unlocked || host.dataset.ready) return;
    host.dataset.ready = '1';
    host.innerHTML = `<h2>What to send</h2>
      <label for="d-src">Chain you are sending from</label>
      <select id="d-src">${SOURCES.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select>
      <label for="d-amt">USDC to send (${esc(usdc(MIN_DEPOSIT_USDC))} to ${esc(usdc(MAX_DEPOSIT_USDC))})</label>
      <input id="d-amt" inputmode="decimal" value="5" autocomplete="off" />
      <label for="d-refund">Your wallet address on that chain</label>
      <input id="d-refund" inputmode="text" spellcheck="false" placeholder="0x…" autocomplete="off" />
      <p class="help">If the deposit cannot be completed, Aurora returns the USDC to this address on that chain. Use the wallet you will send from.</p>
      <div class="actions"><button type="button" class="primary" data-act="preview">Preview the deposit</button></div>`;
    host.onclick = (ev) => { if ((ev.target as HTMLElement).closest('[data-act="preview"]')) void preview(); };
  }

  const read = (): { source: Source; amount: bigint; refundTo: string } | null => {
    const source = SOURCES.find((s) => s.id === ($('d-form').querySelector('#d-src') as HTMLSelectElement).value)!;
    const a = parseDepositAmount(($('d-form').querySelector('#d-amt') as HTMLInputElement).value);
    const refundTo = ($('d-form').querySelector('#d-refund') as HTMLInputElement).value.trim();
    const warn = (t: string): null => { $('d-preview').innerHTML = `<p class="warn" role="alert">${esc(t)}</p>`; return null; };
    if (!a.ok) return warn(a.message);
    if (!isEvmAddress(refundTo)) return warn(`Enter your wallet address on ${source.name} (0x followed by 40 characters) so a failed deposit can be returned.`);
    return { source, amount: a.amount, refundTo };
  };

  async function preview(): Promise<void> {
    const i = read();
    if (!i || !m.unlocked || busy) return;
    busy = true;
    $('d-preview').innerHTML = '<p class="help">Asking Aurora for a price…</p>';
    const q = await fetchDepositQuote(fetchImpl, { ...i, recipient: m.address!, dry: true });
    busy = false;
    if (!q.ok) return void ($('d-preview').innerHTML = `<p class="warn" role="alert">${esc(q.message)}</p>`);
    $('d-preview').innerHTML = `<section class="card"><div class="callout"><p><strong>Preview, nothing reserved yet.</strong> You send <strong>${esc(usdc(q.quote.amountIn))} USDC on ${esc(i.source.name)}</strong> and about <strong>${esc(usdc(q.quote.amountOut))} USDC</strong> arrives on Monad, never less than <strong>${esc(usdc(q.quote.minAmountOut))}</strong>${q.quote.timeEstimateSeconds !== null ? `, usually within about ${q.quote.timeEstimateSeconds} seconds of your deposit` : ''}.</p>
      <p class="help">Aurora's fee is inside these numbers. Your own wallet will also charge a network fee on ${esc(i.source.name)}.</p></div>
      <div class="actions"><button type="button" class="primary" data-act="reserve">Get the deposit address</button></div></section>`;
    $('d-preview').onclick = (ev) => { if ((ev.target as HTMLElement).closest('[data-act="reserve"]')) void reserve(i); };
  }

  async function reserve(i: { source: Source; amount: bigint; refundTo: string }): Promise<void> {
    if (!m.unlocked || busy) return;
    busy = true;
    $('d-preview').innerHTML = '<p class="help">Reserving a deposit address…</p>';
    const account = m.address!;
    const before = await readUsdc(rpc, account).catch(() => null);
    const q = await fetchDepositQuote(fetchImpl, { ...i, recipient: account, dry: false });
    busy = false;
    if (!q.ok || q.quote.depositAddress === null) return void ($('d-preview').innerHTML = `<p class="warn" role="alert">${esc(q.ok ? 'No deposit address.' : q.message)}</p>`);
    if (before === null) return void ($('d-preview').innerHTML = '<p class="warn" role="alert">Could not read your Monad balance first, so the arrival could not be checked. Nothing was reserved by you; try again.</p>');
    $('d-preview').innerHTML = '';
    track(i.source, q.quote, before, account);
  }

  function track(source: Source, q: DepositQuote, before: bigint, account: string): void {
    stop();
    const addr = q.depositAddress!;
    const until = q.deadline ? new Date(q.deadline).toLocaleTimeString() : '';
    $('d-track').innerHTML = `<section class="card announce"><h2>Send USDC now</h2>
      <ol class="rules"><li>Open your wallet on <strong>${esc(source.name)}</strong>.</li>
        <li>Send exactly <strong>${esc(usdc(q.amountIn))} USDC</strong> (the USDC token on ${esc(source.name)}, nothing else) to this address:</li></ol>
      <p><code id="d-addr">${esc(addr)}</code> <button type="button" class="secondary" data-act="copy">Copy address</button></p>
      <p class="callout warning" role="note">This address is for this one deposit${until ? ` and expires at ${esc(until)}` : ''}. Send only USDC on ${esc(source.name)}, once, from the wallet you gave as the refund address. Any other token or chain may be lost.</p>
      <p id="d-status" class="help">Waiting for your deposit…</p></section>`;
    $('d-track').onclick = (ev) => {
      if ((ev.target as HTMLElement).closest('[data-act="copy"]')) void navigator.clipboard?.writeText(addr).catch(() => { /* the address is on the page to copy by hand */ });
    };
    const say = (t: string): void => { const el = root.querySelector('#d-status'); if (el) el.textContent = t; };
    let checking = false;
    timer = setInterval(async () => {
      if (checking) return;
      checking = true;
      try {
        const s = await fetchDepositStatus(fetchImpl, addr);
        if (s.state === 'waiting') return say('Waiting for your deposit…');
        if (s.state === 'processing') return say('Deposit seen. Aurora is moving it to Monad…');
        stop();
        if (s.state === 'refunded') return void ($('d-track').innerHTML = `<section class="card"><h2>Refunded</h2><p>Aurora returned the deposit to your ${esc(source.name)} wallet. Nothing arrived on Monad and nothing is lost.</p></section>`);
        if (s.state === 'failed') return void ($('d-track').innerHTML = `<section class="card error"><h2>Stopped</h2><p>Aurora reports that the deposit failed. If you sent funds, check your wallet and Aurora's support; nothing else will be sent from this page.</p></section>`);
        const after = await readUsdc(rpc, account).catch(() => null);
        const v = after === null ? null : verifyArrival(before, after, q);
        $('d-track').innerHTML = v?.ok
          ? `<section class="card"><h2>Funds arrived</h2><p class="ok">${esc(v.message)} The balance was re-read from Monad.</p><p><a class="button primary" href="#plant">Plant it</a></p></section>`
          : `<section class="card ${v ? 'error' : ''}"><h2>${v ? 'Check the balance' : 'Aurora says done'}</h2><p>${esc(v ? v.message : 'Aurora reports success, but your Monad balance could not be read just now. Reload and check the Plant page.')}</p></section>`;
      } finally {
        checking = false;
      }
    }, deps.pollMs ?? POLL_MS);
  }

  function render(): void {
    renderIntro();
    renderForm();
  }
  const onChange = (): void => {
    if (!m.unlocked) { stop(); $('d-form').dataset.ready = ''; $('d-preview').innerHTML = ''; $('d-track').innerHTML = ''; }
    render();
  };
  window.addEventListener('mera-change', onChange);
  render();
  return () => { stop(); window.removeEventListener('mera-change', onChange); };
}
