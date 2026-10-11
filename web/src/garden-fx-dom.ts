// The visible part of the game feel: confetti, the achievement toast, the sparkle ring and the number tween.
// Everything here is decoration over data that already exists. Overlays never take pointer events, so they cannot
// block a button; with reduced motion on, confetti, rings and tweens do nothing (the toast stays as plain text).
import { reducedMotion, tweenText } from './garden-fx.ts';

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const COLORS = ['#9be564', '#836ef9', '#ffc857', '#5fe3a1', '#b3a6ff'];

export function confetti(doc: Document = document, win: Window = window): void {
  if (reducedMotion(win)) return;
  const canvas = doc.createElement('canvas');
  canvas.className = 'fx-confetti';
  canvas.setAttribute('aria-hidden', 'true');
  const w = (canvas.width = win.innerWidth);
  const h = (canvas.height = win.innerHeight);
  doc.body.appendChild(canvas);
  const g = canvas.getContext('2d');
  if (!g) return void canvas.remove();
  const parts = Array.from({ length: 70 }, (_, i) => ({
    x: w / 2 + (Math.random() - 0.5) * w * 0.3,
    y: h * 0.35,
    vx: (Math.random() - 0.5) * 9,
    vy: -4 - Math.random() * 7,
    r: 3 + Math.random() * 4,
    c: COLORS[i % COLORS.length],
    spin: Math.random() * 6,
  }));
  const start = win.performance.now();
  const frame = (now: number): void => {
    const t = now - start;
    g.clearRect(0, 0, w, h);
    g.globalAlpha = Math.max(0, 1 - t / 1900);
    for (const p of parts) {
      p.vy += 0.22;
      p.x += p.vx;
      p.y += p.vy;
      g.fillStyle = p.c;
      g.save();
      g.translate(p.x, p.y);
      g.rotate(p.spin + t / 120);
      g.fillRect(-p.r, -p.r / 2, p.r * 2, p.r);
      g.restore();
    }
    if (t < 1900) win.requestAnimationFrame(frame);
    else canvas.remove();
  };
  win.requestAnimationFrame(frame);
}

// A toast stack that announces itself politely to screen readers.
function toastHost(doc: Document): HTMLElement {
  let el = doc.getElementById('fx-toasts');
  if (!el) {
    el = doc.createElement('div');
    el.id = 'fx-toasts';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    doc.body.appendChild(el);
  }
  return el;
}

export function toast(doc: Document, o: { kicker: string; title: string; iconSvg: string }, ms = 4200): void {
  const host = toastHost(doc);
  while (host.children.length >= 3) host.firstElementChild?.remove();
  const t = doc.createElement('div');
  t.className = 'fx-toast';
  t.innerHTML = `${o.iconSvg}<div><strong>${esc(o.kicker)}</strong><span>${esc(o.title)}</span></div>`;
  host.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

// Grow animation and a sparkle ring on one plot of the panel.
export function growPlot(host: ParentNode, plotId: string, win: Window = window): void {
  if (reducedMotion(win)) return;
  const el = [...host.querySelectorAll<HTMLElement>('.gd-plot')].find((x) => x.dataset.plot === plotId);
  if (!el) return;
  el.classList.remove('gd-grow');
  void el.offsetWidth; // restart the animation if it is already playing
  el.classList.add('gd-grow');
  const ring = el.ownerDocument.createElement('span');
  ring.className = 'gd-ring';
  ring.setAttribute('aria-hidden', 'true');
  ring.innerHTML = '<i></i><i></i><i></i><i></i><i></i><i></i>';
  el.appendChild(ring);
  setTimeout(() => {
    ring.remove();
    el.classList.remove('gd-grow');
  }, 1400);
}

// Move the text of `el` from `from` to its final value. The final frame (and the attribute) is always the value that was read.
const running = new WeakMap<HTMLElement, number>();
export function tweenElement(el: HTMLElement, from: string, to: string, win: Window = window, ms = 600): void {
  const prior = running.get(el);
  if (prior !== undefined) win.cancelAnimationFrame(prior);
  el.dataset.final = to;
  if (reducedMotion(win) || from === to || tweenText(from, to, 0.5) === to) {
    el.textContent = to;
    return;
  }
  el.textContent = from;
  const start = win.performance.now();
  const step = (now: number): void => {
    const t = Math.min(1, (now - start) / ms);
    el.textContent = tweenText(from, to, 1 - (1 - t) ** 3);
    if (t < 1) running.set(el, win.requestAnimationFrame(step));
    else el.textContent = to;
  };
  running.set(el, win.requestAnimationFrame(step));
}

// Before a host's markup is rebuilt, remember what its [data-tween] numbers showed; afterwards animate them to the new values.
export function captureTweens(host: ParentNode): Map<string, string> {
  const m = new Map<string, string>();
  host.querySelectorAll<HTMLElement>('[data-tween]').forEach((e) => m.set(e.dataset.tween!, e.dataset.final ?? e.textContent ?? ''));
  return m;
}
export function applyTweens(host: ParentNode, prev: Map<string, string>, win: Window = window): void {
  host.querySelectorAll<HTMLElement>('[data-tween]').forEach((e) => {
    const from = prev.get(e.dataset.tween!);
    const to = e.textContent ?? '';
    e.dataset.final = to;
    if (from !== undefined && from !== to) tweenElement(e, from, to, win);
  });
}
