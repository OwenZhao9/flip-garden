// Profit and loss on top of a ledger. Exact rationals inside; round once at the edge
// (rational.floor: toward negative infinity, so a gain is never overstated).
//
// Definitions (docs/LEDGER.md):
// - A lot is base bought (long) or sold (short) by one fill and not yet matched.
// - A cycle ("一圈") is a buy matched against a sell. A fill first closes lots of the order
//   that flipped into it (the flip chain), then the oldest open lots (FIFO).
// - realized   = Σ cycle (sell quote − buy quote), gross of fees.
// - unrealized = open lots valued at a mark price minus their cost. Two marks:
//     mid        = (best bid + best ask) / 2
//     executable = what closing would get right now: long lots sell into bids, short lots buy
//                  from asks. Uses the depth you pass; with only best bid/ask it ignores depth.
// - total(mark) = realized + unrealized(mark) − fees(mark); gas is reported next to it.
// Identity (tested): total(P) = Σ fill quote flows + Σ fill base flows × P − fees(P).
import type { Ledger } from './ledger.ts';
import { orderKey } from './ledger.ts';
import { NATIVE, baseForSize, priceRaw, type Market } from './units.ts';
import { add, mul, q, sub, ZERO, type Q, cmp, div, floor } from './rational.ts';

export type Level = { price: bigint; size: bigint }; // order-price units, size units
export type Book = {
  bestBid: bigint;
  bestAsk: bigint;
  bids?: Level[]; // best first
  asks?: Level[];
};

export type Lot = {
  fillKey: string;
  orderId: bigint;
  dir: 'long' | 'short';
  base: bigint; // raw base still open
  quote: Q; // cost (long) or proceeds (short) of the open part, quote raw
};

export type Cycle = {
  buyFill: string;
  sellFill: string;
  base: bigint; // raw base matched
  buyQuote: Q;
  sellQuote: Q;
  gross: Q; // sellQuote − buyQuote
  viaFlip: boolean; // matched through the flip chain (not FIFO)
  closedBlock: number;
};

export type Valuation = { value: Q | null; note: string };

export type MarketPnl = {
  market: string;
  fills: number;
  cycles: Cycle[];
  realized: Q;
  lots: Lot[];
  netBase: bigint; // raw: + long, − short (gross of fees)
  openCost: Q; // signed: cost of long lots, − proceeds of short lots
  unrealized: { mid: Valuation; executable: Valuation };
  fees: { base: bigint; quote: bigint; quoteEquivMid: Q | null };
  total: { mid: Q | null; executable: Q | null };
  flows: { base: bigint; quote: bigint }; // Σ fill flows net of fees
};

export function marketPnl(ledger: Ledger, market: string, book?: Book): MarketPnl {
  const mkt = market.toLowerCase();
  const m = ledger.markets.get(mkt);
  if (!m) throw new Error(`unknown market ${market}`);
  const fills = ledger.fills.filter((f) => f.market === mkt);
  const lots: Lot[] = [];
  const cycles: Cycle[] = [];
  let realized = ZERO;
  let feeBase = 0n;
  let feeQuote = 0n;
  let flowBase = 0n;
  let flowQuote = 0n;

  for (const f of fills) {
    const fee = f.fee.amount.value;
    if (f.fee.token === m.baseAsset) feeBase += fee;
    else feeQuote += fee;
    flowBase += f.side === 'buy' ? f.base.value : -f.base.value;
    flowQuote += f.side === 'buy' ? -f.quote.value : f.quote.value;

    const dir: Lot['dir'] = f.side === 'buy' ? 'long' : 'short';
    const closes = dir === 'long' ? 'short' : 'long';
    let left = f.base.value;
    const total = f.base.value;
    const quoteOf = (b: bigint): Q => (total === 0n ? ZERO : q(f.quote.value * b, total));

    // The flip chain: this order was flipped out of a fill; close that fill's lot first.
    const order = ledger.orders.get(orderKey(f.market, f.orderId));
    const parentKey = order?.parent?.fillKey;
    const ordered = [
      ...lots.filter((l) => l.dir === closes && l.fillKey === parentKey),
      ...lots.filter((l) => l.dir === closes && l.fillKey !== parentKey),
    ];
    for (const lot of ordered) {
      if (left === 0n) break;
      if (lot.base === 0n) continue;
      const take = lot.base < left ? lot.base : left;
      const lotQuote = q(lot.quote.n * take, lot.quote.d * lot.base);
      const thisQuote = quoteOf(take);
      const [buyQuote, sellQuote] = dir === 'long' ? [thisQuote, lotQuote] : [lotQuote, thisQuote];
      const c: Cycle = {
        buyFill: dir === 'long' ? f.key : lot.fillKey,
        sellFill: dir === 'long' ? lot.fillKey : f.key,
        base: take,
        buyQuote,
        sellQuote,
        gross: sub(sellQuote, buyQuote),
        viaFlip: lot.fillKey === parentKey,
        closedBlock: f.block,
      };
      cycles.push(c);
      realized = add(realized, c.gross);
      lot.quote = sub(lot.quote, lotQuote);
      lot.base -= take;
      left -= take;
    }
    for (let i = lots.length - 1; i >= 0; i--) if (lots[i].base === 0n) lots.splice(i, 1);
    if (left > 0n) lots.push({ fillKey: f.key, orderId: f.orderId, dir, base: left, quote: quoteOf(left) });
  }

  const netBase = lots.reduce((s, l) => s + (l.dir === 'long' ? l.base : -l.base), 0n);
  const openCost = lots.reduce((s, l) => (l.dir === 'long' ? add(s, l.quote) : sub(s, l.quote)), ZERO);

  let mid: Valuation = { value: null, note: 'no book' };
  let exe: Valuation = { value: null, note: 'no book' };
  let feeMid: Q | null = feeBase === 0n ? q(feeQuote) : null;
  let totalMid: Q | null = null;
  let totalExe: Q | null = null;
  if (book && book.bestBid > 0n && book.bestAsk > book.bestBid) {
    const pMid = priceRaw(q(book.bestBid + book.bestAsk, 2n), m);
    mid = { value: sub(mul(q(netBase), pMid), openCost), note: 'mid = (best bid + best ask) / 2' };
    exe = executable(netBase, openCost, book, m);
    feeMid = add(q(feeQuote), mul(q(feeBase), pMid));
    totalMid = sub(add(realized, mid.value!), feeMid);
    // Fees in base are valued at mid in both totals: they are already gone, not to be sold.
    totalExe = exe.value === null ? null : sub(add(realized, exe.value), feeMid);
  } else if (book) {
    mid = { value: null, note: 'book is empty or crossed' };
    exe = { value: null, note: 'book is empty or crossed' };
  }
  return {
    market: mkt,
    fills: fills.length,
    cycles,
    realized,
    lots,
    netBase,
    openCost,
    unrealized: { mid, executable: exe },
    fees: { base: feeBase, quote: feeQuote, quoteEquivMid: feeMid },
    total: { mid: totalMid, executable: totalExe },
    flows: { base: flowBase - feeBase, quote: flowQuote - feeQuote },
  };
}

// Unrealized PnL if the open position were closed now against the book.
function executable(netBase: bigint, openCost: Q, book: Book, m: Market): Valuation {
  if (netBase === 0n) return { value: ZERO, note: 'flat' };
  const long = netBase > 0n;
  const levels = long ? book.bids : book.asks;
  const best = long ? book.bestBid : book.bestAsk;
  let need = long ? netBase : -netBase;
  if (!levels || levels.length === 0) {
    const v = mul(q(need), priceRaw(best, m));
    return {
      value: long ? sub(v, openCost) : sub(neg0(openCost), v),
      note: `top of book only (${long ? 'best bid' : 'best ask'}); depth ignored`,
    };
  }
  let value = ZERO;
  for (const lv of levels) {
    if (need === 0n) break;
    const avail = baseForSize(lv.size, m, 'down').value;
    const take = avail < need ? avail : need;
    value = add(value, mul(q(take), priceRaw(lv.price, m)));
    need -= take;
  }
  if (need > 0n) return { value: null, note: 'not enough depth in the levels given to close the position' };
  return { value: long ? sub(value, openCost) : sub(neg0(openCost), value), note: 'walked the given depth' };
}

// openCost for a short book is negative (proceeds); its magnitude is what we got for the base.
const neg0 = (x: Q): Q => sub(ZERO, x);

export type AccountView = {
  growth: {
    // Change of the account's holdings caused by trading (fills net of fees), gas not included.
    base: bigint;
    quote: bigint;
    // Everything the ledger knows, valued at mid: trading PnL − gas (gas only when it is the base token).
    netQuoteEquivMid: Q | null;
    capitalQuoteEquivMid: Q | null; // peak net deposits (+ opening), valued at mid
    growthBps: bigint | null; // netQuoteEquivMid / capital × 10000, rounded down
  };
  inventory: {
    baseValueMid: Q | null; // account equity in base, valued at mid
    quoteValue: bigint;
    baseShareBps: bigint | null; // 0 = all quote, 10000 = all base
    imbalanceBps: bigint | null; // −10000 all quote … 0 balanced … +10000 all base
  };
  gas: { wei: bigint; quoteEquivMid: Q | null };
};

// Account-level view for one market's pair of tokens. Equity per token is account-wide
// (Kuru margin is shared across markets), so with several markets on one token these mix.
export function accountView(ledger: Ledger, market: string, book?: Book): AccountView {
  const mkt = market.toLowerCase();
  const m = ledger.markets.get(mkt)!;
  const p = marketPnl(ledger, mkt, book);
  const pMid = book && book.bestBid > 0n && book.bestAsk > book.bestBid ? priceRaw(q(book.bestBid + book.bestAsk, 2n), m) : null;
  const gasWei = ledger.gas.totalWei;
  const gasMid = m.baseAsset === NATIVE && pMid ? mul(q(gasWei), pMid) : null;

  // Capital = the peak of net deposits (+ opening), all valued at today's mid: depositing 6,
  // withdrawing 6 and depositing 6 again is 6 of capital, not 12 and not 0.
  let capital: Q | null = null;
  if (pMid) {
    let net = ZERO;
    let peak = ZERO;
    for (const f of [...ledger.flows].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)) {
      if (f.kind !== 'deposit' && f.kind !== 'withdrawal' && f.kind !== 'opening') continue;
      if (f.token === m.baseAsset) net = add(net, mul(q(f.amount), pMid));
      else if (f.token === m.quoteAsset) net = add(net, q(f.amount));
      else continue;
      if (cmp(net, peak) > 0) peak = net;
    }
    capital = peak;
  }
  let net: Q | null = p.total.mid;
  if (net && m.baseAsset === NATIVE) net = gasMid ? sub(net, gasMid) : null;
  const growthBps = net && capital && cmp(capital, ZERO) > 0 ? floor(div(mul(net, q(10_000n)), capital)) : null;

  const eqBase = ledger.balances.get(m.baseAsset)?.equity ?? 0n;
  const eqQuote = ledger.balances.get(m.quoteAsset)?.equity ?? 0n;
  const baseValue = pMid ? mul(q(eqBase), pMid) : null;
  let share: bigint | null = null;
  if (baseValue) {
    const tot = add(baseValue, q(eqQuote));
    if (cmp(tot, ZERO) > 0) share = floor(div(mul(baseValue, q(10_000n)), tot));
  }
  return {
    growth: {
      base: p.flows.base,
      quote: p.flows.quote,
      netQuoteEquivMid: net,
      capitalQuoteEquivMid: capital,
      growthBps,
    },
    inventory: {
      baseValueMid: baseValue,
      quoteValue: eqQuote,
      baseShareBps: share,
      imbalanceBps: share === null ? null : 2n * share - 10_000n,
    },
    gas: { wei: gasWei, quoteEquivMid: gasMid },
  };
}

