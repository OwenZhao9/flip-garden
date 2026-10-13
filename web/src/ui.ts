// Shared look: the logo, inline icons and the progress stepper. Pure markup, no logic and no numbers.
// Everything here is a fixed string (no user data), so nothing needs escaping.

const svg = (body: string, size = 20, extra = ''): string =>
  `<svg class="ico" ${extra} width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;

export const icon = {
  // plot tiles
  planted: svg('<path d="M12 21v-8"/><path d="M12 13c0-4 2.5-6 7-6 0 4-2.5 6-7 6z"/><path d="M12 15c0-3-2-5-6-5 0 3 2 5 6 5z"/>', 22),
  harvested: svg('<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.8 2.8L16.5 9.5"/>', 22),
  pruned: svg('<path d="M6 6l12 12M18 6 6 18"/>', 22),
  // statuses and notices
  check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>', 20),
  alert: svg('<path d="M12 4 2.5 20h19L12 4z"/><path d="M12 10v4.5M12 17.5v.01"/>', 20),
  cross: svg('<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>', 20),
  circle: svg('<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>', 20),
  star: svg('<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9L12 3z"/>', 24),
  lock: svg('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', 20),
  // bottom tabs: Lucide icons (ISC licence, https://lucide.dev)
  tabLedger: svg('<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M14 8H8"/><path d="M16 12H8"/><path d="M13 16H8"/>', 24),
  tabHedge: svg('<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>', 24),
  tabBoard: svg('<path d="M6 3.5a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 .5.5V9a6 6 0 0 1-12 0z" fill="currentColor" stroke="none"/><path d="M6 5H4v2a3 3 0 0 0 3 3M18 5h2v2a3 3 0 0 1-3 3"/><path d="M10.5 14.5h3V19h-3z" fill="currentColor" stroke="none"/><rect x="7" y="18.5" width="10" height="3" rx="1.5" fill="currentColor" stroke="none"/>', 24),
  tabPasskey: svg('<path fill-rule="evenodd" fill="currentColor" stroke="none" d="M8 3a5.5 5.5 0 1 0 0 11A5.5 5.5 0 0 0 8 3zm0 3.2a2.3 2.3 0 1 1 0 4.6 2.3 2.3 0 0 1 0-4.6z"/><path d="M12 12l8.5 8.5M16.5 16.5l2.5-2.5M19 19l2-2" stroke-width="3"/>', 24),
  tabDeposit: svg('<circle cx="12" cy="12" r="10"/><path d="M12 8v8"/><path d="m8 12 4 4 4-4"/>', 24),
  // the seedling from the brand logo, as a solid shape that takes the tab colour
  tabPlant: `<svg class="ico" width="26" height="26" viewBox="387 400 480 480" fill="currentColor" aria-hidden="true" focusable="false"><path d="M432 475H452C545 475 612 540 622 630V652C520 652 428 580 421 500C420 485 424 475 432 475Z"/><path d="M823 475H803C710 475 643 540 633 630V652C735 652 827 580 834 500C835 485 831 475 823 475Z"/><path d="M603 640H652V791a24.5 24.5 0 0 1-49 0Z"/></svg>`,
};

// The brand mark: the designed Flip Garden logo (design/logo/flip-garden-logo.png, resized to icons/logo.png).
export const logo = (size = 40): string =>
  `<img class="logo" src="./icons/logo.png" width="${size}" height="${size}" alt="Flip Garden logo" />`;

export type StepState = 'done' | 'current' | 'todo';

// A progress stepper: one entry per wallet confirmation that will happen, in order.
export function stepper(steps: { label: string; state: StepState }[]): string {
  return `<ol class="stepper" aria-label="Wallet confirmations">${steps
    .map((s, i) => `<li class="${s.state}"${s.state === 'current' ? ' aria-current="step"' : ''}><span class="dot">${s.state === 'done' ? icon.check : i + 1}</span><span class="sl">${s.label}</span></li>`)
    .join('')}</ol>`;
}

// The page frame shared by the ledger and the planting page: brand bar on top, tab bar at the bottom.
export function brandBar(): string {
  return `<div class="brandbar">${logo(40)}<div><div class="brand-name">Flip Garden</div><div class="brand-sub"><span class="live" aria-hidden="true"></span>Monad</div></div><div id="acct"></div></div><div id="lockbar"></div>`;
}

export function tabBar(active: 'ledger' | 'deposit' | 'plant' | 'passkey' | 'hedge' | 'board'): string {
  return `<nav class="tabbar" aria-label="Pages"><div class="tabbar-in">
    <a href="#" ${active === 'ledger' ? 'aria-current="page"' : ''}>${icon.tabLedger}<span>Ledger</span></a>
    <a href="#deposit" ${active === 'deposit' ? 'aria-current="page"' : ''}>${icon.tabDeposit}<span>Deposit</span></a>
    <a href="#plant" ${active === 'plant' ? 'aria-current="page"' : ''}>${icon.tabPlant}<span>Plant</span></a>
    <a href="#hedge" ${active === 'hedge' ? 'aria-current="page"' : ''}>${icon.tabHedge}<span>Hedge</span></a>
    <a href="#board" ${active === 'board' ? 'aria-current="page"' : ''}>${icon.tabBoard}<span>Board</span></a>
    <a href="#passkey" ${active === 'passkey' ? 'aria-current="page"' : ''}>${icon.tabPasskey}<span>Passkey</span></a>
  </div></nav>`;
}
