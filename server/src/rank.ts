// Ranking and display helpers. Pure. Rank = completed round trips (more first), then garden age in days (older first),
// then the address (so the order is stable). Profit is never an input.
import type { BoardRow, WalletRecord } from './types.ts';

export const shortAddress = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function compareRecords(a: WalletRecord, b: WalletRecord): number {
  const fa = a.figures!;
  const fb = b.figures!;
  return fb.completedRoundTrips - fa.completedRoundTrips || (fb.gardenAgeDays ?? -1) - (fa.gardenAgeDays ?? -1) || (a.address < b.address ? -1 : a.address > b.address ? 1 : 0);
}

// Wallets without figures yet (registered, not scanned) are not ranked. Equal round trips and equal age share a rank.
export function rankRecords(records: WalletRecord[]): BoardRow[] {
  const ranked = records.filter((r) => r.figures !== null).sort(compareRecords);
  const rows: BoardRow[] = [];
  ranked.forEach((r, i) => {
    const f = r.figures!;
    const prev = i > 0 ? ranked[i - 1].figures! : null;
    const tie = prev !== null && prev.completedRoundTrips === f.completedRoundTrips && (prev.gardenAgeDays ?? -1) === (f.gardenAgeDays ?? -1);
    rows.push({ rank: tie ? rows[i - 1].rank : i + 1, address: shortAddress(r.address), completedRoundTrips: f.completedRoundTrips, gardenAgeDays: f.gardenAgeDays, level: f.level, updatedAt: f.updatedAt });
  });
  return rows;
}
