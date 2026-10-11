// The garden panel: plots with their growth stage, a level, achievements and (on the planting page) the per-plot
// actions. DOM wiring only: all numbers arrive already formatted from garden-view.ts, and every action goes through
// the engine behind `GardenActions` (garden-actions.ts), so this file never builds or sends a transaction.
import type { Placement } from '../../src/plant.ts';
import { stageArt } from './garden-art.ts';
import { ensureGardenStyle } from './garden-style.ts';
import type { GardenView } from './garden-view.ts';
import { icon } from './ui.ts';

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export type GardenActions = {
  prune(ids: string[]): Promise<void>;
  harvest(): Promise<void>;
  previewMove(id: string, placement: Placement): Promise<string>; // plain-words preview, built from a fresh book
  move(id: string, placement: Placement): Promise<void>;
};

export type GardenPanel = {
  update(view: GardenView, meta?: { lastRead?: string }): void;
  setBusy(busy: boolean): void;
};

export function mountGardenPanel(host: HTMLElement, actions?: GardenActions): GardenPanel {
  ensureGardenStyle();
  let view: GardenView | null = null;
  let lastRead = '';
  let busy = false;
  let signature = '';
  const selected = new Set<string>();
  let move: { id: string; placement: Placement; text: string } | null = null;

  const render = (): void => {
    if (!view) return;
    const v = view;
    const liveIds = new Set(v.plots.flatMap((p) => p.live.map((o) => o.id)));
    for (const id of [...selected]) if (!liveIds.has(id)) selected.delete(id);
    if (move && !liveIds.has(move.id)) move = null;
    const dis = busy ? ' disabled' : '';

    const plots = v.plots
      .map((p) => {
        const live = actions
          ? `<ul class="gd-live">${p.live.map((o) => `<li><label><input type="checkbox" data-gd="sel" data-id="${esc(o.id)}"${selected.has(o.id) ? ' checked' : ''}${dis} /> <span>${esc(o.line)}</span></label></li>`).join('')}</ul>`
          : p.live.length
            ? `<ul class="gd-live">${p.live.map((o) => `<li>${esc(o.line)}</li>`).join('')}</ul>`
            : '';
        const buttons = actions
          ? `<div class="gd-btns">${
              p.live.length
                ? `<button type="button" class="secondary" data-gd="prune-plot" data-plot="${esc(p.id)}"${dis}>Prune</button>${p.live.filter((o) => o.movable).map((o) => `<button type="button" class="secondary" data-gd="move-open" data-id="${esc(o.id)}"${dis}>Move #${esc(o.id)}</button>`).join('')}`
                : `<button type="button" class="secondary" data-gd="harvest"${dis}>Harvest</button>`
            }</div>`
          : '';
        const panel =
          move && p.live.some((o) => o.id === move!.id)
            ? `<div class="gd-panel" role="group" aria-label="Move order #${esc(move.id)}">
                <p><strong>Move order #${esc(move.id)}:</strong> cancel it, then plant a new bid at a price chosen from the current book. Two steps, each with its own simulation and its own confirmation.</p>
                <label class="radio"><input type="radio" name="gd-place" value="close" data-gd="place"${move.placement === 'close' ? ' checked' : ''}${dis} /> <span>Right under the best ask</span></label>
                <label class="radio"><input type="radio" name="gd-place" value="passive" data-gd="place"${move.placement === 'passive' ? ' checked' : ''}${dis} /> <span>Just above the best bid</span></label>
                <p class="help" id="gd-move-text">${esc(move.text || 'Reading the book…')}</p>
                <div class="gd-btns"><button type="button" class="primary" data-gd="move-go"${dis}>Prune and replant</button><button type="button" class="secondary" data-gd="move-close"${dis}>Close</button></div>
              </div>`
            : '';
        return `<li class="gd-plot"><div>${stageArt(p.stage)}</div><div><h3>${esc(p.title)}</h3><p class="gd-sub">${esc(p.summary)}</p><span class="gd-stage ${p.stage}">${esc(p.stageLabel)}</span></div>
          <div class="gd-body"><p>${esc(p.explain)}</p><p class="gd-sub">${esc(p.progress)}</p>${p.stage === 'fruit' && v.notSeenNote ? `<p class="gd-warnnote">${esc('Not yet seen on real data.')}</p>` : ''}${live}${buttons}${panel}</div></li>`;
      })
      .join('');

    const bar =
      actions && !v.empty
        ? `<div class="gd-bar"><button type="button" class="secondary" data-gd="prune-sel"${selected.size === 0 || busy ? ' disabled' : ''}>Prune selected (${selected.size})</button><button type="button" class="secondary" data-gd="harvest"${dis}>Harvest free money</button></div>
           <p class="help">Prune cancels the chosen resting orders; what they lock returns to your free balance at Kuru. Harvest withdraws everything that is free at Kuru, for the whole account, to your wallet: it returns free money, not profit.</p>`
        : '';

    const ach = v.achievements
      .map((a) => `<li class="${a.earned ? 'earned' : ''}">${a.earned ? icon.check : icon.circle}<div><strong>${esc(a.title)} · ${a.earned ? 'earned' : 'locked'}</strong><span>${esc(a.how)}</span>${a.note ? `<span>${esc(a.note)}</span>` : ''}</div></li>`)
      .join('');

    host.innerHTML = `<h2>Your garden</h2>
      ${v.empty ? '<p>No plots found in the blocks read. Plant something and it grows here.</p>' : ''}
      <div class="gd-head"><span class="gd-level">Level: ${esc(v.level.name)} <small>${esc(v.level.summary)}</small></span></div>
      <p class="help">${esc(v.level.next)} ${esc(v.level.note)}</p>
      ${v.notSeenNote ? `<p class="help">${esc(v.notSeenNote)}</p>` : ''}
      ${v.empty ? '' : `<ul class="gd-plots">${plots}</ul>`}${bar}
      <h3>Achievements</h3><ul class="gd-ach">${ach}</ul>
      <p class="gd-live-line" id="gd-lastread">${esc(lastRead)}</p>`;
  };

  const askPreview = (): void => {
    if (!move || !actions) return;
    const asked = move;
    void actions.previewMove(asked.id, asked.placement).then((text) => {
      if (move !== asked) return;
      asked.text = text;
      const el = host.querySelector('#gd-move-text');
      if (el) el.textContent = text;
    });
  };

  host.addEventListener('change', (ev) => {
    const t = ev.target as HTMLInputElement;
    if (t.dataset.gd === 'sel') {
      if (t.checked) selected.add(t.dataset.id!);
      else selected.delete(t.dataset.id!);
      render();
    } else if (t.dataset.gd === 'place' && move) {
      move = { ...move, placement: t.value as Placement, text: '' };
      render();
      askPreview();
    }
  });
  host.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest('[data-gd]') as HTMLElement | null;
    if (!b || !actions || busy || !view) return;
    switch (b.dataset.gd) {
      case 'prune-plot': {
        const plot = view.plots.find((p) => p.id === b.dataset.plot);
        if (plot) void actions.prune(plot.live.map((o) => o.id));
        break;
      }
      case 'prune-sel':
        if (selected.size) void actions.prune([...selected]);
        break;
      case 'harvest':
        void actions.harvest();
        break;
      case 'move-open':
        move = { id: b.dataset.id!, placement: 'close', text: '' };
        render();
        askPreview();
        break;
      case 'move-close':
        move = null;
        render();
        break;
      case 'move-go':
        if (move) void actions.move(move.id, move.placement);
        break;
    }
  });

  return {
    update(v, meta) {
      const sig = JSON.stringify(v);
      lastRead = meta?.lastRead ?? lastRead;
      view = v;
      if (sig !== signature) {
        signature = sig;
        render();
      } else {
        const el = host.querySelector('#gd-lastread'); // nothing changed: do not rebuild the panel under the visitor's hands
        if (el) el.textContent = lastRead;
      }
    },
    setBusy(b) {
      if (busy === b) return;
      busy = b;
      render();
    },
  };
}
