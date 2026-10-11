// Ledger -> what the garden panel shows. Pure functions, no I/O, no floating point: every amount is a BigInt formatted
// with fixed-point maths, and every number comes straight from the ledger. No game value is ever mixed into one.
import { decodeLog, type KuruEvent } from '../../src/events.ts';
import { buildLedger, type Ledger, type Order } from '../../src/ledger.ts';
import { DAY_SECONDS, gardenOf, gardenSpan, type Achievement, type Stage } from '../../src/garden.ts';
import { baseForSize, formatUnits, log10Exact, type Market } from '../../src/units.ts';
import { STAGE_EXPLAIN, STAGE_LABEL } from './garden-art.ts';
import type { Bundle } from './model.ts';

export function ledgerOfBundle(b: Bundle): Ledger {
  const events = b.logs.map((l) => decodeLog(l)).filter((e): e is KuruEvent => e !== null);
  return buildLedger({ account: b.account, markets: [b.market], events, txs: b.txs, untilBlock: b.endBlock });
}

export type LiveOrderView = { id: string; side: 'buy' | 'sell'; line: string; movable: boolean };
export type PlotView = {
  id: string;
  title: string;
  stage: Stage;
  stageLabel: string;
  explain: string;
  summary: string; // the planted order, in one line
  progress: string; // the newest order, in one line
  live: LiveOrderView[];
  roundTrips: number;
};
export type AchievementView = { id: string; title: string; how: string; earned: boolean; note: string };
export type GardenView = {
  empty: boolean;
  plots: PlotView[];
  achievements: AchievementView[];
  level: { name: string; index: number; summary: string; next: string; note: string };
  roundTrips: number;
  notSeenNote: string;
};

const dayText = (age: number | null): string => (age === null ? 'age unknown' : age < DAY_SECONDS ? 'under a day old' : `${Math.floor(age / DAY_SECONDS)} day${Math.floor(age / DAY_SECONDS) === 1 ? '' : 's'} old`);

export function buildGardenView(ledger: Ledger, m: Market, symbols: { base: string }, ageSeconds: number | null): GardenView {
  const g = gardenOf({ ledger, market: m.address, ageSeconds });
  const priceDec = log10Exact(m.pricePrecision);
  const price = (p: bigint | null): string => (p === null ? '?' : formatUnits(p, priceDec));
  const size = (s: bigint | null): string => (s === null ? '?' : formatUnits(baseForSize(s, m, 'down').value, m.baseDecimals, 6));
  const side = (o: Order): string => (o.isBuy === null ? 'order' : o.isBuy ? 'bid' : 'sell');

  const plots: PlotView[] = g.plots.map((p) => {
    const root = p.orders[0];
    const tip = p.orders[p.orders.length - 1];
    const live: LiveOrderView[] = p.live.map((o) => ({
      id: String(o.id),
      side: o.isBuy ? 'buy' : 'sell',
      line: `#${o.id} ${side(o)} at ${price(o.price)}, ${size(o.filled)} of ${size(o.initialSize)} ${symbols.base} filled`,
      movable: o.isBuy === true && o.remaining !== null && o.remaining > 0n,
    }));
    return {
      id: String(p.rootId),
      title: `Plot #${p.rootId}`,
      stage: p.stage,
      stageLabel: STAGE_LABEL[p.stage],
      explain: STAGE_EXPLAIN[p.stage],
      summary: `${side(root)} ${price(root.price)}${root.flipPrice === null ? '' : `, flips to ${price(root.flipPrice)}`} · ${size(root.initialSize)} ${symbols.base}`,
      progress: p.orders.length > 1 ? `${p.orders.length} orders so far; newest #${tip.id} ${side(tip)} at ${price(tip.price)} is ${tip.status}` : `Order #${tip.id} is ${tip.status}, ${size(tip.filled)} of ${size(tip.initialSize)} ${symbols.base} filled`,
      live,
      roundTrips: p.roundTrips,
    };
  });

  const achievements: AchievementView[] = g.achievements.map((a: Achievement) => ({ id: a.id, title: a.title, how: a.how, earned: a.earned, note: a.note ?? '' }));
  const trips = g.roundTrips;
  return {
    empty: plots.length === 0,
    plots,
    achievements,
    level: {
      name: g.level.name,
      index: g.level.index,
      summary: `${trips} completed round trip${trips === 1 ? '' : 's'} · garden ${dayText(ageSeconds)}`,
      next: g.level.next ? `Next level, ${g.level.next}.` : 'This is the top level.',
      note: g.level.note,
    },
    roundTrips: trips,
    notSeenNote: '',
  };
}

export { gardenSpan };
