// Market units and rounding. Generic: nothing here assumes MON-USDC.
//
// Kuru units (read from getMarketParams; MON-USDC values in docs/FINDINGS.md):
//   order price : price-precision units  (quote per 1 whole base unit) × pricePrecision
//   order size  : size-precision units   (whole base units) × sizePrecision
//   event price : 1e18-scaled (Trade.price, bestBidAsk)
//   token amount: raw, at the token's decimals
//
// Rounding rule (docs/LEDGER.md): when an amount is not exact, what the user RECEIVES rounds
// down and what the user PAYS or LOCKS rounds up. The contract's own rounding is unverified
// for inexact amounts, so every inexact conversion is also counted as one unit of rounding
// uncertainty; reconciliation allows exactly that much difference and no more.
import { q, type Q } from './rational.ts';

export type Market = {
  address: string; // lowercase
  name?: string;
  baseAsset: string; // lowercase token address; 0x000…0 = native
  quoteAsset: string;
  baseDecimals: number;
  quoteDecimals: number;
  pricePrecision: bigint;
  sizePrecision: bigint;
  tickSize: bigint;
  minSize: bigint;
  maxSize?: bigint;
  makerFeeBps: bigint;
  takerFeeBps: bigint;
};

export const NATIVE = '0x0000000000000000000000000000000000000000';
export const BPS = 10_000n;

export type Rounding = 'down' | 'up';

// An integer amount plus whether rounding was needed to get it.
export type Amount = { value: bigint; exact: boolean };

export function mulDiv(a: bigint, b: bigint, d: bigint, rounding: Rounding): Amount {
  if (d <= 0n) throw new Error('mulDiv: denominator must be positive');
  if (a < 0n || b < 0n) throw new Error('mulDiv: negative input');
  const p = a * b;
  const r = p % d;
  const t = p / d;
  return { value: rounding === 'up' && r !== 0n ? t + 1n : t, exact: r === 0n };
}

export function log10Exact(x: bigint): number {
  if (x < 1n) throw new Error('log10Exact: value must be >= 1');
  let n = 0;
  while (x > 1n) {
    if (x % 10n !== 0n) throw new Error(`log10Exact: ${x} is not a power of ten`);
    x /= 10n;
    n++;
  }
  return n;
}

// Quote raw for `size` at `price` (both in market units).
export function quoteForSize(size: bigint, price: bigint, m: Market, rounding: Rounding): Amount {
  return mulDiv(size * price, 10n ** BigInt(m.quoteDecimals), m.sizePrecision * m.pricePrecision, rounding);
}

// Base raw for `size`.
export function baseForSize(size: bigint, m: Market, rounding: Rounding): Amount {
  return mulDiv(size, 10n ** BigInt(m.baseDecimals), m.sizePrecision, rounding);
}

// Fee on an amount the user receives. Unverified model (all observed fees are 0 bps):
// the fee is taken from the received token and rounds up (the user never gets more than due).
export function feeOn(amount: bigint, bps: bigint): Amount {
  return mulDiv(amount, bps, BPS, 'up');
}

// 1e18-scaled event price -> order price units. Must be exact for a maker fill (the event
// carries the resting order's own price); an inexact value is reported, never rounded silently.
export function eventPriceToOrderPrice(price1e18: bigint, m: Market): Amount {
  const shift = 18 - log10Exact(m.pricePrecision);
  if (shift < 0) throw new Error('pricePrecision above 1e18 is not supported');
  const f = 10n ** BigInt(shift);
  return { value: price1e18 / f, exact: price1e18 % f === 0n };
}

// Order price -> exact rational "quote raw per base raw" (what a mark price means in raw units).
export function priceRaw(price: Q | bigint, m: Market): Q {
  const p = typeof price === 'bigint' ? q(price) : price;
  return q(p.n * 10n ** BigInt(m.quoteDecimals), p.d * m.pricePrecision * 10n ** BigInt(m.baseDecimals));
}

export function formatUnits(value: bigint, decimals: number, maxFrac?: number): string {
  const neg = value < 0n;
  const v = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  let frac = (v % base).toString().padStart(decimals, '0');
  if (maxFrac !== undefined) frac = frac.slice(0, maxFrac);
  frac = frac.replace(/0+$/, '');
  return `${neg ? '-' : ''}${(v / base).toString()}${frac ? '.' + frac : ''}`;
}

export function parseUnits(str: string, decimals: number): bigint {
  const s = String(str).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`invalid amount: "${str}"`);
  const [w, f = ''] = s.split('.');
  if (f.length > decimals) throw new Error(`"${str}" has more than ${decimals} decimals`);
  return BigInt(w) * 10n ** BigInt(decimals) + BigInt(f.padEnd(decimals, '0') || '0');
}

// Market params as stored in JSON (strings) -> Market.
export function marketFromJson(j: Record<string, unknown>, address: string): Market {
  const s = (k: string): string => String(j[k]);
  return {
    address: address.toLowerCase(),
    name: j.name === undefined ? undefined : s('name'),
    baseAsset: (j.baseAsset === undefined ? NATIVE : s('baseAsset')).toLowerCase(),
    quoteAsset: s('quoteAsset').toLowerCase(),
    baseDecimals: Number(j.baseDecimals),
    quoteDecimals: Number(j.quoteDecimals),
    pricePrecision: BigInt(s('pricePrecision')),
    sizePrecision: BigInt(s('sizePrecision')),
    tickSize: BigInt(s('tickSize')),
    minSize: BigInt(s('minSize')),
    maxSize: j.maxSize === undefined ? undefined : BigInt(s('maxSize')),
    makerFeeBps: BigInt(s('makerFeeBps')),
    takerFeeBps: BigInt(s('takerFeeBps')),
  };
}
