// Page wiring: form -> data layer -> view model -> DOM. No framework; every dynamic string is escaped.
import { EXAMPLE, MAINNET, fetchBundle, isAddress, type Progress, type Store } from './pipeline.ts';
import { addressUrl, buildView, friendlyError, short, txUrl, type View } from './model.ts';
import { t } from './i18n.ts';
import { mountPlant } from './plant.ts';
import { brandBar, icon, tabBar } from './ui.ts';

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const num = (n: number): string => n.toLocaleString('en-US');

const store: Store = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      // private mode or full: the page works without saving
    }
  },
};

const BADGE_ICON: Record<View['status'], string> = { match: icon.check, unexplained: icon.alert, mismatch: icon.cross, empty: icon.circle };
const BADGE_TEXT: Record<View['status'], string> = { match: 'Matches', unexplained: 'Cannot be fully explained', mismatch: 'Does not match', empty: 'Nothing found' };

function shell(): void {
  $('app').innerHTML = `
  ${brandBar()}
  <header class="top">
    <h1>${esc(t('title'))}</h1>
    <p class="lede">${esc(t('tagline'))}</p>
    <p class="note readonly">${esc(t('readOnly'))}</p>
  </header>
  <form id="form" class="card" autocomplete="off" novalidate>
    <label for="addr">${esc(t('address'))}</label>
    <input id="addr" name="addr" inputmode="text" spellcheck="false" placeholder="0x…" />
    <p class="help">${esc(t('addressHelp'))}</p>
    <div class="row">
      <div>
        <label for="start">${esc(t('start'))}</label>
        <input id="start" name="start" inputmode="numeric" placeholder="112209462" />
        <p class="help">${esc(t('startHelp'))}</p>
      </div>
      <div>
        <label for="end">${esc(t('end'))}</label>
        <input id="end" name="end" inputmode="numeric" placeholder="latest" />
        <p class="help">${esc(t('endHelp'))}</p>
      </div>
    </div>
    <div class="actions">
      <button type="submit" id="go" class="primary">${esc(t('read'))}</button>
      <button type="button" id="demo" class="secondary">${esc(t('example'))}</button>
    </div>
    <p class="help">${esc(t('exampleNote'))}</p>
  </form>
  <section id="status" aria-live="polite"></section>
  <section id="result"></section>
  <section id="how" class="card">
    <details>
      <summary>${esc(t('how'))}</summary>
      <div class="prose">
        <p><strong>The core identity.</strong> Inside Kuru, <code>equity = deposits − withdrawals + fill proceeds − fill payments − fees</code>, and <code>equity = free + locked</code>, where <em>locked</em> is what your resting orders reserve. The page recomputes this from events and compares it with what Kuru's contracts report on-chain at the end block. A difference of exactly 0 means every fill, fee and flip was accounted for.</p>
        <p><strong>Whole wallet.</strong> Wallet + Kuru balance changes only through fills, fees and network fees (gas). Deposits, withdrawals, placing and cancelling orders just move value between buckets.</p>
        <p><strong>Flip chains.</strong> When a flip order fills, Kuru creates the opposite order itself, sometimes under a new order id. The ledger links each new order to the fill that created it, so you can follow a plot from planting to harvest.</p>
        <p><strong>Direction of a fill.</strong> The <code>Trade</code> event reports the taker's side. The page shows your side as the resting (maker) order: the opposite of that.</p>
        <p><strong>Profit and loss.</strong> Exact fractions, rounded once at the end toward the smaller number, so a gain is never overstated. <em>Realized</em> counts completed round trips (a buy matched with a sell). <em>Open position</em> is marked two ways: at the mid price (average of best bid and best ask), and at the price you would get selling into the book right now (top of the book only; depth is ignored). Both use the book at the end block.</p>
        <p><strong>Rounding.</strong> What you receive rounds down, what you pay or lock rounds up. Kuru's own rounding for inexact amounts has not been verified, so the check allows one raw unit per inexact conversion and no more. With nothing inexact the difference must be exactly 0.</p>
        <p><strong>Not known yet (shown as "cannot be fully explained", never guessed).</strong> Behavior with non-zero Kuru fees; a filled flip order that produces no new order; unusual partial-fill sequences. Your own taker trades are not modeled.</p>
        <p><strong>Limits.</strong> The wallet's history cannot be looked up directly: the page reads every block from your start block. If the wallet already had orders or balances before that block, the check will not match; start earlier. Gas is counted for transactions that left a Kuru event and for USDC approvals to Kuru; other transactions of the wallet are not counted.</p>
        <p>Full details: <a href="https://github.com/OwenZhao9/flip-garden/blob/main/docs/LEDGER.md" target="_blank" rel="noopener">docs/LEDGER.md</a>. ${esc(t('generated'))}</p>
      </div>
    </details>
  </section>
  ${tabBar('ledger')}`;
}

function statusPanel(html: string): void {
  $('status').innerHTML = html;
}

function progressHtml(p: Progress): string {
  const pct = p.windowsTotal > 0 ? Math.floor((p.windowsDone * 100) / p.windowsTotal) : 0;
  const label =
    p.phase === 'setup'
      ? 'Connecting to the Monad network…'
      : p.phase === 'scan'
        ? `Reading blocks up to ${num(p.block)} (request ${p.windowsDone} of ${p.windowsTotal})`
        : p.phase === 'chain'
          ? 'Checking balances and orders on-chain…'
          : 'Done';
  return `<div class="card working"><p><strong>${esc(t('working'))}</strong> ${esc(label)}</p>
    ${p.cached && p.phase === 'scan' ? `<p class="help">${esc(t('resumed'))}</p>` : ''}
    <progress max="100" value="${pct}">${pct}%</progress>
    <button type="button" id="cancel" class="secondary">${esc(t('cancel'))}</button></div>`;
}

const link = (href: string, text: string): string => `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>`;

function renderView(v: View): void {
  const checks = v.checks
    .map((c) => `<tr class="${c.ok ? 'ok' : 'bad'}"><td data-l="${esc(t('check'))}">${esc(c.label)}</td><td data-l="${esc(t('ledgerSays'))}">${esc(c.ledger)}</td><td data-l="${esc(t('chainSays'))}">${esc(c.chain)}</td><td data-l="${esc(t('difference'))}">${esc(c.diff)}</td></tr>`)
    .join('');
  const issues = v.issues.length
    ? `<h3>${esc(t('notes'))}</h3><ul class="issues">${v.issues.map((i) => `<li class="sev-${i.severity}"><strong>${esc(i.severity)}</strong> ${esc(i.text)} ${i.where ? `<span class="muted">${esc(i.where)}</span>` : ''}</li>`).join('')}</ul>`
    : '';

  const tiles = v.tiles
    .map((x) => `<li class="tile ${x.state}" title="Order #${esc(x.orderId)}">${icon[x.state]}<span class="tp">${esc(x.price)}</span><span class="ts">${esc(x.side)}</span><span class="tl">${esc(x.label)}</span></li>`)
    .join('');

  const bal = v.balances
    .map((b) => `<div class="token"><div class="token-head"><span class="token-sym"><span class="chip" aria-hidden="true">${esc(b.symbol.slice(0, 1))}</span>${esc(b.symbol)}</span><span class="token-main"><strong>${esc(b.wallet)}</strong><span>${esc(t('wallet'))}</span></span></div><dl class="token-sub"><div><dt>${esc(t('free'))}</dt><dd>${esc(b.free)}</dd></div><div><dt>${esc(t('locked'))}</dt><dd>${b.approx ? '≈ ' : ''}${esc(b.locked)}</dd></div><div><dt>${esc(t('equity'))}</dt><dd>${esc(b.equity)}</dd></div></dl></div>`)
    .join('');

  const m = v.money;
  const stat = (label: string, value: string, note = ''): string =>
    `<div class="stat"><dt>${esc(label)}</dt><dd>${esc(value)}</dd>${note ? `<p class="help">${esc(note)}</p>` : ''}</div>`;

  const orders = v.orders
    .map((o) => `<tr class="st-${o.status}${o.depth > 0 ? ' child' : ''}"><td data-l="Order"><span class="indent" style="--d:${o.depth}">${o.depth > 0 ? '↳ ' : ''}#${esc(o.id)}</span></td><td data-l="Side">${esc(o.side)}</td><td data-l="Price">${esc(o.price)}</td><td data-l="Flips to">${esc(o.flipPrice)}</td><td data-l="Size">${esc(o.size)}</td><td data-l="Filled">${esc(o.filled)}</td><td data-l="Status"><span class="pill ${o.status}">${esc(o.statusLabel)}</span></td><td data-l="Origin">${esc(o.origin)}</td><td data-l="Blocks">${esc(o.blocks)}</td></tr>`)
    .join('');

  const fills = v.fills
    .map((f) => `<tr><td data-l="Block">${num(f.block)}</td><td data-l="You">${esc(f.sideLabel)}</td><td data-l="Price">${esc(f.price)}</td><td data-l="Amount">${esc(f.base)}</td><td data-l="Value">${esc(f.quote)}</td><td data-l="Fee">${esc(f.fee)}</td><td data-l="Order">#${esc(f.orderId)}</td><td data-l="Flipped into">${esc(f.flippedTo)}</td><td data-l="Counterparty"><span class="stack">${link(addressUrl(f.takerContract), 'taker ' + short(f.takerContract))}${link(addressUrl(f.initiator), 'sent by ' + short(f.initiator))}</span></td><td data-l="Transaction">${link(txUrl(f.tx), f.txShort)}</td></tr>`)
    .join('');

  $('result').innerHTML = `
  <section class="card badge ${v.status}" role="status">
    <p class="badge-label">${esc(t('reconciliation'))} · <span class="pillx">${BADGE_ICON[v.status]}${esc(BADGE_TEXT[v.status])}</span></p>
    <h2>${esc(v.headline)}</h2>
    <p>${esc(v.detail)}</p>
    <p class="muted">Wallet ${link(addressUrl(v.account), short(v.account))} · market ${esc(v.market)} · blocks ${num(v.range.start)} to ${num(v.range.end)}</p>
    ${v.checks.length ? `<details><summary>${esc(t('showChecks'))}</summary><table class="grid"><thead><tr><th>${esc(t('check'))}</th><th>${esc(t('ledgerSays'))}</th><th>${esc(t('chainSays'))}</th><th>${esc(t('difference'))}</th></tr></thead><tbody>${checks}</tbody></table></details>` : ''}
    ${issues}
  </section>
  ${v.status === 'empty' ? '' : `
  <section class="card"><h2>${esc(t('garden'))}</h2><p class="help">${esc(t('gardenHelp'))}</p><ul class="garden">${tiles}</ul></section>
  <section class="card"><h2>${esc(t('balances'))}</h2>
    <div class="tokens">${bal}</div>
    ${v.netWorth ? `<p class="big"><span>${esc(t('netWorth'))}</span> <strong>${esc(v.netWorth)}</strong></p>` : ''}
    <p class="help">${esc(v.markNote)}</p></section>
  <section class="card full"><h2>${esc(t('money'))}</h2><dl class="stats">
    ${stat(t('quoteChange'), m.quoteChange)}
    ${stat(t('baseChange'), m.baseChange)}
    ${stat(t('gas'), m.gas)}
    ${stat(t('fees'), m.fees)}
    ${stat(t('realized'), m.realized, `${t('realizedHelp')} Round trips: ${m.cycles}.`)}
    ${stat(t('unrealizedMid'), m.unrealizedMid)}
    ${stat(t('unrealizedExec'), m.unrealizedExecutable, m.executableNote)}
    ${stat(t('total'), m.totalMid)}
    ${stat(t('growth'), m.growth, m.growthNote)}
    ${stat(t('baseShare'), m.baseShare)}
    ${stat(t('imbalance'), m.imbalance)}
  </dl></section>
  <section class="card full"><h2>${esc(t('orders'))}</h2><p class="help">${esc(t('ordersHelp'))}</p>
    <table class="grid orders"><thead><tr><th>Order</th><th>Side</th><th>Price</th><th>Flips to</th><th>Size</th><th>Filled</th><th>Status</th><th>Origin</th><th>Blocks</th></tr></thead><tbody>${orders}</tbody></table></section>
  <section class="card full"><h2>${esc(t('fills'))}</h2><p class="help">${esc(t('fillsHelp'))}</p>
    ${v.fills.length ? `<table class="grid fills"><thead><tr><th>Block</th><th>You</th><th>Price</th><th>Amount</th><th>Value</th><th>Fee</th><th>Order</th><th>Flipped into</th><th>Counterparty</th><th>Transaction</th></tr></thead><tbody>${fills}</tbody></table>` : '<p>No fills in this range.</p>'}</section>`}`;
}

let running: AbortController | null = null;

async function run(account: string, startText: string, endText: string): Promise<void> {
  running?.abort();
  $('result').innerHTML = '';
  if (!isAddress(account)) return statusPanel(errorHtml('That does not look like a wallet address: it should be 0x followed by 40 hex characters.'));
  const start = Number(startText.replace(/[,\s_]/g, ''));
  const end = endText.trim() === '' ? undefined : Number(endText.replace(/[,\s_]/g, ''));
  if (!Number.isInteger(start) || start < 0) return statusPanel(errorHtml('Please enter the start block as a whole number, for example 112209462.'));
  if (end !== undefined && (!Number.isInteger(end) || end < start)) return statusPanel(errorHtml('The end block must be a whole number that is not smaller than the start block (or leave it empty).'));
  const ctl = new AbortController();
  running = ctl;
  $<HTMLButtonElement>('go').disabled = true;
  history.replaceState(null, '', `#a=${account.trim()}&s=${start}${end === undefined ? '' : `&e=${end}`}`); // no hashchange, so no re-render
  const show = (p: Progress): void => {
    statusPanel(progressHtml(p));
    document.getElementById('cancel')?.addEventListener('click', () => ctl.abort());
  };
  try {
    const bundle = await fetchBundle({ account, startBlock: start, endBlock: end, cfg: MAINNET, store, signal: ctl.signal, onProgress: show });
    statusPanel('');
    renderView(buildView(bundle));
    $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    const aborted = (e as { name?: string })?.name === 'AbortError';
    statusPanel(aborted ? `<div class="card"><p>${esc(t('cancelled'))}</p></div>` : errorHtml(friendlyError(e)));
  } finally {
    if (running === ctl) running = null;
    $<HTMLButtonElement>('go').disabled = false;
  }
}

const errorHtml = (msg: string): string => `<div class="card error" role="alert"><h2>${esc(t('error'))}</h2><p>${esc(msg)}</p></div>`;

function initLedger(): void {
  shell();
  const addr = $<HTMLInputElement>('addr');
  const start = $<HTMLInputElement>('start');
  const end = $<HTMLInputElement>('end');
  $('form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    void run(addr.value, start.value, end.value);
  });
  $('demo').addEventListener('click', () => {
    addr.value = EXAMPLE.account;
    start.value = String(EXAMPLE.startBlock);
    end.value = String(EXAMPLE.endBlock);
    void run(addr.value, start.value, end.value);
  });
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('a')) {
    addr.value = h.get('a')!;
    start.value = h.get('s') ?? '';
    end.value = h.get('e') ?? '';
    if (start.value) void run(addr.value, start.value, end.value);
  }
}

function route(): void {
  running?.abort();
  if (location.hash.replace(/^#\/?/, '') === 'plant') {
    $('app').innerHTML = `${brandBar()}<header class="top"><h1>${esc(t('title'))}</h1><p class="lede">${esc(t('plantTagline'))}</p></header><div id="plant-root"></div>${tabBar('plant')}`;
    mountPlant($('plant-root'));
  } else initLedger();
}
window.addEventListener('hashchange', route);
route();
