// The 3D garden, the parts with no Three.js and no DOM: where each plant stands, how it is shaped from the garden view,
// which moments play, and the easing curves. Everything a plant shows comes from the GardenView (its stage and its count
// of completed round trips); layout, phase and jitter are decoration derived from the plot id, never a number shown as data.
import type { Stage } from '../../src/garden.ts';
import type { GardenEvent } from './garden-fx.ts';
import type { GardenView } from './garden-view.ts';

export const CELL = 1.7; // distance between two plants, in scene units
export const MAX_COLS = 8;
export const MAX_FRUITS = 5; // a tree shows one fruit per completed round trip of its plot, up to this many

export type PlantParams = { id: string; title: string; stage: Stage; x: number; z: number; phase: number; fruits: number };
export type SceneParams = { plants: PlantParams[]; cols: number; rows: number; width: number; depth: number };

// FNV-1a, 32 bit: a stable small hash so the same plot always sways with the same phase.
export function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// How many plants per row for n plots on a canvas of this width/height ratio: wide canvases get long rows.
export function columnsFor(n: number, aspect: number): number {
  if (n <= 1) return 1;
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  return Math.max(1, Math.min(n, MAX_COLS, Math.ceil(Math.sqrt(n * a * 1.6))));
}

export function fruitsFor(stage: Stage, roundTrips: number): number {
  if (stage !== 'fruit') return 0;
  return Math.max(1, Math.min(MAX_FRUITS, Math.floor(roundTrips)));
}

export function sceneParams(view: GardenView, aspect: number): SceneParams {
  const n = view.plots.length;
  const cols = columnsFor(n, aspect);
  const rows = Math.max(1, Math.ceil(n / cols));
  const plants = view.plots.map((p, i) => {
    const row = Math.floor(i / cols);
    const inRow = row === rows - 1 ? n - row * cols : cols; // the last row may be shorter; centre it
    const col = i - row * cols;
    const h = hashId(p.id);
    const jx = (((h & 0xff) / 255) - 0.5) * 0.24 * CELL;
    const jz = ((((h >>> 8) & 0xff) / 255) - 0.5) * 0.18 * CELL;
    const stagger = rows > 1 && row % 2 === 1 ? CELL * 0.25 : 0;
    return {
      id: p.id,
      title: p.title,
      stage: p.stage,
      x: (col - (inRow - 1) / 2) * CELL + stagger + (n > 1 ? jx : 0),
      z: (row - (rows - 1) / 2) * CELL * 0.9 + (n > 1 ? jz : 0),
      phase: ((h >>> 16) / 0xffff) * Math.PI * 2,
      fruits: fruitsFor(p.stage, p.roundTrips),
    };
  });
  return { plants, cols, rows, width: cols * CELL, depth: rows * CELL * 0.9 };
}

// --- moments ---------------------------------------------------------------------------------------------

export type Moment = { kind: 'grow'; plotId: string } | { kind: 'prune'; plotId: string } | { kind: 'confetti' };

// What the scene plays for a batch of garden events (already filtered to what has not been celebrated):
// a stage change grows the plant, or cuts it when the new stage is "pruned"; the big moments throw confetti.
export function momentsOf(events: GardenEvent[], view: GardenView): Moment[] {
  const stage = new Map(view.plots.map((p) => [p.id, p.stage]));
  const out: Moment[] = [];
  for (const e of events) if (e.type === 'stage-changed') out.push({ kind: stage.get(e.plotId) === 'pruned' ? 'prune' : 'grow', plotId: e.plotId });
  if (events.some((e) => e.type !== 'stage-changed')) out.push({ kind: 'confetti' });
  return out;
}

// --- curves ------------------------------------------------------------------------------------------------

export const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);

export function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const u = clamp01(t) - 1;
  return 1 + c3 * u ** 3 + c1 * u ** 2;
}

// Grow transition: the plant rises from nothing with an overshoot, stretching up then squashing down, keeping its volume
// roughly constant. t runs 0..1; at t >= 1 the result is exactly 1, 1.
export function squashStretch(t: number): { sx: number; sy: number } {
  if (t >= 1) return { sx: 1, sy: 1 };
  const k = clamp01(t);
  const s = easeOutBack(k);
  const wobble = 1 + 0.28 * Math.sin(k * Math.PI * 3) * (1 - k);
  const sy = s * wobble;
  return { sx: s / Math.sqrt(Math.max(wobble, 0.05)), sy };
}

// The camera looks down a little more when there are several rows, so the back row is not hidden by the front one.
export const elevationFor = (rows: number): number => Math.min(0.78, 0.48 + 0.1 * (Math.max(1, rows) - 1));

// Camera distance so a bed of this width and depth fits a canvas of this aspect, seen from `elevation` radians above it.
export function cameraDistance(width: number, depth: number, aspect: number, fovDeg: number, elevation: number): number {
  const v = (fovDeg * Math.PI) / 180;
  const hfov = 2 * Math.atan(Math.tan(v / 2) * Math.max(aspect, 0.2));
  const w = width + 1.1; // a margin for the bed rim and canopies
  const tall = depth * Math.sin(elevation) + 2.8 * Math.cos(elevation); // projected depth plus the tallest plant
  const byWidth = w / 2 / Math.tan(hfov / 2);
  const byHeight = tall / 2 / Math.tan(v / 2);
  return Math.max(byWidth, byHeight, 4) + depth / 2;
}
