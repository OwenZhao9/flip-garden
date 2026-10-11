// The one passkey session shared by every page (tabs switch pages without reloading, so the session survives a tab
// change but never a reload). Holds no secret itself: the key lives inside MeraProvider's signing session, in memory.
import { MeraProvider, browserCeremony, DEFAULT_IDLE_MS, type LockReason, type MeraProviderOptions } from './mera-provider.ts';
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

export const LOCK_TEXT: Record<LockReason, string> = {
  button: 'Locked.',
  idle: `Locked after ${DEFAULT_IDLE_MS / 60000} minutes without activity.`,
  'page-hide': 'Locked because the page was hidden.',
  error: 'Locked after an error.',
};

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// "Signed in as 0x…, Lock" bar. Rendered into <div id="lockbar"> on every page; empty when nobody is signed in.
export function renderLockBar(): void {
  const el = document.getElementById('lockbar');
  if (!el) return;
  const p = provider;
  if (p?.unlocked) {
    el.innerHTML = `<div class="lockbar" role="status"><span>Signed in with a passkey as <strong>${esc(short(p.address!))}</strong></span><button type="button" class="secondary" data-act="lock">Lock</button></div>`;
    el.querySelector('[data-act="lock"]')!.addEventListener('click', () => p.lock('button'));
  } else el.innerHTML = lastLock ? `<div class="lockbar off" role="status"><span>${esc(LOCK_TEXT[lastLock])}</span></div>` : '';
}
window.addEventListener('mera-change', renderLockBar);
