// Cloudflare Worker entry: HTTP routes and the Cron Trigger. Read-only: no key, no signing, no transaction.
import { JsonRpc } from '../../src/rpc.ts';
import type { Market } from '../../src/units.ts';
import { handle, runScheduled, type Deps } from './app.ts';
import { Limiter } from './ratelimit.ts';
import type { Chain, Env } from './types.ts';


// Per-isolate coarse limits (no IP is stored); see ratelimit.ts.
const limiters = { read: new Limiter(300), write: new Limiter(20), decide: new Limiter(120) };

function chainOf(env: Env): Chain {
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

const deps = (env: Env): Deps => ({ chain: chainOf(env), now: () => Date.now(), limiters });

export default {
  fetch: (req: Request, env: Env): Promise<Response> => handle(req, env, deps(env)),
  scheduled: (_event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): void => {
    ctx.waitUntil(runScheduled(env, deps(env)));
  },
};
