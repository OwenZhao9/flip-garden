// The one passkey session shared by every page (tabs switch pages without reloading, so the session survives a tab
// change but never a reload). Holds no secret itself: the key lives inside MeraProvider's signing session, in memory.
import { MeraProvider, browserCeremony, describePasskeyError, DEFAULT_IDLE_MS, PRODUCTION_HOST, type LockReason, type MeraProviderOptions } from './mera-provider.ts';
import { CHAIN } from '../../src/plant.ts';
import { short } from './model.ts';
import { icon } from './ui.ts';

let provider: MeraProvider | null = null;
let overrides: Partial<MeraProviderOptions> = {};

// Test pages only: swap the passkey ceremony and the network before the first use (web/passkey-fake.html).
export function configureMera(o: Partial<MeraProviderOptions>): void {
  overrides = o;
}
let lastLock: LockReason | null = null;

export function mera(): MeraProvider {
  if (!provider) {
    provider = new MeraProvider({
      ceremony: browserCeremony(location.hostname),
      rpcUrl: CHAIN.rpcUrl,
      lifecycle: window,
      onChange: (s) => {
        lastLock = s.unlocked ? null : (s.reason ?? null);
        window.dispatchEvent(new CustomEvent('mera-change'));
      },
      ...overrides,
    });
  }
  return provider;
}

export const isMeraProvider = (p: unknown): p is MeraProvider => (p as { isMera?: boolean } | null)?.isMera === true;

export const LOCK_TEXT: Record<LockReason, string> = {
  button: 'Locked.',
  idle: `Locked after ${DEFAULT_IDLE_MS / 60000} minutes without activity.`,
  'page-hide': 'Locked because the page was hidden.',
  error: 'Locked after an error.',
};

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// Sign-in buttons shared by the lock bar and every page that needs an account. One passkey ceremony either way:
// "Sign in" asks for an existing passkey (the browser finds it by the site, nothing is stored here); "Create passkey"
// is the first time. Errors are shown in plain words next to the buttons.
export function renderSignIn(host: HTMLElement, onDone?: (address: string) => void, compact = false): void {
  const offHost = location.hostname !== PRODUCTION_HOST && !(window as unknown as { __demoDeps?: unknown }).__demoDeps;
  host.innerHTML = `<div class="actions"><button type="button" class="primary" data-act="signin">Sign in with passkey</button><button type="button" class="secondary" data-act="create">Create passkey (first time)</button></div>
    ${compact ? '' : '<p class="help">One prompt with Face ID, Touch ID or your device PIN. No seed phrase, no extension, no email. The same passkey always gives the same account, on any device it syncs to.</p>'}
    ${offHost ? `<p class="warn" role="note">This page runs on <code>${esc(location.hostname)}</code>, not on ${esc(PRODUCTION_HOST)}; a passkey account belongs to the site it was made on.</p>` : ''}
    <div class="signin-msg" role="alert"></div>`;
  let busy = false;
  host.onclick = async (ev) => {
    const b = (ev.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (!b || busy) return;
    busy = true;
    const msg = host.querySelector('.signin-msg')!;
    msg.innerHTML = '<p class="help">Waiting for your passkey…</p>';
    try {
      const address = await mera().unlock(b.dataset.act === 'create' ? 'create' : 'signin');
      msg.innerHTML = '';
      onDone?.(address);
    } catch (e) {
      msg.innerHTML = `<p class="warn">${esc(describePasskeyError(e))}</p>`;
    } finally {
      busy = false;
    }
  };
}

// Account chip (round avatar, short address, Lock) in the brand bar once signed in, so it reads like a signed-in account.
// Signed out, <div id="lockbar"> offers the sign-in buttons (the read-only Ledger keeps working without them).
// Pages without the brand bar slot (<div id="acct">) show the chip in the lockbar instead.
export function renderLockBar(): void {
  const el = document.getElementById('lockbar');
  if (!el) return;
  const acct = document.getElementById('acct');
  const p = provider;
  if (p?.unlocked) {
    const addr = p.address!;
    const h1 = parseInt(addr.slice(2, 5), 16) % 360;
    const h2 = (h1 + 60 + (parseInt(addr.slice(5, 8), 16) % 120)) % 360;
    const chip = `<div class="acct" role="status"><span class="avatar" aria-hidden="true" data-h1="${h1}" data-h2="${h2}"></span><span class="acct-addr" title="Signed in with a passkey">${esc(short(addr))}</span><button type="button" class="acct-lock" data-act="lock" aria-label="Lock" title="Lock">${icon.lock}</button></div>`;
    const host = acct ?? el;
    host.innerHTML = chip;
    if (acct) el.innerHTML = '';
    const av = host.querySelector<HTMLElement>('.avatar')!;
    av.style.background = `linear-gradient(135deg, hsl(${h1} 80% 62%), hsl(${h2} 80% 55%))`;
    host.querySelector('[data-act="lock"]')!.addEventListener('click', () => p.lock('button'));
    return;
  }
  if (acct) acct.innerHTML = '';
  el.innerHTML = `${lastLock ? `<div class="lockbar off" role="status"><span>${esc(LOCK_TEXT[lastLock])}</span></div>` : ''}<div class="lockbar off signin"><span>Not signed in</span><span id="lockbar-signin"></span></div>`;
  renderSignIn(el.querySelector('#lockbar-signin')!, undefined, true);
}
window.addEventListener('mera-change', renderLockBar);
