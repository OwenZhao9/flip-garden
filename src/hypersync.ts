// Read-only log source on Envio HyperSync (plain HTTP, no client library). It implements `LogSource` (see scan.ts) so the
// ledger code cannot tell it apart from the public RPC; any failure falls back to that RPC in windows it accepts.
//
// HyperSync's `to_block` is exclusive and a response may stop early: `next_block` says where to continue.
// The API token is sent as a bearer header and must never reach a browser page (see server/ for the proxy).
import type { RawLog } from './events.ts';
import type { LogFilter, LogSource } from './scan.ts';
import { planWindows } from './scan.ts';

export const HYPERSYNC_WINDOW_BLOCKS = 250_000;
export const RPC_WINDOW_BLOCKS = 90;

type HsLog = {
  block_number?: number | string;
  log_index?: number | string;
  transaction_hash?: string;
  address?: string;
  data?: string;
  topic0?: string | null;
  topic1?: string | null;
  topic2?: string | null;
  topic3?: string | null;
};
type HsResponse = { data?: Array<{ logs?: HsLog[] }>; next_block?: number; archive_height?: number | null };

export type HyperSyncOptions = {
  url: string; // e.g. https://monad.hypersync.xyz, or a proxy exposing the same /height and /query routes
  token?: string; // bearer token; omit when the url is a proxy that adds it
  fallback: LogSource | null; // the public RPC; null means errors are thrown to the caller, who switches source itself
  fetch?: typeof fetch;
  retries?: number;
  maxPages?: number; // per getLogs call; a stuck cursor is an error, not a loop
  onSource?: (s: 'hypersync' | 'rpc') => void; // which source answered the last call (for reports and tests)
};

export class HyperSyncSource implements LogSource {
  private o: HyperSyncOptions;
  requests = 0;
  constructor(o: HyperSyncOptions) {
    this.o = o;
  }

  private async http(path: string, init?: RequestInit): Promise<unknown> {
    const f = this.o.fetch ?? fetch;
    const retries = this.o.retries ?? 3;
    for (let i = 0; ; i++) {
      try {
        this.requests++;
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (this.o.token) headers.authorization = `Bearer ${this.o.token}`;
        const res = await f(this.o.url.replace(/\/$/, '') + path, { ...init, headers });
        if (res.status === 429 && i < retries) {
          // The free plan allows 15 queries a minute; the response says how many seconds until the window resets.
          const reset = Number(res.headers.get('x-ratelimit-reset'));
          await new Promise((r) => setTimeout(r, Number.isFinite(reset) && reset > 0 ? Math.min(reset, 20) * 1000 + 200 : 500 * 2 ** i));
          continue;
        }
        // Never put the response body in the message: an error page could echo a credential.
        if (!res.ok) throw new Error(`HyperSync ${path}: HTTP ${res.status}`);
        return await res.json();
      } catch (e) {
        if (i >= retries) throw e;
        await new Promise((r) => setTimeout(r, 300 * 2 ** i));
      }
    }
  }

  async blockNumber(): Promise<number> {
    try {
      const j = (await this.http('/height')) as { height?: number };
      if (typeof j.height !== 'number') throw new Error('HyperSync /height: no height');
      return j.height;
    } catch {
      if (!this.o.fallback) throw new Error('HyperSync /height failed');
      this.o.onSource?.('rpc');
      return this.o.fallback.blockNumber();
    }
  }

  async getLogs(f: LogFilter): Promise<RawLog[]> {
    try {
      const logs = await this.query(f);
      this.o.onSource?.('hypersync');
      return logs;
    } catch (e) {
      const fb = this.o.fallback;
      if (!fb) throw e;
      this.o.onSource?.('rpc');
      const out: RawLog[] = [];
      for (const [a, b] of planWindows(f.fromBlock, f.toBlock, RPC_WINDOW_BLOCKS)) out.push(...(await fb.getLogs({ ...f, fromBlock: a, toBlock: b })));
      return out;
    }
  }

  private async query(f: LogFilter): Promise<RawLog[]> {
    const out: RawLog[] = [];
    let from = f.fromBlock;
    const end = f.toBlock + 1; // exclusive
    for (let page = 0; from < end; page++) {
      if (page >= (this.o.maxPages ?? 200)) throw new Error('HyperSync: too many pages');
      const body = {
        from_block: from,
        to_block: end,
        logs: [{ address: [f.address], topics: f.topics }],
        field_selection: { log: ['block_number', 'log_index', 'transaction_hash', 'address', 'data', 'topic0', 'topic1', 'topic2', 'topic3'] },
      };
      const j = (await this.http('/query', { method: 'POST', body: JSON.stringify(body) })) as HsResponse;
      for (const chunk of j.data ?? []) for (const l of chunk.logs ?? []) out.push(toRaw(l));
      const next = j.next_block;
      if (typeof next !== 'number' || next <= from) throw new Error('HyperSync: the cursor did not advance');
      from = next;
    }
    return out;
  }
}

function toRaw(l: HsLog): RawLog {
  if (l.block_number === undefined || l.log_index === undefined || !l.transaction_hash || !l.address || l.data === undefined) throw new Error('HyperSync: incomplete log');
  const topics = [l.topic0, l.topic1, l.topic2, l.topic3].filter((t): t is string => typeof t === 'string').map((t) => t.toLowerCase());
  // Same shape as an eth_getLogs answer (hex quantities), so a scan state is identical whichever source filled it.
  const hex = (n: number | string): string => '0x' + BigInt(n).toString(16);
  return { address: l.address.toLowerCase(), topics, data: l.data.toLowerCase(), blockNumber: hex(l.block_number), transactionHash: l.transaction_hash.toLowerCase(), logIndex: hex(l.log_index) };
}
