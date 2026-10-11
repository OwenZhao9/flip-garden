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
  lock: svg('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', 20),
  // bottom tabs
  tabLedger: svg('<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3z"/><path d="M9 8h6M9 12h6"/>', 24),
  tabHedge: svg('<path d="M4 6h7v12H4z"/><path d="M13 8l7 4-7 4z"/>', 24),
  tabBoard: svg('<path d="M8 21h8M12 17v4"/><path d="M7 4h10v5a5 5 0 0 1-10 0V4z"/><path d="M7 6H4v2a3 3 0 0 0 3 3M17 6h3v2a3 3 0 0 1-3 3"/>', 24),
  tabPasskey: svg('<circle cx="8.5" cy="9" r="3.5"/><path d="M11.5 11.5 20 20M16 16l2.5-2.5M14 14l2-2"/>', 24),
  tabPlant: svg('<path d="M12 21v-9"/><path d="M12 13c0-4 2.5-6 7-6 0 4-2.5 6-7 6z"/><path d="M12 15c0-3-2-5-6-5 0 3 2 5 6 5z"/><path d="M7 21h10"/>', 24),
};

// The brand mark: a lime seedling inside a purple double-arrow loop on a violet-black square.
export const logo = (size = 40): string =>
  `<svg class="logo" width="${size}" height="${size}" viewBox="0 0 48 48" role="img" aria-label="Flip Garden logo">
    <rect width="48" height="48" rx="12" fill="#14102B"/>
    <path d="M12 22a13 13 0 0 1 22-7" fill="none" stroke="#836EF9" stroke-width="3" stroke-linecap="round"/>
    <path d="m35 8 .5 8.5L27 15.5" fill="none" stroke="#836EF9" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M36 26a13 13 0 0 1-22 7" fill="none" stroke="#836EF9" stroke-width="3" stroke-linecap="round"/>
    <path d="m13 40-.5-8.5L21 32.5" fill="none" stroke="#836EF9" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M24 32V22" fill="none" stroke="#9BE564" stroke-width="3" stroke-linecap="round"/>
    <path d="M24 23c0-4.5 3-7 8-7 0 4.5-3 7-8 7z" fill="#9BE564"/>
    <path d="M24 26c0-3.5-2.5-5.5-7-5.5 0 3.5 2.5 5.5 7 5.5z" fill="#9BE564"/>
  </svg>`;

export type StepState = 'done' | 'current' | 'todo';

// A progress stepper: one entry per wallet confirmation that will happen, in order.
export function stepper(steps: { label: string; state: StepState }[]): string {
  return `<ol class="stepper" aria-label="Wallet confirmations">${steps
    .map((s, i) => `<li class="${s.state}"${s.state === 'current' ? ' aria-current="step"' : ''}><span class="dot">${s.state === 'done' ? icon.check : i + 1}</span><span class="sl">${s.label}</span></li>`)
    .join('')}</ol>`;
}

// The page frame shared by the ledger and the planting page: brand bar on top, tab bar at the bottom.
export function brandBar(): string {
  return `<div class="brandbar">${logo(40)}<div><div class="brand-name">Flip Garden</div><div class="brand-sub"><span class="live" aria-hidden="true"></span>Monad · Kuru</div></div></div><div id="lockbar"></div>`;
}

export function tabBar(active: 'ledger' | 'plant' | 'passkey' | 'hedge' | 'board'): string {
  return `<nav class="tabbar" aria-label="Pages"><div class="tabbar-in">
    <a href="#" ${active === 'ledger' ? 'aria-current="page"' : ''}>${icon.tabLedger}<span>Ledger</span></a>
    <a href="#plant" ${active === 'plant' ? 'aria-current="page"' : ''}>${icon.tabPlant}<span>Plant</span></a>
    <a href="#hedge" ${active === 'hedge' ? 'aria-current="page"' : ''}>${icon.tabHedge}<span>Hedge</span></a>
    <a href="#board" ${active === 'board' ? 'aria-current="page"' : ''}>${icon.tabBoard}<span>Board</span></a>
    <a href="#passkey" ${active === 'passkey' ? 'aria-current="page"' : ''}>${icon.tabPasskey}<span>Passkey</span></a>
  </div></nav>`;
}
