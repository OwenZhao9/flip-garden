// Demo entry only: with ?autoplay=1 the page presses its own buttons, one after another, with a visible tap marker, so
// a screen recording shows the whole flow without anyone driving it by hand. It only clicks buttons that exist in the
// real pages; the simulated chain behind them (demo-setup.ts) does the rest.
const sl = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const $$ = <T extends Element>(sel: string): T[] => [...document.querySelectorAll<T>(sel)];
const byText = (sel: string, re: RegExp): HTMLElement | undefined => $$<HTMLElement>(sel).find((e) => re.test(e.textContent ?? ''));

async function waitFor<T>(fn: () => T | null | undefined | false, ms = 20_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() - t0 > ms) throw new Error('autoplay: timed out');
    await sl(150);
  }
}

const dot = document.createElement('div');
dot.style.cssText = 'position:fixed;z-index:9999;width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;background:rgba(155,229,100,.45);border:3px solid #9be564;pointer-events:none;opacity:0;transition:opacity .25s,transform .25s;transform:scale(1.6)';
document.body.appendChild(dot);

async function tap(el: HTMLElement, after = 900): Promise<void> {
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await sl(700);
  const r = el.getBoundingClientRect();
  dot.style.left = r.left + Math.min(r.width / 2, 120) + 'px';
  dot.style.top = r.top + r.height / 2 + 'px';
  dot.style.opacity = '1';
  dot.style.transform = 'scale(1.6)';
  await sl(350);
  dot.style.transform = 'scale(1)';
  await sl(180);
  el.click();
  await sl(250);
  dot.style.opacity = '0';
  await sl(after);
}

async function type(input: HTMLInputElement, text: string): Promise<void> {
  input.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await sl(600);
  input.focus();
  input.value = '';
  for (const c of text) {
    input.value += c;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sl(45);
  }
  input.blur();
  await sl(500);
}

const go = async (hash: string, hold = 1800): Promise<void> => { location.hash = hash; window.scrollTo({ top: 0 }); await sl(hold); };
const read = (el: Element | null): string => el?.textContent ?? '';

// Presses "Sign and send" (the page's own confirmation button) until there is none left to press.
async function confirmAll(root: string, max: number, gap = 2600): Promise<void> {
  for (let i = 0; i < max; i++) {
    const b = await waitFor(() => byText(`${root} button`, /Sign and send/), 4000).catch(() => null);
    if (!b) return;
    await tap(b, gap);
  }
}

export async function autoplay(): Promise<void> {
  await sl(2500);
  // 1. Sign in
  await go('#passkey', 2500);
  await tap(await waitFor(() => $$<HTMLElement>('#lockbar [data-act="signin"]')[0]), 2500);
  await sl(2500);
  // 2. Deposit from another chain
  await go('#deposit', 2000);
  await sl(2500);
  await type(await waitFor(() => document.getElementById('d-refund') as HTMLInputElement | null), '0x7a2f19c4e0b83d5516a9cf30d28b4ee7015bc9d3');
  await tap(await waitFor(() => $$<HTMLElement>('#d-form [data-act="preview"]')[0]), 2500);
  await tap(await waitFor(() => $$<HTMLElement>('[data-act="reserve"]')[0]), 3500);
  await waitFor(() => /Funds arrived/.test(read(document.getElementById('d-track'))), 40_000);
  await sl(3500);
  // 3. Swap USDC to AUSD
  await go('#passkey', 2500);
  await tap(await waitFor(() => $$<HTMLElement>('#passkey-root [data-act="quote"]')[0]), 3000);
  await tap(await waitFor(() => byText('#passkey-root button', /Start: approve/)), 3000);
  await confirmAll('#passkey-root', 3);
  await sl(3000);
  // 4. Plant
  const startBlock = String((window as unknown as { __demo: { kuru: { block: number } } }).__demo.kuru.block - 1);
  await go('#plant', 2500);
  await tap(await waitFor(() => $$<HTMLElement>('#plant-root [data-act="plant"]')[0]), 3500);
  await confirmAll('#plant-root', 3);
  await sl(3000);
  await waitFor(() => !document.getElementById('p-garden')?.hidden, 20_000).catch(() => null);
  (document.getElementById('p-garden') ?? document.body).scrollIntoView({ behavior: 'smooth', block: 'start' });
  await sl(14_000);
  // 5. Hedge
  await go('#hedge', 2500);
  await tap(await waitFor(() => $$<HTMLElement>('#hedge-root [data-act="open"]')[0]), 3500);
  await confirmAll('#hedge-root', 5, 3000);
  await sl(3500);
  // 6. The Gardener
  await go('#plant', 2000);
  const gp = await waitFor(() => document.getElementById('p-gardener'));
  gp.scrollIntoView({ behavior: 'smooth', block: 'start' });
  await sl(1500);
  await tap(await waitFor(() => byText('#p-gardener button', /Set up the Gardener/)), 2500);
  await tap(await waitFor(() => document.querySelector<HTMLElement>('#p-gardener input[value="jev"]')), 1800);
  await tap(await waitFor(() => byText('#p-gardener button', /Review the mandate/)), 3500);
  await tap(await waitFor(() => byText('#p-gardener button', /Start the Gardener/)), 3000);
  gp.scrollIntoView({ behavior: 'smooth', block: 'start' });
  await sl(2500);
  // the market moves up half a percent, so a bid is left behind and the Gardener has something to decide
  const k = (window as unknown as { __demo: { kuru: { bestBid: bigint; bestAsk: bigint } } }).__demo.kuru;
  k.bestBid = (k.bestBid * 1005n) / 1000n / 100n * 100n;
  k.bestAsk = k.bestBid + 500n;
  for (let i = 0; i < 45; i++) {
    const yes = document.querySelector<HTMLElement>('#p-gardener [data-g="yes"]');
    if (yes) await tap(yes, 2500);
    else await sl(500);
  }
  gp.scrollIntoView({ behavior: 'smooth', block: 'start' });
  await sl(5000);
  // 7. Join the board
  await go('#board', 2500);
  await type(await waitFor(() => document.getElementById('b-start') as HTMLInputElement | null), startBlock);
  await tap(await waitFor(() => document.getElementById('b-join')), 3000);
  await tap(await waitFor(() => document.getElementById('b-check')), 3500);
  await sl(4000);
}

if (new URLSearchParams(location.search).get('autoplay') === '1') window.addEventListener('load', () => { void autoplay().catch((e) => console.error(e)); });
