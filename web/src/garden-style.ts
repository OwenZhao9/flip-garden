// Styles for the garden game layer, injected once as a <style> element so the shared style.css stays untouched.
// Only existing tokens are used (var(--...) from style.css); touch targets are at least 44px, text at least 12px.
const CSS = `
.gd-head { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.gd-level { display: inline-flex; align-items: center; gap: 8px; padding: 6px 14px; border-radius: 999px; background: var(--raised); border: 2px solid var(--lime); font-weight: 700; }
.gd-level small { font-weight: 600; color: var(--muted); font-size: 0.875rem; }
.gd-plots { list-style: none; margin: 12px 0 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
.gd-plot { background: var(--raised); border: 1px solid var(--border); border-radius: var(--r-sm); padding: 12px; display: grid; grid-template-columns: 64px 1fr; gap: 4px 12px; align-items: start; min-width: 0; }
.gd-plot .ga { grid-row: 1 / span 2; }
.gd-plot h3 { margin: 0; font-size: 1rem; }
.gd-plot .gd-sub { margin: 0; color: var(--muted); font-size: 0.875rem; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.gd-plot .gd-body { grid-column: 1 / -1; font-variant-numeric: tabular-nums; }
.gd-stage { display: inline-block; padding: 2px 10px; border-radius: 999px; font-weight: 700; font-size: 0.875rem; border: 1px solid currentColor; }
.gd-stage.seed { color: var(--ok); background: var(--ok-bg); }
.gd-stage.sprout { color: var(--lime); background: var(--ok-bg); }
.gd-stage.flower { color: var(--purple-text); background: var(--idle-bg); }
.gd-stage.fruit { color: var(--warn); background: var(--warn-bg); }
.gd-stage.pruned { color: var(--idle); background: var(--idle-bg); border-style: dashed; }
.gd-live { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 4px; }
.gd-live label { display: flex; align-items: center; gap: 10px; min-height: 44px; margin: 0; font-weight: 600; font-size: 1rem; }
.gd-live input[type=checkbox] { width: 24px; min-height: 24px; height: 24px; margin: 0; accent-color: var(--lime); }
.gd-btns { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.gd-btns button { flex: 1 1 96px; min-height: 44px; padding: 8px 12px; }
.gd-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-top: 12px; }
.gd-bar button { min-height: 44px; }
.gd-panel { margin-top: 8px; padding: 12px; border: 1px dashed var(--purple); border-radius: var(--r-sm); background: var(--bg); }
.gd-ach { list-style: none; margin: 8px 0 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 8px; }
.gd-ach li { display: flex; gap: 10px; padding: 10px 12px; border-radius: var(--r-sm); border: 1px solid var(--border); background: var(--raised); min-width: 0; }
.gd-ach li.earned { border-color: var(--ok); background: var(--ok-bg); }
.gd-ach .ico { margin-top: 2px; }
.gd-ach strong { display: block; }
.gd-ach span { color: var(--muted); font-size: 0.875rem; display: block; }
.gd-live-line { color: var(--muted); font-size: 0.875rem; margin-top: 12px; }
.gd-warnnote { color: var(--warn); }

.gd-scene { position: relative; margin-top: 12px; padding: 12px 12px 36px; border-radius: var(--r); overflow: hidden; border: 1px solid var(--border);
  background: linear-gradient(180deg, var(--bg) 0%, color-mix(in srgb, var(--purple) 38%, var(--bg)) 100%); }
.gd-scene::before { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 56px; pointer-events: none;
  background: radial-gradient(28px 12px at 18% 55%, color-mix(in srgb, var(--text) 16%, transparent) 98%, transparent), radial-gradient(40px 14px at 62% 35%, color-mix(in srgb, var(--text) 12%, transparent) 98%, transparent), radial-gradient(22px 9px at 86% 70%, color-mix(in srgb, var(--text) 14%, transparent) 98%, transparent); }
.gd-scene::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 26px; pointer-events: none;
  background: linear-gradient(180deg, color-mix(in srgb, var(--warn) 30%, var(--bg)), color-mix(in srgb, var(--warn) 16%, var(--bg))); border-top: 3px solid color-mix(in srgb, var(--lime) 55%, var(--bg)); }
.gd-scene .gd-plots { position: relative; z-index: 1; margin-top: 0; }
.gd-plot { position: relative; }
.gd-3d { display: none; position: relative; margin: -12px -12px 12px; height: clamp(240px, 40vw, 400px); border-bottom: 1px solid var(--border);
  background: radial-gradient(60% 50% at 78% 18%, color-mix(in srgb, var(--warn) 22%, transparent), transparent 70%),
    linear-gradient(180deg, var(--bg) 0%, color-mix(in srgb, var(--purple) 32%, var(--bg)) 62%, color-mix(in srgb, var(--warn) 20%, color-mix(in srgb, var(--purple) 30%, var(--bg))) 100%); }
.gd-3d canvas { display: block; width: 100%; height: 100%; touch-action: manipulation; }
.gd-3d-on { padding-bottom: 12px; }
.gd-3d-on .gd-3d { display: block; }
.gd-3d-on::before, .gd-3d-on::after { display: none; }
.gd-3d-on .gd-plot { grid-template-columns: 1fr; align-content: start; }
.gd-3d-on .gd-plot > div:first-child { display: none; }
.gd-plot:focus { outline: none; }
.gd-plot { scroll-margin-top: 16px; }
.gd-plot.gd-picked { border-color: var(--lime); box-shadow: 0 0 0 2px var(--lime); }
.gd-prog { margin-top: 8px; display: grid; gap: 8px; }
.gd-prog-row { display: flex; justify-content: space-between; gap: 12px; font-size: 0.875rem; color: var(--muted); font-variant-numeric: tabular-nums; }
.gd-track { height: 10px; border-radius: 999px; background: var(--bg); border: 1px solid var(--border); overflow: hidden; }
.gd-track i { display: block; height: 100%; background: var(--lime); border-radius: 999px; }
.gd-join { font-size: 0.875rem; color: var(--muted); font-weight: 600; text-align: center; }
.gd-sound[aria-pressed=true] { background: var(--raised); border-color: var(--lime); color: var(--lime); }
.gd-ring { position: absolute; left: 44px; top: 44px; width: 0; height: 0; pointer-events: none; }
.gd-ring i { position: absolute; left: -4px; top: -4px; width: 8px; height: 8px; border-radius: 50%; background: var(--warn); opacity: 0; }
.gd-ring i:nth-child(1) { --a: 0deg; } .gd-ring i:nth-child(2) { --a: 60deg; } .gd-ring i:nth-child(3) { --a: 120deg; }
.gd-ring i:nth-child(4) { --a: 180deg; } .gd-ring i:nth-child(5) { --a: 240deg; } .gd-ring i:nth-child(6) { --a: 300deg; }
.fx-confetti { position: fixed; inset: 0; width: 100vw; height: 100vh; pointer-events: none; z-index: 40; }
#fx-toasts { position: fixed; left: 0; right: 0; top: 12px; z-index: 41; display: flex; flex-direction: column; align-items: center; gap: 8px; pointer-events: none; padding: 0 16px; }
.fx-toast { display: flex; align-items: center; gap: 12px; max-width: 420px; width: 100%; padding: 12px 16px; border-radius: var(--r-sm); background: var(--raised); border: 2px solid var(--lime); color: var(--text); box-shadow: 0 8px 28px rgba(10, 8, 24, 0.6); }
.fx-toast .ico { color: var(--warn); flex: none; }
.fx-toast strong { display: block; font-size: 0.875rem; color: var(--lime); text-transform: uppercase; letter-spacing: 0.06em; }
.fx-toast span { display: block; font-weight: 700; }

/* Motion. Every animation and transition lives inside this one block, so a visitor who asks for reduced motion gets a still page. */
@media (prefers-reduced-motion: no-preference) {
  .ga-pulse { transform-box: fill-box; transform-origin: 50% 60%; animation: ga-pulse 2.4s ease-in-out infinite; }
  .ga-sway { transform-box: fill-box; transform-origin: 50% 100%; animation: ga-sway 3.6s ease-in-out infinite; }
  .ga-bob { animation: ga-bob 2.6s ease-in-out infinite; }
  .ga-bob.b2 { animation-delay: -0.9s; } .ga-bob.b3 { animation-delay: -1.7s; }
  .ga-drop { animation: ga-drop 3.4s ease-in infinite; }
  .gd-track i { transition: width 0.8s ease; }
  .gd-grow .ga { animation: gd-grow 0.9s cubic-bezier(0.2, 0.9, 0.3, 1.3); transform-origin: 50% 90%; }
  .gd-grow { animation: gd-flash 1.2s ease-out; }
  .gd-ring i { animation: gd-spark 1.1s ease-out; }
  .fx-toast { animation: fx-toast 4.2s ease both; }
  .gd-btns button, .gd-bar button, .gd-sound { transition: transform 0.12s ease, background 0.12s ease; }
  .gd-scene::before { animation: gd-clouds 40s linear infinite alternate; }
  .gd-plot.gd-picked { animation: gd-flash 1.2s ease-out; }
}
@keyframes ga-pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.12); } }
@keyframes ga-sway { 0%, 100% { transform: rotate(-3deg); } 50% { transform: rotate(3deg); } }
@keyframes ga-bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(1.6px); } }
@keyframes ga-drop { 0% { transform: translate(0, -4px); opacity: 0; } 15% { opacity: 1; } 80% { transform: translate(2px, 5px); opacity: 1; } 100% { transform: translate(3px, 6px); opacity: 0; } }
@keyframes gd-grow { 0% { transform: scale(0.6); } 60% { transform: scale(1.18); } 100% { transform: scale(1); } }
@keyframes gd-flash { 0% { box-shadow: 0 0 0 0 var(--lime); } 100% { box-shadow: 0 0 0 14px transparent; } }
@keyframes gd-spark { 0% { opacity: 1; transform: rotate(var(--a)) translateY(0) scale(1); } 100% { opacity: 0; transform: rotate(var(--a)) translateY(-44px) scale(0.3); } }
@keyframes fx-toast { 0% { opacity: 0; transform: translateY(-16px); } 8%, 88% { opacity: 1; transform: none; } 100% { opacity: 0; transform: translateY(-8px); } }
@keyframes gd-clouds { from { transform: translateX(-6%); } to { transform: translateX(6%); } }
`;

export const GARDEN_CSS = CSS;

export function ensureGardenStyle(doc: Document = document): void {
  if (doc.getElementById('garden-style')) return;
  const el = doc.createElement('style');
  el.id = 'garden-style';
  el.textContent = CSS;
  doc.head.appendChild(el);
}
