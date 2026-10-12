// Mounts the 3D garden next to the plot cards. This file has no Three.js in it: the scene (garden3d.ts) is loaded as a
// separate file only when a garden panel exists, and until it is ready, or when WebGL is missing or fails, the panel keeps
// the SVG garden. With reduced motion the scene draws still frames only. Rendering pauses while the tab is hidden or the
// scene is off-screen.
import { reducedMotion } from './garden-fx.ts';
import type { GardenScene } from './garden3d.ts';
import type { Moment } from './garden3d-params.ts';
import type { GardenView } from './garden-view.ts';

type CanvasDoc = { createElement(tag: 'canvas'): { getContext(kind: string): unknown } };

// True when this browser can give a WebGL context at all. Any error counts as no.
export function hasWebGL(doc: CanvasDoc): boolean {
  try {
    const c = doc.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

export type Garden3D = {
  el: HTMLElement; // the persistent container, re-inserted by the panel after every render
  ready(): boolean; // the scene is drawing (false while loading, and for good after a failure)
  update(view: GardenView): void;
  highlight(id: string | null): void;
  play(moments: Moment[]): boolean; // false when nothing could be shown (not ready, still mode, or off-screen)
};

export type Mount3DOptions = {
  doc?: Document;
  win?: Window;
  onPick(id: string): void;
  onState(): void; // the scene became ready or failed: the panel toggles its classes
  load?: () => Promise<{ createGardenScene: typeof import('./garden3d.ts').createGardenScene }>;
};

// The scene is its own file (garden3d.js, built next to the page bundle) so Three.js is fetched only here, and only once.
// The address is computed, so the bundler leaves this import alone instead of inlining Three.js into the page bundle.
const loadScene = (): Promise<{ createGardenScene: typeof import('./garden3d.ts').createGardenScene }> => import(new URL('./garden3d.js', import.meta.url).href);

export function mountGarden3D(o: Mount3DOptions): Garden3D | null {
  const doc = o.doc ?? document;
  const win = o.win ?? window;
  if (!hasWebGL(doc)) return null;
  const still = reducedMotion(win);
  const el = doc.createElement('div');
  el.className = 'gd-3d';
  el.setAttribute('aria-hidden', 'true'); // decoration: every fact is in the plot cards below
  const canvas = doc.createElement('canvas');
  el.appendChild(canvas);
  let scene: GardenScene | null = null;
  let failed = false;
  let view: GardenView | null = null;
  let want: string | null = null;
  let onScreen = true;
  let observers: (() => void)[] = [];
  // a debugging hook for measuring frame time from the console: document.querySelector('.gd-3d').gardenStats()
  Object.assign(el, { gardenStats: () => scene?.stats() ?? null });

  const running = (): boolean => !!scene && onScreen && doc.visibilityState !== 'hidden';
  const sync = (): void => scene?.setRunning(running());
  const fail = (): void => {
    if (failed) return;
    failed = true;
    for (const off of observers) off();
    observers = [];
    try {
      scene?.dispose();
    } catch {
      // already gone
    }
    scene = null;
    el.remove();
    o.onState();
  };

  const start = (mod: { createGardenScene: typeof import('./garden3d.ts').createGardenScene }): void => {
    if (failed) return;
    try {
      scene = mod.createGardenScene(canvas, { still, win, onPick: o.onPick, onFail: fail });
    } catch {
      return fail();
    }
    const size = (): void => {
      const r = el.getBoundingClientRect();
      if (r.width > 1 && r.height > 1) scene?.resize(Math.round(r.width), Math.round(r.height));
    };
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(size);
      ro.observe(el);
      observers.push(() => ro.disconnect());
    }
    if (typeof IntersectionObserver !== 'undefined') {
      const io = new IntersectionObserver((es) => {
        onScreen = es.some((e) => e.isIntersecting);
        sync();
      });
      io.observe(el);
      observers.push(() => io.disconnect());
    }
    const vis = (): void => sync();
    doc.addEventListener('visibilitychange', vis);
    observers.push(() => doc.removeEventListener('visibilitychange', vis));
    o.onState(); // the panel shows the container now, so it has a size
    size();
    try {
      if (view) scene.update(view);
      scene.highlight(want);
      sync();
    } catch {
      fail();
    }
  };

  (o.load ?? loadScene)().then(start, fail);

  return {
    el,
    ready: () => !!scene && !failed,
    update(v) {
      view = v;
      try {
        scene?.update(v);
      } catch {
        fail();
      }
    },
    highlight(id) {
      want = id;
      scene?.highlight(id);
    },
    play(moments) {
      if (!scene || failed || still || !running()) return false;
      try {
        scene.play(moments);
        return true;
      } catch {
        fail();
        return false;
      }
    },
  };
}
