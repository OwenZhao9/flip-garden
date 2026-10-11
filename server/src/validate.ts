// Strict input validation for POST /register. Pure.
export const MAX_BODY_BYTES = 512;

export type Registration = { address: string; startBlock: number };
export type Checked<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export const isAddress = (s: unknown): s is string => typeof s === 'string' && ADDRESS.test(s);

export function parseRegistration(bodyText: string, limits: { marketFirstBlock: number; head: number }): Checked<Registration> {
  if (bodyText.length > MAX_BODY_BYTES) return { ok: false, status: 413, error: 'Request body too large.' };
  let j: unknown;
  try {
    j = JSON.parse(bodyText);
  } catch {
    return { ok: false, status: 400, error: 'Body must be JSON.' };
  }
  if (typeof j !== 'object' || j === null || Array.isArray(j)) return { ok: false, status: 400, error: 'Body must be a JSON object.' };
  const o = j as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => k !== 'address' && k !== 'startBlock');
  if (extra.length) return { ok: false, status: 400, error: `Unknown field: ${extra[0].slice(0, 32)}.` };
  if (!isAddress(o.address)) return { ok: false, status: 400, error: 'address must be a 0x-prefixed 40-hex-digit address.' };
  const address = o.address.toLowerCase();
  if (/^0x0{40}$/.test(address)) return { ok: false, status: 400, error: 'The zero address cannot be registered.' };
  const b = o.startBlock;
  if (typeof b !== 'number' || !Number.isSafeInteger(b)) return { ok: false, status: 400, error: 'startBlock must be a whole number.' };
  if (b < limits.marketFirstBlock) return { ok: false, status: 400, error: `startBlock is older than the market's first block (${limits.marketFirstBlock}).` };
  if (b > limits.head) return { ok: false, status: 400, error: 'startBlock is in the future.' };
  return { ok: true, value: { address, startBlock: b } };
}
