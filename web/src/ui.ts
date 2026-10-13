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
  tabBoard: svg('<path d="M10 14.66v1.626a2 2 0 0 1-.976 1.696A5 5 0 0 0 7 21.978"/><path d="M14 14.66v1.626a2 2 0 0 0 .976 1.696A5 5 0 0 1 17 21.978"/><path d="M18 9h1.5a1 1 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M6 9a6 6 0 0 0 12 0V3a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1z"/><path d="M6 9H4.5a1 1 0 0 1 0-5H6"/>', 24),
  tabPasskey: svg('<path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4"/><path d="M14 13.12c0 2.38 0 6.38-1 8.88"/><path d="M17.29 21.02c.12-.6.43-2.3.5-3.02"/><path d="M2 12a10 10 0 0 1 18-6"/><path d="M2 16h.01"/><path d="M21.8 16c.2-2 .131-5.354 0-6"/><path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2"/><path d="M8.65 22c.21-.66.45-1.32.57-2"/><path d="M9 6.8a6 6 0 0 1 9 5.2v2"/>', 24),
  tabDeposit: svg('<circle cx="12" cy="12" r="10"/><path d="M12 8v8"/><path d="m8 12 4 4 4-4"/>', 24),
  tabPlant: svg('<path d="M14 9.536V7a4 4 0 0 1 4-4h1.5a.5.5 0 0 1 .5.5V5a4 4 0 0 1-4 4 4 4 0 0 0-4 4c0 2 1 3 1 5a5 5 0 0 1-1 3"/><path d="M4 9a5 5 0 0 1 8 4 5 5 0 0 1-8-4"/><path d="M5 21h14"/>', 24),
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
