// The small note the planting page keeps in the browser so a reload can find the orders it planted.
// Pure functions: a corrupt or foreign note must never break the page, so every field is validated.
export type PlantNote = { startBlock?: number; orderIds: bigint[] };

export function serializeNote(n: PlantNote): string {
  return JSON.stringify({ startBlock: n.startBlock ?? null, orderIds: n.orderIds.map(String) });
}

export function parseNote(text: string | null): PlantNote {
  const out: PlantNote = { orderIds: [] };
  if (!text) return out;
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return out;
  }
  if (typeof j !== 'object' || j === null) return out;
  const o = j as { startBlock?: unknown; orderIds?: unknown };
  if (typeof o.startBlock === 'number' && Number.isInteger(o.startBlock) && o.startBlock >= 0) out.startBlock = o.startBlock;
  if (Array.isArray(o.orderIds)) for (const x of o.orderIds) if (typeof x === 'string' && /^\d{1,20}$/.test(x)) out.orderIds.push(BigInt(x));
  return out;
}
