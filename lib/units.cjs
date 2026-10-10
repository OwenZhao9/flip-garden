'use strict';
// Pure helpers for Kuru unit math. No dependencies; everything is BigInt.
//
// Kuru units (MON-USDC, verified on-chain 2026-10-10):
//   order price  : uint32, "price precision" units (1e8 -> 1 USDC = 100_000_000)
//   order size   : uint96, "size precision" units  (1e10 -> 1 MON  = 10_000_000_000)
//   event price  : uint256, 1e18-scaled (bestBidAsk() and Trade.price)
//   USDC = 6 decimals, MON (native, zero address) = 18 decimals

function log10Exact(x) {
  let v = BigInt(x);
  let n = 0;
  if (v < 1n) throw new Error('log10Exact: value must be >= 1');
  while (v > 1n) {
    if (v % 10n !== 0n) throw new Error(`log10Exact: ${x} is not a power of ten`);
    v /= 10n;
    n += 1;
  }
  return n;
}

function alignDown(x, tick) {
  return x - (x % tick);
}

function alignUp(x, tick) {
  const r = x % tick;
  return r === 0n ? x : x + (tick - r);
}

function mulDiv(a, b, d, roundUp = false) {
  const p = a * b;
  const q = p / d;
  return roundUp && p % d !== 0n ? q + 1n : q;
}

// 1e18-scaled event/bestBidAsk price -> order price in price-precision units.
function eventPriceToRaw(price1e18, pricePrecision) {
  const shift = 18 - log10Exact(pricePrecision);
  if (shift < 0) throw new Error('pricePrecision above 1e18 is not supported');
  return BigInt(price1e18) / 10n ** BigInt(shift);
}

// Quote-token amount (raw, quoteDecimals) locked by / paid for `sizeRaw` at `priceRaw`.
function quoteForSize(sizeRaw, priceRaw, mp, roundUp = false) {
  return mulDiv(
    sizeRaw * priceRaw,
    10n ** BigInt(mp.quoteDecimals),
    mp.sizePrecision * mp.pricePrecision,
    roundUp,
  );
}

// Base-token amount (raw, baseDecimals) for `sizeRaw`.
function baseForSize(sizeRaw, mp) {
  return mulDiv(sizeRaw, 10n ** BigInt(mp.baseDecimals), mp.sizePrecision);
}

function formatUnits(value, decimals, maxFrac) {
  const v0 = BigInt(value);
  const neg = v0 < 0n;
  const v = neg ? -v0 : v0;
  const base = 10n ** BigInt(decimals);
  let frac = (v % base).toString().padStart(decimals, '0');
  if (maxFrac !== undefined) frac = frac.slice(0, maxFrac);
  frac = frac.replace(/0+$/, '');
  return `${neg ? '-' : ''}${(v / base).toString()}${frac ? '.' + frac : ''}`;
}

// Decimal string ("201", "4.95") -> raw BigInt at `decimals`. Rejects extra precision.
function parseUnits(str, decimals) {
  const s = String(str).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`invalid amount: "${str}"`);
  const [w, f = ''] = s.split('.');
  if (f.length > decimals) throw new Error(`"${str}" has more than ${decimals} decimals`);
  return BigInt(w) * 10n ** BigInt(decimals) + BigInt(f.padEnd(decimals, '0') || '0');
}

// One-sided ladder of flip BIDS (buy now, auto-sell at flipPrice after the fill).
// All prices are price-precision BigInt. Tick-aligned, strictly below the best ask
// (flip orders must not cross the book).
function buildBidLadder({
  bestBid,
  bestAsk,
  tick,
  count,
  sizeRaw,
  offsetTicks = 1n,
  stepBps = 10n,
  spreadBps = 10n,
}) {
  if (!(count >= 1)) throw new Error('count must be >= 1');
  if (bestBid <= 0n || bestAsk <= bestBid) throw new Error('book is empty or crossed');
  let top = bestBid + offsetTicks * tick;
  if (top >= bestAsk) top = bestAsk - tick;
  if (top <= 0n) throw new Error('top price is not positive');
  const out = [];
  let prev = null;
  for (let i = 0; i < count; i++) {
    let price = alignDown((top * (10000n - BigInt(i) * stepBps)) / 10000n, tick);
    if (prev !== null && price >= prev) price = prev - tick;
    if (price <= 0n) throw new Error('ladder reaches non-positive price');
    let flip = alignUp((price * (10000n + spreadBps)) / 10000n, tick);
    if (flip < price + 2n * tick) flip = price + 2n * tick;
    out.push({ price, flipPrice: flip, liquidity: sizeRaw });
    prev = price;
  }
  return out;
}

module.exports = {
  log10Exact,
  alignDown,
  alignUp,
  mulDiv,
  eventPriceToRaw,
  quoteForSize,
  baseForSize,
  formatUnits,
  parseUnits,
  buildBidLadder,
};
