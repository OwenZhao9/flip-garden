// Finds where an account's planting starts when this browser does not know it (a new browser, or site data cleared).
// First the leaderboard Worker, which can search the market's whole life through Envio in one query; then, for a recent
// account, the public RPC: the block where the account sent its first transaction, found by bisecting its nonce over
// the state the node still keeps. Read-only. Returns undefined when neither can tell; the page then asks for the block.

export type NonceRpc = { call<T>(method: string, params: unknown[]): Promise<T> };

const hex = (n: number): string => '0x' + n.toString(16);

async function fromWorker(historyUrl: string, account: string, f: typeof fetch): Promise<number | null | undefined> {
  try {
    const res = await f(`${historyUrl.replace(/\/$/, '')}/start/${account}`, { headers: { accept: 'application/json' } });
    if (!res.ok) return undefined;
    const j = (await res.json()) as { startBlock?: unknown };
    if (j.startBlock === null) return null; // the account never approved USDC to Kuru: nothing was planted
    return typeof j.startBlock === 'number' && Number.isSafeInteger(j.startBlock) && j.startBlock > 0 ? j.startBlock : undefined;
  } catch {
    return undefined;
  }
}

// How far back the public node keeps state is not documented; about 2.3 million blocks on 2026-10-13. Try a few depths.
const DEPTHS = [2_000_000, 1_000_000, 300_000];

async function fromNonce(rpc: NonceRpc, account: string): Promise<number | undefined> {
  const nonceAt = async (b: number | 'latest'): Promise<number> => Number(BigInt(await rpc.call<string>('eth_getTransactionCount', [account, b === 'latest' ? b : hex(b)])));
  try {
    const head = Number(BigInt(await rpc.call<string>('eth_blockNumber', [])));
    if ((await nonceAt(head)) === 0) return undefined; // never sent anything
    for (const depth of DEPTHS) {
      let lo = Math.max(0, head - depth);
      let n: number;
      try {
        n = await nonceAt(lo);
      } catch {
        continue; // state that old is gone: try a shallower depth
      }
      if (n > 0) return undefined; // the first transaction is older than the state the node keeps
      let hi = head; // nonce(lo) = 0 < nonce(hi)
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if ((await nonceAt(mid)) > 0) hi = mid;
        else lo = mid;
      }
      return lo; // the block just before the first transaction
    }
  } catch {
    /* the RPC failed: the page asks for the block */
  }
  return undefined;
}

export async function findStartBlock(o: { account: string; historyUrl?: string; rpc: NonceRpc; fetch: typeof fetch }): Promise<number | undefined> {
  if (o.historyUrl) {
    const w = await fromWorker(o.historyUrl, o.account, o.fetch);
    if (w === null) return undefined;
    if (w !== undefined) return w;
  }
  return fromNonce(o.rpc, o.account);
}
