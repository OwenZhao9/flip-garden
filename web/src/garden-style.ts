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
.ga-soil { fill: var(--surface); stroke: var(--border); stroke-width: 1.5; }
.ga-seed { fill: var(--warn); }
.ga-line { fill: none; stroke: var(--warn-bg); stroke-width: 1.5; stroke-linecap: round; }
.ga-stem { fill: none; stroke: var(--lime); stroke-width: 3; stroke-linecap: round; }
.ga-leaf { fill: var(--lime); }
.ga-petal circle { fill: var(--purple); }
.ga-core { fill: var(--warn); }
.ga-trunk { fill: none; stroke: var(--warn); stroke-width: 4; stroke-linecap: round; }
.ga-canopy { fill: var(--ok); }
.ga-fruit { fill: var(--warn); stroke: var(--bg); stroke-width: 1.2; }
.ga-cut { fill: none; stroke: var(--bad); stroke-width: 3; stroke-linecap: round; }
.ga-fallen { fill: none; stroke: var(--idle); stroke-width: 3; stroke-linecap: round; stroke-dasharray: 3 4; }
`;

export function ensureGardenStyle(doc: Document = document): void {
  if (doc.getElementById('garden-style')) return;
  const el = doc.createElement('style');
  el.id = 'garden-style';
  el.textContent = CSS;
  doc.head.appendChild(el);
}
