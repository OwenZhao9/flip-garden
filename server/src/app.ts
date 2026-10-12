// The request handler and the scheduled job, with every outside dependency injected so tests never touch a network.
import { marketFromJson, type Market } from '../../src/units.ts';
import { corsHeaders, originAllowed } from './cors.ts';
import { rankRecords } from './rank.ts';
import { Limiter } from './ratelimit.ts';
import { Budget, historySlice, recordKey, scanWallet } from './scanner.ts';
import { isAddress, parseRegistration } from './validate.ts';
import type { BoardRow, Chain, Config, Env, KV, WalletRecord } from './types.ts';

export type Deps = { chain: Chain; fallbackChain?: Chain; now: () => number; limiters?: { read: Limiter; write: Limiter } };

const INDEX_KEY = 'index';
const BOARD_KEY = 'board';
const MARKET_KEY = 'market';

export function configOf(env: Env): Config {
  const n = (v: string | undefined, d: number): number => (v !== undefined && /^\d+$/.test(v) ? Number(v) : d);
  return { market: env.MARKET.toLowerCase(), marginAccount: env.MARGIN_ACCOUNT.toLowerCase(), marketFirstBlock: n(env.MARKET_FIRST_BLOCK, 0), maxWallets: n(env.MAX_WALLETS, 500), maxRpcCallsPerRun: n(env.MAX_RPC_CALLS_PER_RUN, 40) };
}

const readJson = async <T>(kv: KV, key: string): Promise<T | null> => {
  const s = await kv.get(key);
  return s ? (JSON.parse(s) as T) : null;
};

const json = (body: unknown, status: number, origin: string | null, extra: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(origin), ...extra } });

const label = { ranking: 'completed round trips, then garden age in days; never profit' };

export async function handle(req: Request, env: Env, deps: Deps): Promise<Response> {
  const origin = req.headers.get('origin');
  const url = new URL(req.url);
  const cfg = configOf(env);
  if (origin !== null && !originAllowed(origin)) return json({ error: 'Origin not allowed.' }, 403, null);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });

  const lim = deps.limiters;
  const writing = req.method === 'POST';
  if (lim && !(writing ? lim.write : lim.read).allow(deps.now())) return json({ error: 'Too many requests. Try again in a minute.' }, 429, origin, { 'retry-after': '60' });

  if (req.method === 'GET' && url.pathname === '/leaderboard') {
    const board = await readJson<{ rows: BoardRow[]; updatedAt: string | null }>(env.KV, BOARD_KEY);
    return json({ ...label, updatedAt: board?.updatedAt ?? null, rows: board?.rows ?? [] }, 200, origin, { 'cache-control': 'public, max-age=60' });
  }

  const h = url.pathname.match(/^\/history\/([^/]+)$/);
  if (req.method === 'GET' && h) {
    if (!isAddress(h[1])) return json({ error: 'Not an address.' }, 400, origin);
    const fromQ = url.searchParams.get('from');
    const from = fromQ !== null && /^\d{1,12}$/.test(fromQ) ? Number(fromQ) : NaN;
    if (!Number.isSafeInteger(from) || from < cfg.marketFirstBlock) return json({ error: `from must be a block number at or after ${cfg.marketFirstBlock}.` }, 400, origin);
    const budget = new Budget(cfg.maxRpcCallsPerRun);
    try {
      const market = await marketOf(env.KV, deps.chain, cfg, budget);
      const slice = await historySlice(deps.chain, deps.fallbackChain, cfg, market.quoteAsset, h[1].toLowerCase(), from, budget);
      return json({ ...slice }, 200, origin, { 'cache-control': 'no-store' });
    } catch {
      return json({ error: 'The history could not be read right now. Try again later.' }, 503, origin);
    }
  }

  const g = url.pathname.match(/^\/garden\/([^/]+)$/);
  if (req.method === 'GET' && g) {
    if (!isAddress(g[1])) return json({ error: 'Not an address.' }, 400, origin);
    const rec = await readJson<WalletRecord>(env.KV, recordKey(g[1].toLowerCase()));
    if (!rec) return json({ error: 'This wallet is not registered.' }, 404, origin);
    const f = rec.figures;
    return json({ ...label, address: rec.address, registered: true, startBlock: rec.startBlock, scannedTo: rec.nextBlock - 1, catchingUp: rec.catchingUp, figures: f ? { completedRoundTrips: f.completedRoundTrips, gardenAgeDays: f.gardenAgeDays, level: f.level, updatedAt: f.updatedAt } : null }, 200, origin, { 'cache-control': 'public, max-age=60' });
  }

  if (req.method === 'POST' && url.pathname === '/register') {
    const text = await req.text();
    let head: number;
    try {
      head = await deps.chain.blockNumber();
    } catch {
      return json({ error: 'The chain could not be reached. Try again later.' }, 503, origin);
    }
    const parsed = parseRegistration(text, { marketFirstBlock: cfg.marketFirstBlock, head });
    if (!parsed.ok) return json({ error: parsed.error }, parsed.status, origin);
    const { address, startBlock } = parsed.value;
    const existing = await readJson<WalletRecord>(env.KV, recordKey(address));
    if (existing) return json({ ...label, address, registered: true, alreadyRegistered: true, startBlock: existing.startBlock }, 200, origin);
    const index = (await readJson<string[]>(env.KV, INDEX_KEY)) ?? [];
    if (index.length >= cfg.maxWallets) return json({ error: `The leaderboard is full (${cfg.maxWallets} wallets).` }, 409, origin);
    const rec: WalletRecord = { address, startBlock, registeredAt: new Date(deps.now()).toISOString(), nextBlock: startBlock, catchingUp: true, figures: null };
    // Not atomic (KV has no transactions): two simultaneous registrations could pass the cap by a small margin; the cron job
    // never ranks more than maxWallets.
    await env.KV.put(recordKey(address), JSON.stringify(rec));
    await env.KV.put(INDEX_KEY, JSON.stringify([...index, address]));
    return json({ ...label, address, registered: true, alreadyRegistered: false, startBlock }, 201, origin);
  }

  return json({ error: 'Not found.' }, 404, origin);
}

async function marketOf(kv: KV, chain: Chain, cfg: Config, budget: Budget): Promise<Market> {
  const cached = await readJson<Record<string, unknown>>(kv, MARKET_KEY);
  if (cached) return marketFromJson(cached, cfg.market);
  budget.take();
  const m = await chain.marketParams(cfg.market);
  await kv.put(MARKET_KEY, JSON.stringify(m, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  return m;
}

export type CronResult = { scanned: string[]; failed: Record<string, string>; ranked: number };

// One scheduled run: wallets with the oldest figures first, a bounded number of RPC requests in total, then the board.
export async function runScheduled(env: Env, deps: Deps): Promise<CronResult> {
  const cfg = configOf(env);
  const budget = new Budget(cfg.maxRpcCallsPerRun);
  const index = ((await readJson<string[]>(env.KV, INDEX_KEY)) ?? []).slice(0, cfg.maxWallets);
  const records = (await Promise.all(index.map((a) => readJson<WalletRecord>(env.KV, recordKey(a))))).filter((r): r is WalletRecord => r !== null);
  const result: CronResult = { scanned: [], failed: {}, ranked: 0 };
  const now = new Date(deps.now()).toISOString();
  let market: Market | null = null;
  try {
    market = await marketOf(env.KV, deps.chain, cfg, budget);
  } catch (e) {
    result.failed['market'] = String((e as Error).message);
  }
  const byAge = [...records].sort((a, b) => (a.figures?.updatedAt ?? '').localeCompare(b.figures?.updatedAt ?? ''));
  const updated = new Map(records.map((r) => [r.address, r]));
  if (market) {
    for (const rec of byAge) {
      if (budget.left < 5) break;
      try {
        const next = await scanWallet(env.KV, deps.chain, cfg, market, rec, budget, now, deps.fallbackChain);
        updated.set(rec.address, next);
        await env.KV.put(recordKey(rec.address), JSON.stringify(next));
        result.scanned.push(rec.address);
      } catch (e) {
        result.failed[rec.address] = String((e as Error).message);
        if (/budget exhausted/.test(String((e as Error).message))) break;
      }
    }
  }
  const rows = rankRecords([...updated.values()]);
  await env.KV.put(BOARD_KEY, JSON.stringify({ updatedAt: now, rows }));
  result.ranked = rows.length;
  return result;
}
