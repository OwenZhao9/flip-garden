// Minimal Cloudflare types (no @cloudflare/workers-types dependency) and the service's own shapes.
import type { LogSource } from '../../src/scan.ts';
import type { Market } from '../../src/units.ts';

export interface KV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export type Env = {
  KV: KV;
  RPC_URL?: string;
  MARKET: string;
  MARGIN_ACCOUNT: string;
  MARKET_FIRST_BLOCK: string;
  MAX_WALLETS?: string;
  MAX_RPC_CALLS_PER_RUN?: string;
  JEV_API_KEY?: string; // secret, set with `wrangler secret put JEV_API_KEY`; never in a file
  JEV_URL?: string;
  // Envio HyperSync. ENVIO_API_TOKEN is a Worker secret set by the owner (never in this file or in the page).
  ENVIO_API_TOKEN?: string;
  ENVIO_URL?: string;
  ENVIO_WINDOW_BLOCKS?: string;
  ENVIO_QUERIES_PER_RUN?: string; // HyperSync queries per cron run (Envio's free plan: 15 a minute, shared with page reads)
};

// Everything the service needs from the chain. Read-only.
export interface Chain extends LogSource {
  windowBlocks?: number; // blocks per getLogs window; the public RPC needs 90, HyperSync takes far more
  marketParams(address: string): Promise<Market>;
  blockTimestamp(block: number): Promise<number>; // seconds
}

export type Config = { market: string; marginAccount: string; marketFirstBlock: number; maxWallets: number; maxRpcCallsPerRun: number; fastQueriesPerRun: number };

// Stored under `w:<address>`. Public address, start block, scan cursor and computed figures only.
export type Figures = { completedRoundTrips: number; gardenAgeDays: number | null; level: string; levelIndex: number; firstBlock: number | null; updatedAt: string };
export type WalletRecord = {
  address: string;
  startBlock: number;
  registeredAt: string;
  nextBlock: number; // first block not yet scanned (mirrors the stored scan state)
  catchingUp: boolean; // true while the scan is still behind the chain head
  firstTs?: number; // timestamp (seconds) of the block of the first planting, cached once known
  figures: Figures | null;
};

export type BoardRow = { rank: number; address: string; completedRoundTrips: number; gardenAgeDays: number | null; level: string; updatedAt: string };
