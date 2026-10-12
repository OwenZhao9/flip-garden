// Cloudflare Worker entry: HTTP routes and the Cron Trigger. Read-only: no key, no signing, no transaction.
import { JsonRpc } from '../../src/rpc.ts';
import { HyperSyncSource } from '../../src/hypersync.ts';
import type { Market } from '../../src/units.ts';
import { handle, runScheduled, type Deps } from './app.ts';
import { Limiter } from './ratelimit.ts';
import type { Chain, Env } from './types.ts';


// Per-isolate coarse limits (no IP is stored); see ratelimit.ts.
const limiters = { read: new Limiter(300), write: new Limiter(20) };

function rpcChain(env: Env): Chain {
  const rpc = new JsonRpc(env.RPC_URL ?? 'https://rpc.monad.xyz', { retries: 1 });
  return {
    blockNumber: () => rpc.blockNumber(),
    getLogs: (f) => rpc.getLogs(f),
    marketParams: (a: string): Promise<Market> => rpc.marketParams(a),
    blockTimestamp: async (b) => {
      const blk = await rpc.call<{ timestamp?: string } | null>('eth_getBlockByNumber', ['0x' + b.toString(16), false]);
      if (!blk || typeof blk.timestamp !== 'string') throw new Error(`block ${b} has no timestamp`);
      return Number(BigInt(blk.timestamp));
    },
  };
}

// With an Envio token the logs come from HyperSync in wide windows; without one (or when it fails) the public RPC is used.
// HyperSyncSource has no RPC fallback of its own here: a wide window cannot be replayed in 90-block calls inside one
// invocation's request limit, so the scanner switches source instead (see scanWallet).
export function chainsOf(env: Env): { chain: Chain; fallbackChain?: Chain } {
  const rpc = rpcChain(env);
  if (!env.ENVIO_API_TOKEN) return { chain: rpc };
  const hs = new HyperSyncSource({ url: env.ENVIO_URL ?? 'https://monad.hypersync.xyz', token: env.ENVIO_API_TOKEN, fallback: null, retries: 1 });
  const w = Number(env.ENVIO_WINDOW_BLOCKS);
  return { chain: { ...rpc, blockNumber: () => rpc.blockNumber(), getLogs: (f) => hs.getLogs(f), windowBlocks: Number.isInteger(w) && w >= 90 ? w : 25_000 }, fallbackChain: rpc };
}

const deps = (env: Env): Deps => ({ ...chainsOf(env), now: () => Date.now(), limiters });

export default {
  fetch: (req: Request, env: Env): Promise<Response> => handle(req, env, deps(env)),
  scheduled: (_event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): void => {
    ctx.waitUntil(runScheduled(env, deps(env)));
  },
};
