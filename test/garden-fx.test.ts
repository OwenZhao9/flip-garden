// Game feel, the parts that can be tested without a browser: the comparison of two garden views, what was already
// celebrated per wallet, the number tween, the sound switch, the level progress bars and the reduced-motion rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DAY_SECONDS, levelProgress } from '../src/garden.ts';
import { defaultStore, diffGarden, freshEvents, loadSeen, markSeen, parseShown, reducedMotion, saveSeen, seenFromView, tweenText, type GardenEvent } from '../web/src/garden-fx.ts';
import { applyTweens, captureTweens, confetti, growPlot, tweenElement } from '../web/src/garden-fx-dom.ts';
import { createSound } from '../web/src/garden-sound.ts';
import { GARDEN_CSS } from '../web/src/garden-style.ts';
import type { GardenView } from '../web/src/garden-view.ts';

const ACH = ['first-planting', 'first-fill', 'first-round-trip', 'three-plots', 'seven-days', 'first-prune', 'first-harvest'];
function view(o: { plots?: [string, string][]; earned?: string[]; level?: [string, number] } = {}): GardenView {
  const [name, index] = o.level ?? ['Seed', 0];
  return {
    empty: !o.plots?.length,
    plots: (o.plots ?? []).map(([id, stage]) => ({ id, title: `Plot #${id}`, stage: stage as never, stageLabel: stage[0].toUpperCase() + stage.slice(1), explain: '', summary: '', progress: '', live: [], roundTrips: 0 })),
    achievements: ACH.map((id) => ({ id, title: id, how: '', earned: (o.earned ?? []).includes(id), note: '' })),
    level: { name, index, summary: '', next: '', note: '' },
    progress: null,
    roundTrips: 0,
    notSeenNote: '',
  };
}
const types = (e: GardenEvent[]): string[] => e.map((x) => x.type);

test('diffGarden: the first view of a page reports nothing', () => {
  assert.deepEqual(diffGarden(null, view({ plots: [['1', 'fruit']], earned: ACH, level: ['Orchard', 3] })), []);
});

test('diffGarden: an unchanged garden reports nothing', () => {
  const v = view({ plots: [['1', 'seed']], earned: ['first-planting'] });
  assert.deepEqual(diffGarden(v, structuredClone(v)), []);
});

test('diffGarden: a stage change names the plot and both stages', () => {
  const ev = diffGarden(view({ plots: [['1', 'seed'], ['2', 'flower']] }), view({ plots: [['1', 'sprout'], ['2', 'flower']] }));
  assert.deepEqual(ev, [{ type: 'stage-changed', plotId: '1', title: 'Plot #1', from: 'Seed', to: 'Sprout' }]);
});

test('diffGarden: a plot that is new in the garden is not a stage change', () => {
  assert.deepEqual(diffGarden(view({ plots: [['1', 'seed']] }), view({ plots: [['1', 'seed'], ['2', 'seed']] })), []);
});

test('diffGarden: the first fill reports the achievement and the first-fill moment', () => {
  const ev = diffGarden(view({ plots: [['1', 'seed']], earned: ['first-planting'] }), view({ plots: [['1', 'sprout']], earned: ['first-planting', 'first-fill'] }));
  assert.deepEqual(types(ev), ['stage-changed', 'achievement-earned', 'first-fill']);
});

test('diffGarden: an earned achievement and a level-up are reported once, with the new level', () => {
  const ev = diffGarden(view({ earned: ['first-planting'] }), view({ earned: ['first-planting', 'seven-days'], level: ['Sprout', 1] }));
  assert.deepEqual(ev, [
    { type: 'achievement-earned', id: 'seven-days', title: 'seven-days' },
    { type: 'level-up', from: 'Seed', to: 'Sprout', index: 1 },
  ]);
});

test('diffGarden: a level going down or an achievement being lost is not a moment', () => {
  assert.deepEqual(diffGarden(view({ earned: ['first-fill'], level: ['Sprout', 1] }), view()), []);
});

test('celebrations are remembered per wallet, case-insensitively, and nothing replays', () => {
  const mem = new Map<string, string>();
  const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
  const first = view({ earned: ['first-planting', 'first-fill'], level: ['Sprout', 1] });
  saveSeen(store, '0xABC', seenFromView(first, loadSeen(store, '0xABC')));
  assert.deepEqual(loadSeen(store, '0xabc'), { achievements: ['first-planting', 'first-fill'], level: 1 });
  assert.deepEqual(loadSeen(store, '0xdef'), { achievements: [], level: 0 }, 'another wallet has its own memory');

  const seen = loadSeen(store, '0xabc');
  const events = diffGarden(view(), first); // the same facts arriving as a "change" must not play again
  assert.deepEqual(freshEvents(events, seen), []);

  const next = diffGarden(first, view({ earned: ['first-planting', 'first-fill', 'first-round-trip'], level: ['Bloom', 2] }));
  const fresh = freshEvents(next, seen);
  assert.deepEqual(types(fresh), ['achievement-earned', 'level-up']);
  assert.deepEqual(markSeen(seen, fresh), { achievements: ['first-planting', 'first-fill', 'first-round-trip'], level: 2 });
});

test('the memory is optional: a missing, throwing or corrupt store changes nothing but the memory', () => {
  const boom = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('full'); } };
  assert.deepEqual(loadSeen(boom, '0x1'), { achievements: [], level: 0 });
  assert.doesNotThrow(() => saveSeen(boom, '0x1', { achievements: [], level: 0 }));
  assert.deepEqual(loadSeen(null, '0x1'), { achievements: [], level: 0 });
  assert.doesNotThrow(() => saveSeen(null, '0x1', { achievements: [], level: 0 }));
  assert.deepEqual(loadSeen({ getItem: () => '{not json', setItem: () => {} }, '0x1'), { achievements: [], level: 0 });
  assert.deepEqual(loadSeen({ getItem: () => '{"achievements":[1,"a"],"level":"x"}', setItem: () => {} }, '0x1'), { achievements: ['a'], level: 0 });
  assert.doesNotThrow(() => defaultStore(), 'looking for the storage never throws');
});

test('number tween: the last frame is exactly the value that was read', () => {
  assert.equal(tweenText('10.00', '20.00', 0), '10.00');
  assert.equal(tweenText('10.00', '20.00', 0.5), '15.00');
  assert.equal(tweenText('10.00', '20.00', 1), '20.00');
  assert.equal(tweenText('1,000.5', '2,000.25', 0.5), '1,500.38');
  assert.equal(tweenText('5', '1,234,567.123456', 1), '1,234,567.123456');
  assert.equal(tweenText('9.5', '0.000001', 1), '0.000001');
  assert.equal(tweenText('?', '12.5', 0.3), '12.5', 'not a number: shown as read');
  assert.equal(tweenText('5.0', 'n/a', 0.3), 'n/a');
  assert.deepEqual(parseShown('1,234.560'), { value: 1234.56, decimals: 3 });
  assert.equal(parseShown('12 MON'), null);
});

test('reducedMotion: only an explicit "no preference" turns motion on', () => {
  assert.equal(reducedMotion({ matchMedia: () => ({ matches: true }) }), true);
  assert.equal(reducedMotion({ matchMedia: () => ({ matches: false }) }), false);
  assert.equal(reducedMotion({}), true, 'cannot ask: stay still');
  assert.equal(reducedMotion({ matchMedia: () => { throw new Error('x'); } }), true);
  assert.equal(reducedMotion(undefined), true);
});

// A tiny stand-in for the browser objects the effects touch.
const still = { matchMedia: () => ({ matches: true }) } as never;
const moving = (frames: Array<(t: number) => void>) =>
  ({ matchMedia: () => ({ matches: false }), performance: { now: () => 0 }, requestAnimationFrame: (f: (t: number) => void) => frames.push(f), cancelAnimationFrame: () => {} }) as never;
const el = (text: string) => ({ dataset: {} as Record<string, string>, textContent: text }) as unknown as HTMLElement;

test('reduced motion: no confetti, no grow animation, no tween', () => {
  const doc = { createElement: () => { throw new Error('must not build anything'); }, body: { appendChild: () => { throw new Error('must not draw'); } } } as never;
  assert.doesNotThrow(() => confetti(doc, still));
  assert.doesNotThrow(() => growPlot({ querySelectorAll: () => { throw new Error('must not look'); } } as never, '1', still));
  const e = el('10.00');
  tweenElement(e, '10.00', '20.00', still);
  assert.equal(e.textContent, '20.00', 'the value read is shown at once');
});

test('tween with motion: starts from the old number and ends on the value read', () => {
  const frames: Array<(t: number) => void> = [];
  const e = el('');
  tweenElement(e, '10.00', '20.00', moving(frames), 600);
  assert.equal(e.textContent, '10.00');
  frames.shift()!(300);
  assert.notEqual(e.textContent, '10.00');
  assert.notEqual(e.textContent, '20.00');
  frames.shift()!(600);
  assert.equal(e.textContent, '20.00');
  assert.equal(e.dataset.final, '20.00');
});

test('tween: the same value, or a value that is not a number, is shown as read without a frame', () => {
  const frames: Array<(t: number) => void> = [];
  const a = el('');
  tweenElement(a, '5.00', '5.00', moving(frames));
  const b = el('');
  tweenElement(b, '?', '5.00', moving(frames));
  assert.equal(a.textContent, '5.00');
  assert.equal(b.textContent, '5.00');
  assert.equal(frames.length, 0);
});

test('captureTweens / applyTweens carry the shown numbers across a rebuild', () => {
  const old = el('1.00');
  old.dataset.tween = 'a';
  const host = { querySelectorAll: () => [old] } as never;
  const shown = captureTweens(host);
  assert.deepEqual([...shown], [['a', '1.00']]);
  const fresh = el('3.00');
  fresh.dataset.tween = 'a';
  const frames: Array<(t: number) => void> = [];
  applyTweens({ querySelectorAll: () => [fresh] } as never, shown, moving(frames));
  assert.equal(fresh.textContent, '1.00', 'starts where the old number was');
  frames.shift()!(10_000);
  assert.equal(fresh.textContent, '3.00');
});

test('sound is off by default, remembered when switched, and silent when off', () => {
  const mem = new Map<string, string>();
  const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
  let made = 0;
  let tones = 0;
  const ctx = () => {
    made++;
    return {
      currentTime: 0,
      destination: {},
      createOscillator: () => ({ type: '', frequency: { value: 0 }, connect() {}, start() { tones++; }, stop() {} }),
      createGain: () => ({ gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }),
    };
  };
  const s = createSound(store, ctx);
  assert.equal(s.enabled(), false);
  s.play('level-up');
  assert.equal(made, 0, 'no audio context is created while sound is off');
  s.set(true);
  assert.equal(mem.get('flipgarden:fx:sound'), '1');
  assert.equal(createSound(store, ctx).enabled(), true, 'a new page load remembers it');
  const before = tones;
  s.play('level-up');
  assert.equal(tones - before, 4);
  s.set(false);
  s.play('achievement');
  assert.equal(createSound(store, ctx).enabled(), false);
  assert.equal(createSound(null, ctx).enabled(), false);
  assert.equal(createSound({ getItem: () => { throw new Error('x'); }, setItem: () => {} }, ctx).enabled(), false);
});

test('level progress uses only the ladder and the two level numbers', () => {
  assert.deepEqual(levelProgress({ roundTrips: 0, ageSeconds: 0 }), { next: 'Sprout', either: true, trips: { have: 0, need: 1, pct: 0 }, days: { have: 0, need: 1, pct: 0 } });
  assert.deepEqual(levelProgress({ roundTrips: 2, ageSeconds: DAY_SECONDS * 1.5 }), { next: 'Bloom', either: false, trips: { have: 2, need: 3, pct: 66 }, days: { have: 1, need: 3, pct: 50 } });
  assert.equal(levelProgress({ roundTrips: 0 })?.days.have, null, 'unknown age stays unknown');
  assert.equal(levelProgress({ roundTrips: 0 })?.days.pct, 0);
  const p = levelProgress({ roundTrips: 7, ageSeconds: 30 * DAY_SECONDS });
  assert.equal(p?.next, 'Orchard', 'top of the ladder is not reached by a count above the Bloom bar');
  assert.equal(levelProgress({ roundTrips: 10, ageSeconds: 7 * DAY_SECONDS }), null, 'the top level has no next step');
});

// Pull out every `@media (prefers-reduced-motion: no-preference) { ... }` block (brace matched) and return [outside, inside].
function splitMotion(css: string): { outside: string; inside: string } {
  let outside = '';
  let inside = '';
  let i = 0;
  const key = '@media (prefers-reduced-motion: no-preference)';
  while (i < css.length) {
    const at = css.indexOf(key, i);
    if (at < 0) { outside += css.slice(i); break; }
    outside += css.slice(i, at);
    let depth = 0;
    let j = css.indexOf('{', at);
    const start = j;
    for (; j < css.length; j++) {
      if (css[j] === '{') depth++;
      if (css[j] === '}' && --depth === 0) break;
    }
    inside += css.slice(start + 1, j);
    i = j + 1;
  }
  return { outside, inside };
}

for (const [name, css] of [['web/style.css', readFileSync(new URL('../web/style.css', import.meta.url), 'utf8')], ['garden-style.ts', GARDEN_CSS]] as const) {
  test(`reduced motion: every animation and transition in ${name} sits inside the no-preference block`, () => {
    const { outside, inside } = splitMotion(css);
    const withoutKeyframes = outside.replace(/@keyframes [\w-]+ \{(?:[^{}]*\{[^{}]*\})+\s*\}/g, '');
    assert.doesNotMatch(withoutKeyframes, /\banimation(-[a-z]+)?\s*:/, 'an animation declared outside the block would run for everyone');
    assert.doesNotMatch(withoutKeyframes, /\btransition(-[a-z]+)?\s*:/, 'a transition declared outside the block would run for everyone');
    assert.match(inside, /animation|transition/, 'the block really holds the motion');
  });
}
