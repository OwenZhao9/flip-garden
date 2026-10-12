// The data layer: read-only RPC -> Bundle. Runs in the browser and in Node (same code).
// - Scans in windows of at most 90 blocks (public node limit is 100), resumable, cancellable.
// - Also looks for USDC `approve` transactions of the wallet (they have no Kuru event but cost gas).
// - Caches what it scanned per wallet and start block, so a second visit only reads new blocks.
import { JsonRpc } from '../../src/rpc.ts';
import { keccak256 } from '../../src/keccak.ts';
import { buildLedger } from '../../src/ledger.ts';
import { candidateOwnTxs, eventsOf, newScanState, planWindows, sync, type LogFilter, type LogSource, type ScanState } from '../../src/scan.ts';
import type { KuruEvent, RawLog } from '../../src/events.ts';
import type { Book } from '../../src/pnl.ts';
import type { Bundle } from './model.ts';

export type Config = {
  rpcUrl: string;
  marginAccount: string;
  market: string;
  symbols: { base: string; quote: string };
  maxBlocksPerRequest: number;
  confirmations: number;
  historyUrl?: string; // the leaderboard Worker; it reads old history through Envio, which needs a token the page must not hold
};

// Kuru MON-USDC on Monad mainnet (config/kuru.mainnet.json; addresses from the official Kuru docs).
export const MAINNET: Config = {
  rpcUrl: 'https://rpc.monad.xyz',
  marginAccount: '0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5',
  market: '0x065C9d28E428A0db40191a54d33d5b7c71a9C394',
  symbols: { base: 'MON', quote: 'USDC' },
  maxBlocksPerRequest: 90,
  confirmations: 2,
  historyUrl: 'https://flip-garden-leaderboard.photogif.workers.dev',
};

export const EXAMPLE = {
  account: '0x39FdC1B554FCF0B7478E58ff671f3d0FEA64DA38',
  startBlock: 112209462,
  endBlock: 112211600,
};

export type Store = { get(key: string): string | null; set(key: string, value: string): void };

export type Progress = { phase: 'setup' | 'scan' | 'chain' | 'done'; windowsDone: number; windowsTotal: number; block: number; cached: boolean };

const APPROVAL_TOPIC = keccak256('Approval(address,address,uint256)');
const pad = (a: string): string => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

export const isAddress = (s: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(s.trim());

export type CacheEntry = { state: ScanState; approvals: Record<string, number> }; // approval tx hash -> block

const cacheKey = (account: string, start: number, cfg: Config): string => `flipgarden:v1:${cfg.market.toLowerCase()}:${account.toLowerCase()}:${start}`;

function readCache(store: Store | undefined, key: string): CacheEntry | null {
  try {
    const s = store?.get(key);
    return s ? (JSON.parse(s) as CacheEntry) : null;
  } catch {
    return null;
  }
}
function writeCache(store: Store | undefined, key: string, e: CacheEntry): void {
  try {
    store?.set(key, JSON.stringify(e));
  } catch {
    // storage full or blocked: the page still works, it just will not remember
  }
}

// Wraps the RPC so that every margin-account window also fetches this wallet's USDC approvals.
class WindowSource implements LogSource {
  approvals: Record<string, number>;
  private rpc: JsonRpc;
  private cfg: Config;
  private account: string;
  private quoteToken: string;
  constructor(rpc: JsonRpc, cfg: Config, account: string, quoteToken: string, approvals: Record<string, number>) {
    this.rpc = rpc;
    this.cfg = cfg;
    this.account = account;
    this.quoteToken = quoteToken;
    this.approvals = approvals;
  }
  blockNumber(): Promise<number> {
    return this.rpc.blockNumber();
  }
  async getLogs(f: LogFilter): Promise<RawLog[]> {
    if (f.address.toLowerCase() !== this.cfg.marginAccount.toLowerCase()) return this.rpc.getLogs(f);
    const [margin, approvals] = await Promise.all([
      this.rpc.getLogs(f),
      this.rpc.getLogs({
        address: this.quoteToken,
        topics: [[APPROVAL_TOPIC], [pad(this.account)], [pad(this.cfg.marginAccount)]],
        fromBlock: f.fromBlock,
        toBlock: f.toBlock,
      }),
    ]);
    for (const l of approvals) this.approvals[l.transactionHash.toLowerCase()] = Number(BigInt(l.blockNumber));
    return margin;
  }
}

// Asks the Worker for slices of this wallet's logs until it reaches `endBlock`, merging them into the scan state. Any failure
// (Worker down, odd answer, no progress) just stops: the normal RPC scan below continues from the cursor, so the page works
// without the Worker and the ledger is the same either way.
export async function prefetchHistory(entry: CacheEntry, cfg: Config, account: string, endBlock: number, f: typeof fetch, onStep: (block: number) => void, aborted: () => void): Promise<void> {
  if (!cfg.historyUrl) return;
  const markets = new Set([cfg.market.toLowerCase(), cfg.marginAccount.toLowerCase()]);
  for (let i = 0; i < 200 && entry.state.nextBlock <= endBlock; i++) {
    aborted();
    try {
      const res = await f(`${cfg.historyUrl}/history/${account}?from=${entry.state.nextBlock}`, { headers: { accept: 'application/json' } });
      if (!res.ok) return;
      const j = (await res.json()) as { from?: unknown; nextBlock?: unknown; logs?: unknown; approvals?: unknown };
      if (j.from !== entry.state.nextBlock || typeof j.nextBlock !== 'number' || !Number.isSafeInteger(j.nextBlock) || j.nextBlock <= entry.state.nextBlock) return;
      if (typeof j.logs !== 'object' || j.logs === null || typeof j.approvals !== 'object' || j.approvals === null) return;
      const logs = j.logs as ScanState['logs'];
      const approvals = j.approvals as Record<string, number>;
      for (const l of Object.values(logs)) {
        if (!markets.has(String(l?.address).toLowerCase()) || typeof l.data !== 'string' || !Array.isArray(l.topics) || typeof l.transactionHash !== 'string') return;
      }
      for (const [h, b] of Object.entries(approvals)) if (!/^0x[0-9a-fA-F]{64}$/.test(h) || !Number.isSafeInteger(b)) return;
      Object.assign(entry.state.logs, logs);
      Object.assign(entry.approvals, approvals);
      entry.state.nextBlock = j.nextBlock;
      onStep(j.nextBlock - 1);
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') throw e;
      return;
    }
  }
}

export async function fetchBundle(o: {
  account: string;
  startBlock: number;
  endBlock?: number;
  cfg?: Config;
  store?: Store;
  signal?: AbortSignal;
  onProgress?: (p: Progress) => void;
  fetchImpl?: typeof fetch;
}): Promise<Bundle> {
  const cfg = o.cfg ?? MAINNET;
  const account = o.account.trim().toLowerCase();
  if (!isAddress(account)) throw new Error('That does not look like a wallet address (0x followed by 40 hex characters).');
  if (!Number.isInteger(o.startBlock) || o.startBlock < 0) throw new Error('The start block must be a whole number.');
  const rpc = new JsonRpc(cfg.rpcUrl, { fetch: o.fetchImpl ? o.fetchImpl : (...a) => fetch(...a) });
  const progress = (p: Partial<Progress> & Pick<Progress, 'phase'>): void =>
    o.onProgress?.({ windowsDone: 0, windowsTotal: 0, block: o.startBlock, cached: false, ...p });
  const aborted = (): void => {
    if (o.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  };

  progress({ phase: 'setup' });
  const market = await rpc.marketParams(cfg.market);
  const head = await rpc.blockNumber();
  const safeHead = head - cfg.confirmations;
  const endBlock = Math.min(o.endBlock ?? safeHead, safeHead);
  if (o.startBlock > endBlock) throw new Error(`The start block (${o.startBlock}) is after the end block (${endBlock}).`);
  aborted();

  const key = cacheKey(account, o.startBlock, cfg);
  const cached = readCache(o.store, key);
  const entry: CacheEntry =
    cached && cached.state.startBlock === o.startBlock && cached.state.account === account
      ? cached
      : { state: newScanState({ account, markets: [cfg.market], marginAccount: cfg.marginAccount, startBlock: o.startBlock }), approvals: {} };
  const resumedAt = entry.state.nextBlock;
  const windowsTotal = planWindows(o.startBlock, endBlock, cfg.maxBlocksPerRequest).length;
  const windowsAlready = planWindows(o.startBlock, Math.max(o.startBlock, resumedAt - 1), cfg.maxBlocksPerRequest).length;

  const src = new WindowSource(rpc, cfg, account, market.quoteAsset, entry.approvals);
  let done = resumedAt > o.startBlock ? Math.min(windowsAlready, windowsTotal) : 0;
  progress({ phase: 'scan', windowsDone: done, windowsTotal, block: resumedAt, cached: resumedAt > o.startBlock });
  try {
    await prefetchHistory(entry, cfg, account, endBlock, o.fetchImpl ? o.fetchImpl : (...a) => fetch(...a), (block) => {
      done = Math.min(windowsTotal, Math.floor((block - o.startBlock + 1) / cfg.maxBlocksPerRequest));
      progress({ phase: 'scan', windowsDone: done, windowsTotal, block });
    }, aborted);
    writeCache(o.store, key, entry);
    await sync(entry.state, src, {
      maxBlocks: cfg.maxBlocksPerRequest,
      confirmations: cfg.confirmations,
      toBlock: endBlock,
      onWindow: (s) => {
        done++;
        progress({ phase: 'scan', windowsDone: done, windowsTotal, block: s.nextBlock - 1 });
        if (done % 10 === 0) writeCache(o.store, key, entry);
        aborted(); // the window just merged is kept; a later run resumes from here
      },
    });
  } finally {
    writeCache(o.store, key, entry);
  }

  progress({ phase: 'chain', windowsDone: windowsTotal, windowsTotal, block: endBlock });
  const logs = Object.values(entry.state.logs).filter((l) => Number(BigInt(l.blockNumber)) <= endBlock);
  const events: KuruEvent[] = eventsOf(entry.state).filter((e) => e.block <= endBlock);
  const approvalHashes = Object.entries(entry.approvals).filter(([, b]) => b <= endBlock).map(([h]) => h);
  const inRange = new Set(events.map((e) => e.tx));
  const hashes = [...new Set([...candidateOwnTxs(entry.state).filter((h) => inRange.has(h)), ...approvalHashes])];
  const txs = await rpc.ownTxs(account, hashes);
  aborted();

  const ledger = buildLedger({ account, markets: [market], events, txs, untilBlock: endBlock });
  const orderIds = [...ledger.orders.values()].map((x) => ({ market: x.market, id: x.id }));
  const chain = await rpc.chainState({ account, marginAccount: cfg.marginAccount, markets: [market], orderIds, block: endBlock, wallet: true });
  aborted();
  let book: Book | null = null;
  try {
    book = await rpc.bestBidAsk(market, endBlock);
  } catch {
    book = null; // empty book: market-value fields will say n/a
  }
  progress({ phase: 'done', windowsDone: windowsTotal, windowsTotal, block: endBlock });
  return { account, market, symbols: cfg.symbols, marginAccount: cfg.marginAccount.toLowerCase(), startBlock: o.startBlock, endBlock, logs, txs, chain, book };
}
