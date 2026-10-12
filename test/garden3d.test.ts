// The 3D garden, the parts that can be tested without a browser or a GPU: the mapping from the garden view to scene
// parameters, the moments a batch of events plays, the easing curves, and the mount's fallbacks (no WebGL, a scene that
// fails to load, reduced motion).
import test from 'node:test';
import assert from 'node:assert/strict';
import type { GardenEvent } from '../web/src/garden-fx.ts';
import type { GardenView } from '../web/src/garden-view.ts';
import { CELL, MAX_COLS, MAX_FRUITS, cameraDistance, columnsFor, easeOutBack, elevationFor, fruitsFor, hashId, momentsOf, sceneParams, squashStretch } from '../web/src/garden3d-params.ts';
import { hasWebGL, mountGarden3D } from '../web/src/garden3d-mount.ts';

function view(plots: [string, string, number?][]): GardenView {
  return {
    empty: plots.length === 0,
    plots: plots.map(([id, stage, trips]) => ({ id, title: `Plot #${id}`, stage: stage as never, stageLabel: stage, explain: '', summary: '', progress: '', live: [], roundTrips: trips ?? 0 })),
    achievements: [],
    level: { name: 'Seed', index: 0, summary: '', next: '', note: '' },
    progress: null,
    roundTrips: 0,
    notSeenNote: '',
  };
}

test('hashId: stable and spread', () => {
  assert.equal(hashId('5000'), hashId('5000'));
  assert.notEqual(hashId('5000'), hashId('5001'));
  assert.ok(hashId('x') >= 0 && hashId('x') <= 0xffffffff);
});

test('columnsFor: one plot is one column, wide canvases get longer rows, never more than the cap', () => {
  assert.equal(columnsFor(1, 3), 1);
  assert.equal(columnsFor(0, 3), 1);
  assert.ok(columnsFor(6, 3) > columnsFor(6, 1));
  assert.equal(columnsFor(3, 1.35), 3); // a phone still shows three plots in one row
  assert.ok(columnsFor(40, 3) <= MAX_COLS);
  assert.ok(columnsFor(5, NaN) >= 1);
});

test('fruitsFor: only a fruit tree carries fruit, one per completed round trip, capped', () => {
  assert.equal(fruitsFor('flower', 4), 0);
  assert.equal(fruitsFor('fruit', 0), 1);
  assert.equal(fruitsFor('fruit', 3), 3);
  assert.equal(fruitsFor('fruit', 99), MAX_FRUITS);
});

test('sceneParams: one plant per plot, in view order, with stage and fruit from the view only', () => {
  const p = sceneParams(view([['1', 'seed'], ['2', 'fruit', 2], ['3', 'pruned']]), 2.5);
  assert.deepEqual(p.plants.map((x) => [x.id, x.stage, x.fruits]), [['1', 'seed', 0], ['2', 'fruit', 2], ['3', 'pruned', 0]]);
  assert.equal(p.cols * p.rows >= 3, true);
  assert.equal(p.width, p.cols * CELL);
});

test('sceneParams: the garden is centred and plants do not overlap', () => {
  const p = sceneParams(view(Array.from({ length: 11 }, (_, i) => [String(5000 + i), 'sprout'] as [string, string])), 1.4);
  const xs = p.plants.map((x) => x.x);
  const zs = p.plants.map((x) => x.z);
  assert.ok(Math.abs((Math.min(...xs) + Math.max(...xs)) / 2) < CELL);
  assert.ok(Math.abs((Math.min(...zs) + Math.max(...zs)) / 2) < CELL);
  for (let i = 0; i < p.plants.length; i++)
    for (let j = i + 1; j < p.plants.length; j++) {
      const d = Math.hypot(p.plants[i].x - p.plants[j].x, p.plants[i].z - p.plants[j].z);
      assert.ok(d > CELL * 0.6, `plants ${i} and ${j} are ${d} apart`);
    }
});

test('sceneParams: the same plot keeps its phase and place whatever the stage', () => {
  const a = sceneParams(view([['7', 'seed'], ['8', 'seed']]), 2);
  const b = sceneParams(view([['7', 'flower'], ['8', 'seed']]), 2);
  assert.equal(a.plants[0].phase, b.plants[0].phase);
  assert.equal(a.plants[0].x, b.plants[0].x);
  assert.notEqual(a.plants[0].phase, a.plants[1].phase);
});

test('sceneParams: an empty garden has no plants', () => {
  assert.deepEqual(sceneParams(view([]), 2).plants, []);
});

test('momentsOf: a stage change grows, a change to pruned cuts, the big moments throw confetti', () => {
  const v = view([['1', 'sprout'], ['2', 'pruned']]);
  const ev: GardenEvent[] = [
    { type: 'stage-changed', plotId: '1', title: 'Plot #1', from: 'Seed', to: 'Sprout' },
    { type: 'stage-changed', plotId: '2', title: 'Plot #2', from: 'Seed', to: 'Pruned' },
  ];
  assert.deepEqual(momentsOf(ev, v), [{ kind: 'grow', plotId: '1' }, { kind: 'prune', plotId: '2' }]);
  assert.deepEqual(momentsOf([...ev, { type: 'first-fill' }], v).at(-1), { kind: 'confetti' });
  assert.deepEqual(momentsOf([{ type: 'level-up', from: 'Seed', to: 'Sprout', index: 1 }], v), [{ kind: 'confetti' }]);
  assert.deepEqual(momentsOf([], v), []);
});

test('squashStretch: starts from nothing, overshoots, ends exactly at rest', () => {
  assert.ok(squashStretch(0).sy < 0.01);
  assert.deepEqual(squashStretch(1), { sx: 1, sy: 1 });
  assert.deepEqual(squashStretch(5), { sx: 1, sy: 1 });
  const peak = Math.max(...Array.from({ length: 50 }, (_, i) => squashStretch(i / 50).sy));
  assert.ok(peak > 1.05, 'it stretches past full size');
  assert.ok(Math.abs(easeOutBack(1) - 1) < 1e-12);
});

test('cameraDistance and elevationFor: a bigger bed or a narrower canvas moves the camera back', () => {
  const e = elevationFor(1);
  assert.ok(cameraDistance(10, 2, 2, 34, e) > cameraDistance(3, 2, 2, 34, e));
  assert.ok(cameraDistance(6, 2, 1, 34, e) > cameraDistance(6, 2, 3, 34, e));
  assert.ok(elevationFor(3) > elevationFor(1));
  assert.ok(elevationFor(50) <= 0.78);
});

// --- the mount, with a minimal fake document -----------------------------------------------------------------

function fakeDoc(gl: boolean | 'throw') {
  const el = () => ({
    className: '',
    style: {},
    children: [] as unknown[],
    removed: false,
    setAttribute() {},
    appendChild(c: unknown) {
      this.children.push(c);
    },
    remove() {
      this.removed = true;
    },
    getBoundingClientRect: () => ({ width: 600, height: 300 }),
    getContext(kind: string) {
      if (gl === 'throw') throw new Error('no');
      return gl && /webgl/.test(kind) ? {} : null;
    },
  });
  return { createElement: el, visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
}
const win = (reduce: boolean) => ({ matchMedia: (q: string) => ({ matches: reduce && q.includes('reduce') }) });

test('hasWebGL: yes with a context, no without one or when asking throws', () => {
  assert.equal(hasWebGL(fakeDoc(true)), true);
  assert.equal(hasWebGL(fakeDoc(false)), false);
  assert.equal(hasWebGL(fakeDoc('throw')), false);
});

test('mountGarden3D: without WebGL nothing mounts and the SVG garden stays', () => {
  let loaded = false;
  const g = mountGarden3D({ doc: fakeDoc(false) as never, win: win(false) as never, onPick() {}, onState() {}, load: async () => ((loaded = true), {} as never) });
  assert.equal(g, null);
  assert.equal(loaded, false);
});

test('mountGarden3D: a scene that fails to load or to start leaves the panel on the SVG garden', async () => {
  for (const load of [async () => Promise.reject(new Error('offline')), async () => ({ createGardenScene: () => { throw new Error('context'); } })]) {
    let states = 0;
    const g = mountGarden3D({ doc: fakeDoc(true) as never, win: win(false) as never, onPick() {}, onState: () => states++, load: load as never })!;
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(g.ready(), false);
    assert.equal(g.failed(), true);
    assert.equal(states, 1);
    assert.equal((g.el as unknown as { removed: boolean }).removed, true);
    assert.equal(g.play([{ kind: 'confetti' }]), false);
  }
});

test('mountGarden3D: the scene gets the latest view, and reduced motion means still frames and no moments', async () => {
  for (const reduce of [false, true]) {
    const calls: string[] = [];
    let still: boolean | null = null;
    const scene = { update: () => calls.push('update'), highlight: () => calls.push('highlight'), play: () => calls.push('play'), setRunning: (on: boolean) => calls.push(`run:${on}`), resize: () => calls.push('resize'), stats: () => ({ frameMs: 0, renderMs: 0 }), dispose() {} };
    const g = mountGarden3D({ doc: fakeDoc(true) as never, win: win(reduce) as never, onPick() {}, onState() {}, load: async () => ({ createGardenScene: (_c: unknown, o: { still: boolean }) => ((still = o.still), scene) }) as never })!;
    g.update(view([['1', 'seed']])); // before the scene is ready: kept for later
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(g.ready(), true);
    assert.equal(still, reduce);
    assert.ok(calls.includes('update'));
    assert.equal(g.play([{ kind: 'grow', plotId: '1' }]), !reduce);
    assert.equal(calls.includes('play'), !reduce);
  }
});
