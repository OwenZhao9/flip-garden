// Garden age in real seconds, from two block timestamps read from the node. A block time is never assumed.
import type { JsonRpc } from '../../src/rpc.ts';

// A block's timestamp never changes, so it is read once. (Tests start a new fake chain with the same block numbers.)
const cache = new Map<number, number>();
export const clearBlockTimes = (): void => cache.clear();

async function timestampOf(rpc: JsonRpc, block: number): Promise<number> {
  const hit = cache.get(block);
  if (hit !== undefined) return hit;
  const b = await rpc.call<{ timestamp?: string } | null>('eth_getBlockByNumber', ['0x' + block.toString(16), false]);
  if (!b || typeof b.timestamp !== 'string') throw new Error(`block ${block} has no timestamp`);
  const t = Number(BigInt(b.timestamp));
  if (cache.size > 500) cache.clear(); // a long session refreshes every few seconds: keep this small
  cache.set(block, t);
  return t;
}

// null when the node cannot say: the page then shows the age as unknown instead of guessing.
export async function ageSecondsBetween(rpc: JsonRpc, firstBlock: number | null, lastBlock: number | null): Promise<number | null> {
  if (firstBlock === null || lastBlock === null || lastBlock < firstBlock) return null;
  try {
    const [a, b] = await Promise.all([timestampOf(rpc, firstBlock), timestampOf(rpc, lastBlock)]);
    return Math.max(0, b - a);
  } catch {
    return null;
  }
}
