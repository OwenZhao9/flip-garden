// Planting policy: hard caps, the bid ladder, the preview maths and the guard every transaction passes.
// Pure functions, integers only (BigInt), no I/O. Ported from lib/units.cjs (tests compare them) and
// scripts/gate.cjs (the reference implementation of deposit, plant and unwind).
import { decodeCall, encodeApprove, encodeCancelFlipOrders, encodeDeposit, encodeProvision, encodeWithdrawMax, type ProvisionBid } from './abi.ts';
import { guardSwapData, FLOW_ROUTER } from './swapguard.ts';
import { guardPerplTx, isPerplKind, type PerplKind } from './perpl/guard.ts';
import { NATIVE, baseForSize, formatUnits, log10Exact, parseUnits, quoteForSize, type Market } from './units.ts';

// Mirrors config/kuru.mainnet.json (a test asserts they agree). Raising a cap is the owner's decision.
export const CHAIN = {
  chainId: 143,
  chainIdHex: '0x8f',
  chainName: 'Monad',
  rpcUrl: 'https://rpc.monad.xyz',
  explorer: 'https://monadscan.com',
  marginAccount: '0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5',
  usdc: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',
  market: '0x065C9d28E428A0db40191a54d33d5b7c71a9C394',
} as const;

export const LIMITS = {
  maxDepositUsdc: 15_000_000n, // raw USDC (6 decimals)
  maxOrdersPerPlant: 3,
  maxNotionalUsdc: 15_000_000n,
  minWalletMon: 500_000_000_000_000_000n, // raw MON (18 decimals) kept for gas
} as const;

export const USDC_DECIMALS = 6;
const lc = (s: string): string => s.toLowerCase();
export const sameAddress = (a: string, b: string): boolean => lc(a) === lc(b);

// --- ladder (port of lib/units.cjs buildBidLadder) ------------------------------------------------

const alignDown = (x: bigint, tick: bigint): bigint => x - (x % tick);
const alignUp = (x: bigint, tick: bigint): bigint => (x % tick === 0n ? x : x + (tick - (x % tick)));

export function buildBidLadder(o: {
  bestBid: bigint;
  bestAsk: bigint;
  tick: bigint;
  count: number;
  size: bigint;
  offsetTicks?: bigint;
  stepBps?: bigint;
  spreadBps?: bigint;
}): ProvisionBid[] {
  const { bestBid, bestAsk, tick, count, size } = o;
  const offsetTicks = o.offsetTicks ?? 1n;
  const stepBps = o.stepBps ?? 10n;
  const spreadBps = o.spreadBps ?? 10n;
  if (!(count >= 1)) throw new Error('count must be >= 1');
  if (bestBid <= 0n || bestAsk <= bestBid) throw new Error('book is empty or crossed');
  let top = bestBid + offsetTicks * tick;
  if (top >= bestAsk) top = bestAsk - tick;
  if (top <= 0n) throw new Error('top price is not positive');
  const out: ProvisionBid[] = [];
  let prev: bigint | null = null;
  for (let i = 0; i < count; i++) {
    let price = alignDown((top * (10000n - BigInt(i) * stepBps)) / 10000n, tick);
    if (prev !== null && price >= prev) price = prev - tick;
    if (price <= 0n) throw new Error('ladder reaches non-positive price');
    let flip = alignUp((price * (10000n + spreadBps)) / 10000n, tick);
    if (flip < price + 2n * tick) flip = price + 2n * tick;
    out.push({ price, flipPrice: flip, size });
    prev = price;
  }
  return out;
}

// --- preview -------------------------------------------------------------------------------------

// 'close' = one tick under the best ask (the highest bid the book accepts: hit soon, bought a little dearer);
// 'passive' = one tick over the best bid (cheaper if it fills, but bots re-quote several times a second, so it waits).
export type Placement = 'close' | 'passive';
export const OFFSET_TICKS: Record<Placement, bigint> = { close: 1000n, passive: 1n };

export type PreviewLevel = {
  price: bigint;
  flipPrice: bigint;
  size: bigint; // market size units (whole MON x sizePrecision)
  baseWhole: bigint; // whole base units, for display
  locked: bigint; // raw quote locked (rounds up)
  grossPerRoundTrip: bigint; // raw quote, up to, fees ignored (they read 0 bps)
};
export type Preview = {
  ok: boolean;
  errors: string[];
  levels: PreviewLevel[];
  totalLocked: bigint;
  totalGross: bigint;
  minOrderQuote: bigint; // raw quote needed for one minimum order at the best ask
  book: { bestBid: bigint; bestAsk: bigint };
  placement: Placement;
  makerFeeBps: bigint;
};

export function buildPreview(o: { market: Market; book: { bestBid: bigint; bestAsk: bigint }; budget: bigint; levels: number; placement: Placement }): Preview {
  const { market: m, book, budget, levels, placement } = o;
  const errors: string[] = [];
  const empty = (): Preview => ({ ok: false, errors, levels: [], totalLocked: 0n, totalGross: 0n, minOrderQuote: 0n, book, placement, makerFeeBps: m.makerFeeBps });
  if (!Number.isInteger(levels) || levels < 1 || levels > LIMITS.maxOrdersPerPlant) errors.push(`Choose between 1 and ${LIMITS.maxOrdersPerPlant} levels.`);
  if (budget <= 0n) errors.push('Enter a budget above zero.');
  if (budget > LIMITS.maxNotionalUsdc) errors.push(`The budget is capped at ${formatUnits(LIMITS.maxNotionalUsdc, USDC_DECIMALS)} USDC per planting.`);
  if (book.bestBid <= 0n || book.bestAsk <= book.bestBid) errors.push('The order book is empty or crossed right now, so nothing can be planted.');
  if (errors.length) return empty();

  const sizeUnit = m.sizePrecision; // one whole base unit
  const minOrderQuote = quoteForSize(m.minSize, book.bestAsk, m, 'up').value;
  // Price the ladder with a placeholder size to learn the prices; sizes do not change prices.
  const probe = buildBidLadder({ ...book, tick: m.tickSize, count: levels, size: m.minSize, offsetTicks: OFFSET_TICKS[placement] });
  const top = probe[0].price; // the dearest level costs the most per coin, so sizing by it keeps the total within budget
  const perLevel = budget / BigInt(levels);
  // size = perLevel / price, in whole coins (rounded down: a whole-coin size also makes every lock an exact integer)
  const wholeCoins = (perLevel * m.sizePrecision * m.pricePrecision) / (10n ** BigInt(m.quoteDecimals) * top * sizeUnit);
  let size = wholeCoins * sizeUnit;
  const total = (s: bigint): bigint => probe.reduce((acc, b) => acc + quoteForSize(s, b.price, m, 'up').value, 0n);
  while (size > 0n && total(size) > budget) size -= sizeUnit;
  if (size < m.minSize) {
    errors.push(
      `Each level must hold at least ${formatUnits(m.minSize / sizeUnit, 0)} ${'MON'} (about ${formatUnits(minOrderQuote, USDC_DECIMALS, 2)} USDC at the current ask). ` +
        `Raise the budget or use fewer levels.`,
    );
    return empty();
  }
  if (m.maxSize !== undefined && size > m.maxSize) {
    errors.push('A level would exceed the market maximum order size.');
    return empty();
  }
  const ladder = buildBidLadder({ ...book, tick: m.tickSize, count: levels, size, offsetTicks: OFFSET_TICKS[placement] });
  const out: PreviewLevel[] = ladder.map((b) => ({
    price: b.price,
    flipPrice: b.flipPrice,
    size: b.size,
    baseWhole: b.size / sizeUnit,
    locked: quoteForSize(b.size, b.price, m, 'up').value,
    grossPerRoundTrip: quoteForSize(b.size, b.flipPrice - b.price, m, 'down').value,
  }));
  const totalLocked = out.reduce((a, l) => a + l.locked, 0n);
  if (totalLocked > LIMITS.maxNotionalUsdc) errors.push('The total would exceed the per-planting cap.');
  if (totalLocked > budget) errors.push('Internal check failed: the ladder costs more than the budget.');
  return {
    ok: errors.length === 0,
    errors,
    levels: out,
    totalLocked,
    totalGross: out.reduce((a, l) => a + l.grossPerRoundTrip, 0n),
    minOrderQuote,
    book,
    placement,
    makerFeeBps: m.makerFeeBps,
  };
}

// A bid at or above the best ask would cross. With provisionOrRevert=false the contract skips such a bid
// silently (and the user still pays gas); with true the whole transaction reverts. We send `true`: either the
// whole ladder the user confirmed is created or nothing is, and a simulation shows which before any pop-up.
export const PROVISION_OR_REVERT = true;
export function crossingBids(bids: ProvisionBid[], bestAsk: bigint): ProvisionBid[] {
  return bids.filter((b) => b.price >= bestAsk);
}

// --- planned transactions and the guard ---------------------------------------------------------

export type TxKind = 'approve' | 'deposit' | 'plant' | 'cancel' | 'withdraw' | 'swapApprove' | 'swap' | PerplKind;
export type PlannedTx = { kind: TxKind; from: string; to: string; data: string; value: '0x0'; minDepositCNS?: bigint };

export const planApprove = (from: string, amount: bigint): PlannedTx => ({ kind: 'approve', from, to: CHAIN.usdc, data: encodeApprove(CHAIN.marginAccount, amount), value: '0x0' });
export const planDeposit = (from: string, amount: bigint): PlannedTx => ({ kind: 'deposit', from, to: CHAIN.marginAccount, data: encodeDeposit(from, CHAIN.usdc, amount), value: '0x0' });
export const planPlant = (from: string, bids: ProvisionBid[]): PlannedTx => ({ kind: 'plant', from, to: CHAIN.market, data: encodeProvision(bids, PROVISION_OR_REVERT), value: '0x0' });
export const planCancel = (from: string, ids: bigint[]): PlannedTx => ({ kind: 'cancel', from, to: CHAIN.market, data: encodeCancelFlipOrders(ids), value: '0x0' });
export const planWithdraw = (from: string, tokens: string[]): PlannedTx => ({ kind: 'withdraw', from, to: CHAIN.marginAccount, data: encodeWithdrawMax(tokens), value: '0x0' });

// Returns a refusal reason or null. Every transaction is checked here immediately before it is offered to the wallet,
// by decoding its own calldata, so a bug in a builder cannot slip a different call through.
export function guardTx(tx: PlannedTx): string | null {
  if (tx.value !== '0x0') return 'Refused: this page never sends MON along with a call.';
  if (tx.kind === 'swap') return guardSwapData(tx, CHAIN.usdc, LIMITS.maxDepositUsdc);
  if (isPerplKind(tx.kind)) return guardPerplTx({ ...tx, kind: tx.kind });
  const call = decodeCall(tx.data);
  if (!call) return 'Refused: unknown function.';
  const { name, args } = call;
  const expectKind: Partial<Record<string, TxKind>> = { approve: 'approve', deposit: 'deposit', batchProvisionLiquidity: 'plant', batchCancelFlipOrders: 'cancel', batchWithdrawMaxTokens: 'withdraw' };
  if (name === 'approve' ? tx.kind !== 'approve' && tx.kind !== 'swapApprove' : expectKind[name] !== tx.kind) return 'Refused: the call does not match the step.';
  switch (name) {
    case 'approve': {
      const [spender, amount] = args as [string, bigint];
      if (!sameAddress(tx.to, CHAIN.usdc)) return 'Refused: approvals are only allowed on USDC.';
      if (tx.kind === 'swapApprove') {
        if (!sameAddress(spender, FLOW_ROUTER)) return 'Refused: for a swap, USDC may only be approved to the Kuru Flow router.';
      } else if (!sameAddress(spender, CHAIN.marginAccount)) return 'Refused: USDC may only be approved to the Kuru margin account.';
      if (amount <= 0n || amount > LIMITS.maxDepositUsdc) return 'Refused: the approval must be above 0 and within the deposit cap (never unlimited).';
      return null;
    }
    case 'deposit': {
      const [user, token, amount] = args as [string, string, bigint];
      if (!sameAddress(tx.to, CHAIN.marginAccount)) return 'Refused: deposits only go to the Kuru margin account.';
      if (!sameAddress(user, tx.from)) return 'Refused: a deposit must credit your own address.';
      if (!sameAddress(token, CHAIN.usdc)) return 'Refused: only USDC can be deposited.';
      if (amount <= 0n || amount > LIMITS.maxDepositUsdc) return 'Refused: the deposit must be above 0 and within the cap.';
      return null;
    }
    case 'batchProvisionLiquidity': {
      const [prices, flips, sizes, isBuy] = args as [bigint[], bigint[], bigint[], boolean[], boolean];
      if (!sameAddress(tx.to, CHAIN.market)) return 'Refused: orders may only be placed on the MON-USDC market.';
      if (prices.length < 1 || prices.length > LIMITS.maxOrdersPerPlant) return `Refused: between 1 and ${LIMITS.maxOrdersPerPlant} orders per planting.`;
      if (flips.length !== prices.length || sizes.length !== prices.length || isBuy.length !== prices.length) return 'Refused: the order lists differ in length.';
      if (!isBuy.every(Boolean)) return 'Refused: only bids are planted.';
      if (prices.some((p, i) => flips[i] <= p)) return 'Refused: a flip price must be above its bid price.';
      return null;
    }
    case 'batchCancelFlipOrders':
      return sameAddress(tx.to, CHAIN.market) ? null : 'Refused: orders can only be cancelled on the MON-USDC market.';
    case 'batchWithdrawMaxTokens': {
      const [tokens] = args as [string[]];
      if (!sameAddress(tx.to, CHAIN.marginAccount)) return 'Refused: withdrawals only come from the Kuru margin account.';
      if (!tokens.every((t) => sameAddress(t, CHAIN.usdc) || sameAddress(t, NATIVE))) return 'Refused: only USDC and MON can be withdrawn.';
      return null;
    }
    default:
      return 'Refused: unknown function.';
  }
}

// --- what to do next, derived from chain state only (so a reload resumes correctly) --------------

export type PlantAction =
  | { type: 'approve'; amount: bigint }
  | { type: 'deposit'; amount: bigint }
  | { type: 'plant' }
  | { type: 'planted' }
  | { type: 'blocked'; reason: string };

export function nextPlantAction(s: { lockedNeeded: bigint; walletUsdc: bigint; walletMon: bigint; allowance: bigint; marginUsdc: bigint; openOrders: number }): PlantAction {
  if (s.openOrders > 0) return { type: 'planted' };
  if (s.lockedNeeded <= 0n) return { type: 'blocked', reason: 'There is nothing to plant yet.' };
  if (s.lockedNeeded > LIMITS.maxNotionalUsdc) return { type: 'blocked', reason: 'Above the per-planting cap.' };
  if (s.walletMon < LIMITS.minWalletMon) return { type: 'blocked', reason: `Keep at least ${formatUnits(LIMITS.minWalletMon, 18)} MON in the wallet for network fees.` };
  if (s.marginUsdc >= s.lockedNeeded) return { type: 'plant' };
  const missing = s.lockedNeeded - s.marginUsdc;
  if (missing > LIMITS.maxDepositUsdc) return { type: 'blocked', reason: `A single deposit is capped at ${formatUnits(LIMITS.maxDepositUsdc, USDC_DECIMALS)} USDC.` };
  if (s.walletUsdc < missing) return { type: 'blocked', reason: `The wallet has ${formatUnits(s.walletUsdc, USDC_DECIMALS)} USDC; ${formatUnits(missing, USDC_DECIMALS)} USDC more is needed to deposit.` };
  if (s.allowance < missing) return { type: 'approve', amount: missing };
  return { type: 'deposit', amount: missing };
}

export type UnwindAction = { type: 'cancel'; ids: bigint[] } | { type: 'withdraw'; tokens: string[] } | { type: 'done' };

export function nextUnwindAction(s: { liveOrderIds: bigint[]; marginUsdc: bigint; marginMon: bigint }): UnwindAction {
  if (s.liveOrderIds.length > 0) return { type: 'cancel', ids: s.liveOrderIds };
  const tokens: string[] = [];
  if (s.marginUsdc > 0n) tokens.push(CHAIN.usdc);
  if (s.marginMon > 0n) tokens.push(NATIVE);
  return tokens.length ? { type: 'withdraw', tokens } : { type: 'done' };
}

export { baseForSize, log10Exact, parseUnits };
