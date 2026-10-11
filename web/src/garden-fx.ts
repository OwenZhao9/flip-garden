// Game-feel logic with no DOM: what changed between two garden views, what has already been celebrated for a wallet
// (a per-viewer convenience kept in localStorage), and whether motion is allowed. Effects only present facts that the
// garden view already holds; nothing here changes a number, a label of a number, or a transaction.
import type { GardenView } from './garden-view.ts';

export type GardenEvent =
  | { type: 'stage-changed'; plotId: string; title: string; from: string; to: string }
  | { type: 'achievement-earned'; id: string; title: string }
  | { type: 'level-up'; from: string; to: string; index: number }
  | { type: 'first-fill' };

// prev === null is the first load of a page: nothing is reported, so nothing replays.
export function diffGarden(prev: GardenView | null, next: GardenView): GardenEvent[] {
  if (!prev) return [];
  const events: GardenEvent[] = [];
  const before = new Map(prev.plots.map((p) => [p.id, p]));
  for (const p of next.plots) {
    const old = before.get(p.id);
    if (old && old.stage !== p.stage) events.push({ type: 'stage-changed', plotId: p.id, title: p.title, from: old.stageLabel, to: p.stageLabel });
  }
  const had = new Set(prev.achievements.filter((a) => a.earned).map((a) => a.id));
  for (const a of next.achievements) {
    if (!a.earned || had.has(a.id)) continue;
    events.push({ type: 'achievement-earned', id: a.id, title: a.title });
    if (a.id === 'first-fill') events.push({ type: 'first-fill' });
  }
  if (next.level.index > prev.level.index) events.push({ type: 'level-up', from: prev.level.name, to: next.level.name, index: next.level.index });
  return events;
}

// --- what was already celebrated, per wallet --------------------------------------------------------

export type StoreLike = Pick<Storage, 'getItem' | 'setItem'>;
export type Seen = { achievements: string[]; level: number };

const seenKey = (address: string): string => `flipgarden:fx:v1:${address.toLowerCase()}`;
export const SOUND_KEY = 'flipgarden:fx:sound';

// Every access is wrapped: with storage blocked or full the page still works, it just cannot remember.
export function loadSeen(store: StoreLike | null, address: string): Seen {
  try {
    const raw = store?.getItem(seenKey(address));
    if (raw) {
      const o = JSON.parse(raw) as Partial<Seen>;
      return { achievements: Array.isArray(o.achievements) ? o.achievements.filter((x) => typeof x === 'string') : [], level: typeof o.level === 'number' ? o.level : 0 };
    }
  } catch {
    // unreadable or blocked: start empty
  }
  return { achievements: [], level: 0 };
}

export function saveSeen(store: StoreLike | null, address: string, seen: Seen): void {
  try {
    store?.setItem(seenKey(address), JSON.stringify(seen));
  } catch {
    // blocked or full: nothing to do
  }
}

export function defaultStore(): StoreLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

// What the first view of a page counts as already shown (nothing replays on load).
export function seenFromView(v: GardenView, before: Seen): Seen {
  return { achievements: [...new Set([...before.achievements, ...v.achievements.filter((a) => a.earned).map((a) => a.id)])], level: Math.max(before.level, v.level.index) };
}

// Keep only the events that have not been celebrated yet; stage changes are not remembered (they are a live moment).
export function freshEvents(events: GardenEvent[], seen: Seen): GardenEvent[] {
  return events.filter((e) => {
    if (e.type === 'achievement-earned') return !seen.achievements.includes(e.id);
    if (e.type === 'first-fill') return !seen.achievements.includes('first-fill');
    if (e.type === 'level-up') return e.index > seen.level;
    return true;
  });
}

export function markSeen(seen: Seen, events: GardenEvent[]): Seen {
  const ach = new Set(seen.achievements);
  let level = seen.level;
  for (const e of events) {
    if (e.type === 'achievement-earned') ach.add(e.id);
    if (e.type === 'first-fill') ach.add('first-fill');
    if (e.type === 'level-up') level = Math.max(level, e.index);
  }
  return { achievements: [...ach], level };
}

// --- motion preference --------------------------------------------------------------------------------

type MediaWin = { matchMedia?: (q: string) => { matches: boolean } };

// True when the visitor asked for no motion. If the question cannot be asked, motion stays off: the quiet page is the safe one.
export function reducedMotion(win: MediaWin | undefined = typeof window === 'undefined' ? undefined : window): boolean {
  try {
    if (!win?.matchMedia) return true;
    return win.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return true;
  }
}

// --- number tween: the last frame is always the exact value that was read --------------------------------

const NUM = /^-?\d[\d,]*(\.\d+)?$/;

export function parseShown(text: string): { value: number; decimals: number } | null {
  const t = text.trim();
  if (!NUM.test(t)) return null;
  return { value: Number(t.replace(/,/g, '')), decimals: (t.split('.')[1] ?? '').length };
}

const group = (intPart: string): string => intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// The text to show at progress t (0..1) when moving from one displayed number to another. t >= 1 returns `to` untouched.
export function tweenText(from: string, to: string, t: number): string {
  const a = parseShown(from);
  const b = parseShown(to);
  if (t >= 1 || !a || !b) return to;
  const v = a.value + (b.value - a.value) * Math.max(0, t);
  const fixed = Math.abs(v).toFixed(b.decimals);
  const [i, f] = fixed.split('.');
  return `${v < 0 ? '-' : ''}${group(i)}${f ? '.' + f : ''}`;
}
