// The garden game layer: plots, growth stages, achievements and a level. Pure functions over the ledger's output.
//
// Rules of this file (the honesty of the numbers depends on them):
// - Everything is derived from the ledger each time; nothing is stored and nothing here touches money.
// - No game value is ever mixed into a ledger number. A level and an achievement say nothing about profit.
// - Anything that needs a completed round trip is labelled "not yet seen on real data" until a round trip exists
//   in a fixture (ROUND_TRIP_SEEN_ON_REAL_DATA below; a test keeps the flag honest).
import type { Ledger, Order } from './ledger.ts';

// --- plots and growth stages ------------------------------------------------------------------------

// seed: planted and resting; sprout: partly filled; flower: one leg completely filled; fruit: a completed round trip
// (a leg filled, the flipped opposite leg filled too); pruned: the plot's newest order was cancelled (a cut stem).
export type Stage = 'seed' | 'sprout' | 'flower' | 'fruit' | 'pruned';

export const STAGES: readonly Stage[] = ['seed', 'sprout', 'flower', 'fruit', 'pruned'];

export type Plot = {
  rootId: bigint;
  orders: Order[]; // the planted order first, then every order Kuru flipped out of it
  stage: Stage;
  live: Order[]; // orders of this plot still resting (status open)
  filledLegs: number; // orders that filled completely
  roundTrips: number; // pairs of completed legs: a buy filled and its flipped sell filled, or the reverse
};

// The one definition of the mapping. `orders` is a flip chain, oldest first.
export function stageOf(orders: Order[]): Stage {
  if (orders.length === 0) return 'seed';
  const filledLegs = orders.filter((o) => o.status === 'filled').length;
  if (filledLegs >= 2) return 'fruit';
  if (orders[orders.length - 1].status === 'cancelled') return 'pruned';
  if (filledLegs === 1) return 'flower';
  if (orders.some((o) => o.filled > 0n)) return 'sprout';
  return 'seed';
}

function chainOf(root: Order, byId: Map<bigint, Order>): Order[] {
  const out: Order[] = [];
  const seen = new Set<bigint>();
  const walk = (o: Order): void => {
    if (seen.has(o.id)) return;
    seen.add(o.id);
    out.push(o);
    for (const c of o.children) {
      const child = byId.get(c);
      if (child) walk(child);
    }
  };
  walk(root);
  return out;
}

export function plotsOf(ledger: Ledger, market: string): Plot[] {
  const m = market.toLowerCase();
  const all = [...ledger.orders.values()].filter((o) => o.market.toLowerCase() === m);
  const byId = new Map(all.map((o) => [o.id, o]));
  const roots = all.filter((o) => o.parent === null).sort((a, b) => (a.createdBlock ?? Infinity) - (b.createdBlock ?? Infinity) || (a.id < b.id ? -1 : 1));
  return roots.map((root) => {
    const orders = chainOf(root, byId);
    const filledLegs = orders.filter((o) => o.status === 'filled').length;
    return { rootId: root.id, orders, stage: stageOf(orders), live: orders.filter((o) => o.status === 'open'), filledLegs, roundTrips: Math.floor(filledLegs / 2) };
  });
}

// --- round trips on real data -----------------------------------------------------------------------

// Set to true only when a fixture (real chain data) contains a completed round trip. test/garden.test.ts scans every
// fixture and fails if this flag and the data disagree, so it cannot silently go stale.
export const ROUND_TRIP_SEEN_ON_REAL_DATA = false;

// --- time -------------------------------------------------------------------------------------------

export const DAY_SECONDS = 86_400;

// First and last block the garden touches, for the caller to turn into real time with block timestamps
// (a block time assumed here would be a guess; the page reads the two timestamps from the node instead).
export function gardenSpan(ledger: Ledger, market: string): { firstBlock: number | null; lastBlock: number | null } {
  const m = market.toLowerCase();
  const blocks: number[] = [];
  for (const o of ledger.orders.values()) if (o.market.toLowerCase() === m && o.createdBlock !== null) blocks.push(o.createdBlock);
  if (blocks.length === 0) return { firstBlock: null, lastBlock: null };
  const last = ledger.untilBlock ?? Math.max(...blocks, ...ledger.fills.map((f) => f.block));
  return { firstBlock: Math.min(...blocks), lastBlock: last };
}

// --- achievements -----------------------------------------------------------------------------------

export type AchievementId = 'first-planting' | 'first-fill' | 'first-round-trip' | 'three-plots' | 'seven-days' | 'first-prune' | 'first-harvest';

export type Achievement = {
  id: AchievementId;
  title: string;
  how: string; // what earns it, in plain words
  earned: boolean;
  note?: string; // a caveat shown with it
};

export type GardenInput = { ledger: Ledger; market: string; ageSeconds?: number | null }; // ageSeconds: null/undefined = unknown

export function achievements(i: GardenInput, plots: Plot[] = plotsOf(i.ledger, i.market)): Achievement[] {
  const { ledger } = i;
  const trips = plots.reduce((a, p) => a + p.roundTrips, 0);
  const age = i.ageSeconds ?? null;
  const orders = [...ledger.orders.values()];
  return [
    { id: 'first-planting', title: 'First planting', how: 'Plant a flip order.', earned: plots.length > 0 },
    { id: 'first-fill', title: 'First fill', how: 'A taker fills one of your orders.', earned: ledger.fills.length > 0 },
    { id: 'first-round-trip', title: 'First round trip', how: 'A leg fills and the flipped opposite leg fills too.', earned: trips > 0 },
    { id: 'three-plots', title: 'A garden of three', how: 'Plant three plots.', earned: plots.length >= 3 },
    {
      id: 'seven-days',
      title: 'Seven days old',
      how: 'Keep the garden for seven days, counted from the first planting to the last block read.',
      earned: age !== null && age >= 7 * DAY_SECONDS,
      note: age === null ? 'Block times could not be read, so the age is unknown.' : undefined,
    },
    { id: 'first-prune', title: 'First prune', how: 'Cancel an order.', earned: orders.some((o) => o.status === 'cancelled') },
    { id: 'first-harvest', title: 'First harvest', how: 'Withdraw free money from Kuru.', earned: ledger.flows.some((f) => f.kind === 'withdrawal' && f.amount !== 0n), note: 'A harvest returns free money; it says nothing about profit.' },
  ];
}

// --- level ------------------------------------------------------------------------------------------

export type LevelName = 'Seed' | 'Sprout' | 'Bloom' | 'Orchard';
export type Level = { name: LevelName; index: number; roundTrips: number; ageDays: number | null; next: string | null; note: string };

// The thresholds are game design, not measurements. They use completed round trips and garden age only.
const LADDER: { name: LevelName; trips: number; days: number; either: boolean }[] = [
  { name: 'Sprout', trips: 1, days: 1, either: true }, // one round trip OR one day
  { name: 'Bloom', trips: 3, days: 3, either: false }, // three round trips AND three days
  { name: 'Orchard', trips: 10, days: 7, either: false },
];

const meets = (r: (typeof LADDER)[number], trips: number, days: number): boolean => (r.either ? trips >= r.trips || days >= r.days : trips >= r.trips && days >= r.days);

export function levelOf(i: { roundTrips: number; ageSeconds?: number | null }): Level {
  const days = i.ageSeconds === null || i.ageSeconds === undefined ? null : Math.floor(i.ageSeconds / DAY_SECONDS);
  let index = 0;
  for (let k = 0; k < LADDER.length; k++) if (meets(LADDER[k], i.roundTrips, days ?? 0)) index = k + 1;
  const nextRule = LADDER[index];
  const next = nextRule
    ? nextRule.either
      ? `${nextRule.name}: ${nextRule.trips} completed round trip or ${nextRule.days} day of garden age`
      : `${nextRule.name}: ${nextRule.trips} completed round trips and ${nextRule.days} days of garden age`
    : null;
  const names: LevelName[] = ['Seed', ...LADDER.map((r) => r.name)];
  return {
    name: names[index],
    index,
    roundTrips: i.roundTrips,
    ageDays: days,
    next,
    note: 'The level counts completed round trips and the age of the garden. It says nothing about profit.',
  };
}

// Progress towards the next level, from the same ladder and the same two numbers the level uses. A bar is a share of one
// threshold (whole percent, integer maths); there are no points and no experience.
export type LevelProgress = {
  next: LevelName;
  either: boolean; // true: one of the two thresholds is enough; false: both are needed
  trips: { have: number; need: number; pct: number };
  days: { have: number | null; need: number; pct: number }; // have = whole days; null = age unknown
};

export function levelProgress(i: { roundTrips: number; ageSeconds?: number | null }): LevelProgress | null {
  const lvl = levelOf(i);
  const rule = LADDER[lvl.index];
  if (!rule) return null;
  const age = i.ageSeconds ?? null;
  const tripsHave = Math.min(i.roundTrips, rule.trips);
  const daysHave = lvl.ageDays === null ? null : Math.min(lvl.ageDays, rule.days);
  const daysPct = age === null ? 0 : Math.min(100, Math.floor((Math.max(0, age) * 100) / (rule.days * DAY_SECONDS)));
  return {
    next: rule.name,
    either: rule.either,
    trips: { have: tripsHave, need: rule.trips, pct: Math.floor((tripsHave * 100) / rule.trips) },
    days: { have: daysHave, need: rule.days, pct: daysPct },
  };
}

export type Garden = { plots: Plot[]; achievements: Achievement[]; level: Level; roundTrips: number; seenOnRealData: boolean };

export function gardenOf(i: GardenInput): Garden {
  const plots = plotsOf(i.ledger, i.market);
  const roundTrips = plots.reduce((a, p) => a + p.roundTrips, 0);
  return { plots, achievements: achievements(i, plots), level: levelOf({ roundTrips, ageSeconds: i.ageSeconds }), roundTrips, seenOnRealData: ROUND_TRIP_SEEN_ON_REAL_DATA };
}
