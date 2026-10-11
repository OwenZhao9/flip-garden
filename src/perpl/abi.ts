// Minimal ABI helpers for the Perpl exchange (no dependencies; ethers is used in tests only).
// Everything the exchange takes or returns here is a static type (uint, int, bool, address),
// so a call is a 4-byte selector followed by 32-byte words, and a result is 32-byte words.
import { keccak256 } from '../keccak.ts';

const MAX_UINT256 = (1n << 256n) - 1n;

export const selector = (signature: string): string => keccak256(signature).slice(0, 10);
export const topic0 = (signature: string): string => keccak256(signature);

export function uintWord(x: bigint | number, what = 'value'): string {
  const v = BigInt(x);
  if (v < 0n || v > MAX_UINT256) throw new Error(`${what} does not fit uint256: ${v}`);
  return v.toString(16).padStart(64, '0');
}

export function intWord(x: bigint | number, what = 'value'): string {
  const v = BigInt(x);
  if (v < -(1n << 255n) || v >= 1n << 255n) throw new Error(`${what} does not fit int256: ${v}`);
  return (v < 0n ? v + (1n << 256n) : v).toString(16).padStart(64, '0');
}

export function boolWord(b: boolean): string {
  return uintWord(b ? 1n : 0n);
}

export function addressWord(a: string, what = 'address'): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error(`${what} is not an address: ${a}`);
  return a.slice(2).toLowerCase().padStart(64, '0');
}

export function splitWords(data: string): string[] {
  const h = data.startsWith('0x') ? data.slice(2) : data;
  if (h.length % 64 !== 0) throw new Error(`ABI data is not a whole number of words (${h.length} hex chars)`);
  return h.length === 0 ? [] : (h.match(/.{64}/g) as string[]);
}

export const wordToUint = (w: string): bigint => BigInt('0x' + w);
export const wordToInt = (w: string): bigint => {
  const v = BigInt('0x' + w);
  return v >= 1n << 255n ? v - (1n << 256n) : v;
};
export const wordToAddress = (w: string): string => '0x' + w.slice(24);
export const wordToBool = (w: string): boolean => wordToUint(w) !== 0n;

export const call = (signature: string, ...words: string[]): string => selector(signature) + words.join('');
