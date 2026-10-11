// The figures of one garden, computed from the ledger core. Nothing here reads a client-supplied number.
import { plotsOf, levelOf, gardenSpan, DAY_SECONDS } from '../../src/garden.ts';
import type { Ledger } from '../../src/ledger.ts';
import type { Figures } from './types.ts';

export const roundTripsOf = (ledger: Ledger, market: string): number => plotsOf(ledger, market).reduce((a, p) => a + p.roundTrips, 0);
export const firstBlockOf = (ledger: Ledger, market: string): number | null => gardenSpan(ledger, market).firstBlock;

// ageSeconds = timestamp of the last block read minus timestamp of the block of the first planting; null when unknown.
export function makeFigures(o: { completedRoundTrips: number; firstBlock: number | null; ageSeconds: number | null; now: string }): Figures {
  const lvl = levelOf({ roundTrips: o.completedRoundTrips, ageSeconds: o.ageSeconds });
  return {
    completedRoundTrips: o.completedRoundTrips,
    gardenAgeDays: o.ageSeconds === null ? null : Math.max(0, Math.floor(o.ageSeconds / DAY_SECONDS)),
    level: lvl.name,
    levelIndex: lvl.index,
    firstBlock: o.firstBlock,
    updatedAt: o.now,
  };
}
