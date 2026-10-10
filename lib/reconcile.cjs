'use strict';
// Gate-test reconciliation: does "what the fills say happened" match "what the balances say happened"?
// Pure BigInt math so it can be unit-tested without a chain.
//
// Net worth per token = wallet + margin (free) + locked inside live orders.
// Deposits / withdrawals / placing / cancelling only move value between those three buckets,
// so they cancel out. What remains is: fills (we trade base for quote), fees, and gas.
const u = require('./units.cjs');

const abs = (x) => (x < 0n ? -x : x);

function equity(balances, locked) {
  return {
    quote: balances.walletUsdc + balances.marginUsdc + locked.quote,
    base: balances.walletMon + balances.marginMon + locked.base,
  };
}

// Trade.isBuy is the TAKER's direction, not the maker order's. Verified on-chain 2026-10-10:
// our resting bid (FlipOrderCreated isBuy=true) was filled by a seller and the Trade event said isBuy=false.
function makerBuys(tradeIsBuy) {
  return !(tradeIsBuy === true || tradeIsBuy === 'true');
}

// fills: [{ priceRaw, sizeRaw, makerBuys }]  (we were the maker; makerBuys = our resting order was a bid)
function expectedFromFills(fills, mp) {
  let quote = 0n;
  let base = 0n;
  for (const f of fills) {
    const q = u.quoteForSize(f.sizeRaw, f.priceRaw, mp);
    const b = u.baseForSize(f.sizeRaw, mp);
    if (f.makerBuys) {
      quote -= q;
      base += b;
    } else {
      quote += q;
      base -= b;
    }
  }
  return { quote, base };
}

function reconcile({
  baseline, // { walletUsdc, walletMon, marginUsdc, marginMon } before the first deposit
  now, // same shape, current
  locked, // { quote, base } locked in live orders now
  fills,
  feeLimit, // total gas if Monad charges gasLimit * price (wei)
  feeUsed, // total gas if Monad charges gasUsed * price (wei)
  mp,
  tolQuote = 100n, // 0.0001 USDC of rounding dust
  tolBase = 10n ** 13n, // 0.00001 MON
}) {
  const e0 = equity(baseline, { quote: 0n, base: 0n });
  const e1 = equity(now, locked);
  const dQuote = e1.quote - e0.quote;
  const dBase = e1.base - e0.base;
  const exp = expectedFromFills(fills, mp);

  const quoteDiff = dQuote - exp.quote;
  const baseDiffLimit = dBase + feeLimit - exp.base;
  const baseDiffUsed = dBase + feeUsed - exp.base;
  const quoteOk = abs(quoteDiff) <= tolQuote;
  const baseOkLimit = abs(baseDiffLimit) <= tolBase;
  const baseOkUsed = abs(baseDiffUsed) <= tolBase;

  let feeModel = null;
  if (baseOkLimit && baseOkUsed) feeModel = 'either';
  else if (baseOkLimit) feeModel = 'gasLimit';
  else if (baseOkUsed) feeModel = 'gasUsed';

  // If every fill had the opposite side, the signs would flip.
  const signFlipped =
    fills.length > 0 && !quoteOk && abs(dQuote + exp.quote) <= tolQuote && abs(dBase + feeLimit + exp.base) <= tolBase * 100n;

  return {
    e0,
    e1,
    dQuote,
    dBase,
    expected: exp,
    quoteDiff,
    baseDiffLimit,
    baseDiffUsed,
    quoteOk,
    baseOk: baseOkLimit || baseOkUsed,
    feeModel,
    signFlipped,
    meaningful: fills.length > 0, // with zero fills only gas and deposits are exercised
  };
}

module.exports = { equity, makerBuys, expectedFromFills, reconcile };
