// The one passkey session shared by every page (tabs switch pages without reloading, so the session survives a tab
// change but never a reload). Holds no secret itself: the key lives inside MeraProvider's signing session, in memory.
import { MeraProvider, browserCeremony, describePasskeyError, DEFAULT_IDLE_MS, PRODUCTION_HOST, type LockReason, type MeraProviderOptions } from './mera-provider.ts';
import { CHAIN } from '../../src/plant.ts';
import { short } from './model.ts';

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
  const offHost = location.hostname !== PRODUCTION_HOST;
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

// "Signed in as 0x…, Lock" bar. Rendered into <div id="lockbar"> on every page. Signed out, it offers the sign-in buttons
// (the read-only Ledger keeps working without them).
export function renderLockBar(): void {
  const el = document.getElementById('lockbar');
  if (!el) return;
  const p = provider;
  if (p?.unlocked) {
    el.innerHTML = `<div class="lockbar" role="status"><span>Signed in with a passkey as <strong>${esc(short(p.address!))}</strong></span><button type="button" class="secondary" data-act="lock">Lock</button></div>`;
    el.querySelector('[data-act="lock"]')!.addEventListener('click', () => p.lock('button'));
    return;
  }
  el.innerHTML = `${lastLock ? `<div class="lockbar off" role="status"><span>${esc(LOCK_TEXT[lastLock])}</span></div>` : ''}<div class="lockbar off signin"><span>Not signed in</span><span id="lockbar-signin"></span></div>`;
  renderSignIn(el.querySelector('#lockbar-signin')!, undefined, true);
}
window.addEventListener('mera-change', renderLockBar);
