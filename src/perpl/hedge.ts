// Hedge maths: pure integer functions, no I/O. Given the MON that flip orders have accumulated, size the
// Perpl short that offsets it, the collateral it needs and where it would be liquidated.
//
// Units: inventory is raw MON (18 decimals). Perpl lots are 10^-lotDecimals MON (0 decimals for the MON
// market: whole MON). Prices are 10^-priceDecimals AUSD per whole MON. Collateral is 10^-cnsDecimals AUSD.
// Rounding leans toward the safe side: size rounds down (never over-hedge into a net short) and margin and
// fees round up. The liquidation price is an estimate truncated to one price unit.
import { BPS } from '../units.ts';

export type HedgeMarket = {
  lotDecimals: number;
  priceDecimals: number;
  cnsDecimals: number; // 6 for AUSD
  baseDecimals: number; // 18 for MON
  minLotLNS: bigint; // 1 for MON (docs: "at least one size unit")
  maintMarginFracHdths: bigint; // getMarginFractions().maintHdths, 2000 = factor 20 = 5% of notional
  maxLeverageHdths: bigint; // getMarginFractions().initHdths, 1000 = 10x
};

const pow10 = (n: number): bigint => 10n ** BigInt(n);
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

export type ShortSize = { lotLNS: bigint; meetsMinimum: boolean; hedgedInventoryRaw: bigint };

// Size of the short for `inventoryRaw` MON at `ratioBps` (10000 = hedge everything). Rounds down; when the
// result is below the market minimum the lot is 0 and `meetsMinimum` is false (the caller must not place
// a smaller order than the exchange accepts, and must not round up into an over-hedge).
export function shortSize(inventoryRaw: bigint, ratioBps: bigint, m: HedgeMarket): ShortSize {
  if (inventoryRaw < 0n) throw new Error('inventory must not be negative');
  if (ratioBps < 0n || ratioBps > BPS) throw new Error('ratioBps must be within 0..10000');
  const perLot = pow10(m.baseDecimals - m.lotDecimals);
  const lot = (inventoryRaw * ratioBps) / BPS / perLot;
  if (lot < m.minLotLNS) return { lotLNS: 0n, meetsMinimum: false, hedgedInventoryRaw: 0n };
  return { lotLNS: lot, meetsMinimum: true, hedgedInventoryRaw: lot * perLot };
}

// Notional in collateral units: lot x price, rounded up (it is what the exchange will lock).
export function notionalCNS(lotLNS: bigint, pricePNS: bigint, m: HedgeMarket): bigint {
  return ceilDiv(lotLNS * pricePNS * pow10(m.cnsDecimals), pow10(m.lotDecimals + m.priceDecimals));
}

export type MarginPlan = {
  notionalCNS: bigint;
  initialMarginCNS: bigint; // notional / leverage
  entryFeeCNS: bigint; // fee on the fill, if it takes liquidity
  bufferCNS: bigint; // slack for extra collateral drawn when the fill is worse than the mark
  requiredCNS: bigint; // initial margin + fee + buffer
};

// feePpm: fee in millionths of notional (contract >= 1.7.5; see feePpm() in state.ts for older versions).
// bufferBps: slack on the initial margin. In the simulation of 2026-10-11 a 100 MON short at 5x deposited
// 0.5% more than notional / leverage (docs/PERPL-ONCHAIN.md); the cause is unverified, so keep a buffer.
export function marginPlan(o: { lotLNS: bigint; pricePNS: bigint; leverageHdths: bigint; feePpm: bigint; bufferBps: bigint }, m: HedgeMarket): MarginPlan {
  if (o.leverageHdths <= 0n || o.leverageHdths > m.maxLeverageHdths) throw new Error(`leverage must be within 1..${m.maxLeverageHdths} hundredths`);
  const n = notionalCNS(o.lotLNS, o.pricePNS, m);
  const initial = ceilDiv(n * 100n, o.leverageHdths);
  const fee = ceilDiv(n * o.feePpm, 1_000_000n);
  const buffer = ceilDiv(initial * o.bufferBps, BPS);
  return { notionalCNS: n, initialMarginCNS: initial, entryFeeCNS: fee, bufferCNS: buffer, requiredCNS: initial + fee + buffer };
}

// Estimated liquidation price (PNS) for a position with `depositCNS` of collateral and `fundingOwedCNS` of
// accumulated funding owed (0 at entry; positive = the position owes). From the docs:
//   P_liq = P_entry + s * (C_MMR - C_deposit - C_funding) / L, s = +1 long, -1 short,
//   C_MMR = P_entry * L / MMF, MMF = maintMarginFracHdths / 100.
// A short is liquidated when the mark rises to P_liq; a long when it falls to it. The estimate ignores
// the dynamic initial margin and the exchange's own price tolerances, so treat it as indicative.
export function liquidationPricePNS(
  o: { side: 'long' | 'short'; entryPricePNS: bigint; lotLNS: bigint; depositCNS: bigint; fundingOwedCNS?: bigint },
  m: HedgeMarket,
): bigint {
  if (o.lotLNS <= 0n) throw new Error('lot must be positive');
  const funding = o.fundingOwedCNS ?? 0n;
  // C_MMR in CNS = entry notional / MMF with MMF = hdths / 100, so notional x 100 / hdths (rounded down)
  const unit = pow10(m.lotDecimals + m.priceDecimals);
  const cMmr = (o.entryPricePNS * o.lotLNS * pow10(m.cnsDecimals) * 100n) / (unit * m.maintMarginFracHdths);
  const margin = o.depositCNS + funding - cMmr; // CNS that can be lost before liquidation
  // price move = margin / L  (AUSD per whole MON) -> PNS: margin * 10^priceDec * 10^lotDec / (10^cnsDec * L)
  const move = (margin * pow10(m.priceDecimals) * pow10(m.lotDecimals)) / (pow10(m.cnsDecimals) * o.lotLNS);
  if (o.side === 'short') return o.entryPricePNS + move; // rises against a short
  const p = o.entryPricePNS - move;
  return p < 0n ? 0n : p;
}

// Funding cost of holding the short for one funding interval at the current rate, in CNS (positive =
// the short pays). Interpretation of the contract field is UNVERIFIED: the docs say a positive rate means
// longs pay shorts, and `fundingRatePct100k` is read as hundred-thousandths of the notional per interval
// (clamp field `absFundingClampPctPer100K` 10 vs docs "up to 15%" is consistent with 15000 = 15%).
export function fundingCostPerIntervalCNS(notional: bigint, fundingRatePct100k: bigint, side: 'long' | 'short'): bigint {
  const longPays = fundingRatePct100k; // positive: longs pay
  const raw = (notional * (side === 'long' ? longPays : -longPays)) / 100_000n;
  return raw;
}
