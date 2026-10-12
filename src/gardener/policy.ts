// The Gardener's policy: deterministic code that decides what is allowed at all. Pure functions, BigInt for money, no
// I/O. The model (or the rules) only picks among the options this code offers; the code then turns a choice into an exact
// intent, checks it against the mandate once more, and the executor re-derives prices from a fresh book before sending.
//   observation -> stop check -> questions (allowed options only) -> choice -> intent -> mandate check -> executor
import { buildBidLadder, LIMITS } from '../plant.ts';
import { NATIVE, BPS, quoteForSize, type Market } from '../units.ts';
import { hasRoom, failuresSince, type ActionKind, type Mandate, type Spend } from './mandate.ts';
import type { ProvisionBid } from '../abi.ts';

// ---------------------------------------------------------------- what the Gardener sees ------------------------------

export type GOrder = { id: bigint; isBuy: boolean; price: bigint; flipPrice: bigint; size: bigint };
export type HedgeView = {
  hasAccount: boolean;
  freeCNS: bigint; // free collateral in the Perpl account (AUSD raw)
  shortLot: bigint; // whole MON short on Perpl (0 = none)
  otherExposure: boolean; // a long, other markets or resting orders: the Gardener leaves the hedge alone
};
export type Observation = {
  block: number;
  readAtMs: number; // when the chain was read
  market: Market;
  book: { bestBid: bigint; bestAsk: bigint };
  mids: bigint[]; // mid prices at recent checks, oldest first (order-price units)
  orders: GOrder[]; // this account's live orders on the market (checked against the chain)
  walletMon: bigint;
  marginUsdc: bigint;
  marginMon: bigint;
  hedge: HedgeView | null; // null when the Perpl state could not be read
  gasPriceWei: bigint;
};

// What the Gardener remembers between checks (also pure data).
export type Memory = {
  lastBlock: number;
  lastBlockAtMs: number; // when `lastBlock` was first seen
  idleSinceMs: number | null; // since when free money has sat at Kuru without a resting order to go with it
  cooldownUntilMs: Partial<Record<ActionKind, number>>;
  backoffMs: Partial<Record<ActionKind, number>>;
};
export const freshMemory = (): Memory => ({ lastBlock: 0, lastBlockAtMs: 0, idleSinceMs: null, cooldownUntilMs: {}, backoffMs: {} });

// ---------------------------------------------------------------- fixed parameters -------------------------------------

export const POLICY = {
  staleMs: 20_000, // chain data older than this, or a head that has not moved for this long: do nothing
  maxSpreadBps: 100n, // a spread wider than 1% means a thin or broken book: do nothing
  failureWindowMs: 10 * 60_000,
  maxFailures: 3, // that many failed transactions inside the window stop the Gardener
  firstBackoffMs: 30_000, // after a failed action of a kind: wait, doubling up to maxBackoffMs
  maxBackoffMs: 10 * 60_000,
  requoteCooldownMs: 15_000, // after a re-place, leave the new bid alone for a while
  idleBeforeHarvestMs: 5 * 60_000,
  // Gas limits seen on mainnet (docs/FINDINGS.md, 2026-10-10 and 2026-10-11) with the executor's margin, for budgeting only.
  gas: { cancel: 214_000n, plant: 339_000n, withdraw: 229_000n, perplClose: 930_000n, perplOpen: 930_000n } as Record<string, bigint>,
  feeReserveFactor: 2n, // keep enough MON for twice a cancel + a hedge close + a withdrawal
} as const;

const mid = (b: { bestBid: bigint; bestAsk: bigint }): bigint => (b.bestBid + b.bestAsk) / 2n;
export const spreadBps = (b: { bestBid: bigint; bestAsk: bigint }): bigint => ((b.bestAsk - b.bestBid) * BPS) / mid(b);

// MON the wallet must keep for the protective transactions (cancel everything, close the hedge, withdraw).
export function feeReserveWei(o: Observation): bigint {
  const g = POLICY.gas;
  const need = (g.cancel + g.withdraw + (o.hedge && o.hedge.shortLot > 0n ? g.perplClose : 0n)) * o.gasPriceWei * POLICY.feeReserveFactor;
  return need > LIMITS.minWalletMon ? need : LIMITS.minWalletMon;
}

export const feeOf = (kind: string, o: Observation): bigint => (POLICY.gas[kind] ?? 300_000n) * o.gasPriceWei;

// ---------------------------------------------------------------- stop conditions --------------------------------------

export type Stop = { kind: 'expired' | 'stale' | 'book' | 'spread' | 'failures' | 'budget'; final: boolean; text: string };

// Memory is updated by the caller from the observation (see `remember`); this only reads it.
export function stopCheck(o: Observation, m: Mandate, spend: Spend, mem: Memory, nowMs: number): Stop | null {
  if (nowMs >= m.expiresMs) return { kind: 'expired', final: true, text: 'The mandate has expired.' };
  if (failuresSince(spend, nowMs - POLICY.failureWindowMs) >= POLICY.maxFailures) return { kind: 'failures', final: true, text: `${POLICY.maxFailures} transactions failed within ten minutes, so the Gardener stopped. Check the timeline before starting it again.` };
  if (nowMs - o.readAtMs > POLICY.staleMs) return { kind: 'stale', final: false, text: 'The chain data is too old. Waiting for a fresh read.' };
  if (mem.lastBlockAtMs > 0 && nowMs - mem.lastBlockAtMs > POLICY.staleMs) return { kind: 'stale', final: false, text: 'The network has not produced a new block for a while. Waiting.' };
  if (o.book.bestBid <= 0n || o.book.bestAsk <= o.book.bestBid) return { kind: 'book', final: false, text: 'The order book is empty or crossed. Waiting.' };
  if (spreadBps(o.book) > POLICY.maxSpreadBps) return { kind: 'spread', final: false, text: 'The spread is unusually wide (the book is thin). Waiting.' };
  if (!hasRoom(m, spend, nowMs, 1, feeOf('cancel', o))) return { kind: 'budget', final: false, text: 'The hourly budget of transactions or network fees is used up. Waiting for it to free up.' };
  return null;
}

export function remember(mem: Memory, o: Observation, nowMs: number): Memory {
  const moved = o.block > mem.lastBlock;
  const bids = o.orders.some((x) => x.isBuy);
  const idle = o.marginMon > 0n || (o.marginUsdc > 0n && !bids);
  return {
    ...mem,
    lastBlock: moved ? o.block : mem.lastBlock,
    lastBlockAtMs: moved ? nowMs : mem.lastBlockAtMs,
    idleSinceMs: idle ? (mem.idleSinceMs ?? nowMs) : null,
  };
}

// After an action: a success starts its cool-down, a failure backs the kind off (doubling) .
export function afterAction(mem: Memory, kind: ActionKind, ok: boolean, nowMs: number): Memory {
  if (ok) {
    const cd = kind === 'requote' || kind === 'replant' ? POLICY.requoteCooldownMs : 0;
    return { ...mem, cooldownUntilMs: { ...mem.cooldownUntilMs, [kind]: nowMs + cd }, backoffMs: { ...mem.backoffMs, [kind]: 0 } };
  }
  const prev = mem.backoffMs[kind] ?? 0;
  const next = Math.min(POLICY.maxBackoffMs, prev ? prev * 2 : POLICY.firstBackoffMs);
  return { ...mem, cooldownUntilMs: { ...mem.cooldownUntilMs, [kind]: nowMs + next }, backoffMs: { ...mem.backoffMs, [kind]: next } };
}

const cooling = (mem: Memory, k: ActionKind, nowMs: number): boolean => (mem.cooldownUntilMs[k] ?? 0) > nowMs;

// ---------------------------------------------------------------- the questions ---------------------------------------

export type QuestionId = 'tend' | 'recover' | 'hedge' | 'harvest';
export const OPTIONS = {
  tend: ['keep', 'requote', 'prune'],
  recover: ['wait', 'replant'],
  hedge: ['hold', 'adjust'],
  harvest: ['leave', 'harvest'],
} as const satisfies Record<QuestionId, readonly string[]>;
export type Choice = (typeof OPTIONS)[QuestionId][number];

export type Facts = {
  orderId?: bigint;
  distanceBps?: bigint; // how far a bid sits under the best bid
  lockedUsdc?: bigint;
  freeUsdc?: bigint;
  freeMon?: bigint;
  inventoryMon?: bigint; // whole MON
  shortMon?: bigint;
  ratioBps?: bigint | null; // null = inventory 0 with a short open
  idleMs?: number;
};
export type Question = { id: QuestionId; options: Choice[]; rulesChoice: Choice; facts: Facts; why: string };

// Whole MON the garden holds: in resting sells plus free at Kuru (wallet MON is gas money and is not counted).
export function gardenMon(o: Observation): bigint {
  const unit = o.market.sizePrecision;
  const inSells = o.orders.filter((x) => !x.isBuy).reduce((a, x) => a + x.size / unit, 0n);
  return inSells + o.marginMon / 10n ** BigInt(o.market.baseDecimals);
}

export const lockedUsdc = (o: Observation): bigint => o.orders.filter((x) => x.isBuy).reduce((a, x) => a + quoteForSize(x.size, x.price, o.market, 'up').value, 0n);

// The one placement the Gardener uses: one tick above the best bid. "Right under the best ask" lost a race with the market
// on 2026-10-11 (docs/FINDINGS.md); one tick above the best bid planted without trouble.
export function passiveBid(o: Pick<Observation, 'book' | 'market'>, size: bigint): ProvisionBid {
  return buildBidLadder({ ...o.book, tick: o.market.tickSize, count: 1, size, offsetTicks: 1n })[0];
}

export const inRange = (m: Mandate, price: bigint): boolean => price >= m.priceMin && price <= m.priceMax;
export const distanceBps = (o: Observation, price: bigint): bigint => (o.book.bestBid > price ? ((o.book.bestBid - price) * BPS) / o.book.bestBid : 0n);
export const outOfRange = (o: Observation, m: Mandate, x: GOrder): boolean => x.isBuy && distanceBps(o, x.price) > m.bandBps;

// Biggest whole-MON size `money` buys at `price`, or 0 when that is below the market minimum.
export function sizeFor(market: Market, price: bigint, money: bigint): bigint {
  if (money <= 0n) return 0n;
  const unit = market.sizePrecision;
  let size = ((money * market.sizePrecision * market.pricePrecision) / (10n ** BigInt(market.quoteDecimals) * price * unit)) * unit;
  while (size > 0n && quoteForSize(size, price, market, 'up').value > money) size -= unit;
  return size >= market.minSize ? size : 0n;
}

// What a new bid may lock: the free USDC at Kuru plus `freed` (a bid being cancelled), within the budget left after the
// other bids.
export function moneyFor(o: Observation, m: Mandate, lockedOther: bigint, freed = 0n): bigint {
  const room = m.usdcBudget - lockedOther;
  const have = o.marginUsdc + freed;
  return have < room ? have : room;
}

export const replantSize = (o: Observation, m: Mandate, price: bigint): bigint => sizeFor(o.market, price, moneyFor(o, m, lockedUsdc(o)));

const has = (m: Mandate, k: ActionKind): boolean => m.actions.includes(k);

// The questions worth asking now, each with only the options the mandate and the state allow. Ordered by priority.
export function questions(o: Observation, m: Mandate, spend: Spend, mem: Memory, nowMs: number): Question[] {
  const out: Question[] = [];
  const lowGas = o.walletMon < feeReserveWei(o);

  // Q hedge: the short against the MON the garden holds. Reducing a hedge is protective and allowed even on low gas.
  const h = o.hedge;
  if (h && !h.otherExposure && has(m, 'hedge') && !cooling(mem, 'hedge', nowMs)) {
    const inv = gardenMon(o);
    const ratio = inv > 0n ? (h.shortLot * BPS) / inv : h.shortLot > 0n ? null : 0n;
    const tooHigh = ratio === null || ratio > m.hedgeMaxBps;
    const tooLow = ratio !== null && ratio < m.hedgeMinBps && h.shortLot === 0n && h.hasAccount && !lowGas && inv > 0n;
    if (tooHigh || tooLow) {
      out.push({ id: 'hedge', options: ['hold', 'adjust'], rulesChoice: 'adjust', facts: { inventoryMon: inv, shortMon: h.shortLot, ratioBps: ratio }, why: tooHigh ? 'The short is larger than your hedge range allows for the MON the garden holds.' : 'The garden holds MON and no short is open, below your hedge range.' });
    }
  }

  const requoteOk = has(m, 'requote') && !cooling(mem, 'requote', nowMs) && !lowGas;
  // Q tend: a resting bid that has left the range.
  if (requoteOk) {
    for (const x of o.orders.filter((x) => outOfRange(o, m, x))) {
      const fresh = passiveBid(o, x.size);
      const options: Choice[] = ['keep', 'prune'];
      const lock = quoteForSize(x.size, x.price, o.market, 'up').value;
      const size = sizeFor(o.market, fresh.price, moneyFor(o, m, lockedUsdc(o) - lock, lock));
      if (size > 0n && inRange(m, fresh.price) && hasRoom(m, spend, nowMs, 2, feeOf('cancel', o) + feeOf('plant', o))) options.splice(1, 0, 'requote');
      out.push({
        id: 'tend', options, rulesChoice: options.includes('requote') ? 'requote' : 'keep',
        facts: { orderId: x.id, distanceBps: distanceBps(o, x.price), lockedUsdc: lockedUsdc(o) },
        why: `Bid #${x.id} sits more than ${m.bandBps} basis points under the best bid.`,
      });
      break; // one order per check
    }
  }

  // Q recover: money free at Kuru and no bid resting (a failed plant or move, or a bid that was pruned).
  const bids = o.orders.filter((x) => x.isBuy);
  let recoverAsked = false;
  if (has(m, 'replant') && !cooling(mem, 'replant', nowMs) && !lowGas && bids.length === 0 && o.marginUsdc > 0n) {
    const fresh = passiveBid(o, o.market.minSize);
    const size = replantSize(o, m, fresh.price);
    if (size > 0n && inRange(m, fresh.price) && hasRoom(m, spend, nowMs, 1, feeOf('plant', o))) {
      recoverAsked = true;
      out.push({ id: 'recover', options: ['wait', 'replant'], rulesChoice: 'replant', facts: { freeUsdc: o.marginUsdc, lockedUsdc: lockedUsdc(o) }, why: 'Money is free at Kuru and no bid is resting.' });
    }
  }

  // Q harvest: money idle at Kuru for a while that nothing else will use.
  const idleMs = mem.idleSinceMs === null ? 0 : nowMs - mem.idleSinceMs;
  if (has(m, 'harvest') && !cooling(mem, 'harvest', nowMs) && !recoverAsked && idleMs >= POLICY.idleBeforeHarvestMs && (o.marginMon > 0n || (o.marginUsdc > 0n && bids.length === 0))) {
    if (hasRoom(m, spend, nowMs, 1, feeOf('withdraw', o))) out.push({ id: 'harvest', options: ['leave', 'harvest'], rulesChoice: 'harvest', facts: { freeUsdc: o.marginUsdc, freeMon: o.marginMon, idleMs }, why: 'Money has sat idle at Kuru.' });
  }
  return out;
}

// Refuel is a fixed rule, never a model question: the wallet is short of MON for protective transactions and MON is free
// at Kuru.
export function needsRefuel(o: Observation, m: Mandate, spend: Spend, mem: Memory, nowMs: number): boolean {
  return has(m, 'refuel') && !cooling(mem, 'refuel', nowMs) && o.walletMon < feeReserveWei(o) && o.marginMon > 0n && hasRoom(m, spend, nowMs, 1, feeOf('withdraw', o));
}

// ---------------------------------------------------------------- answers and routing --------------------------------

export type Answer = { choice: string; confidence: number; probabilities?: Record<string, number>; source: 'rules' | 'jev'; model?: string };
export type Route = 'act' | 'ask' | 'skip';

// An answer outside the offered options, or with a confidence that is not a number in [0, 1], is ignored.
export function route(q: Question, a: Answer | null, m: Mandate): Route {
  if (!a || !(q.options as string[]).includes(a.choice) || !(a.confidence >= 0 && a.confidence <= 1)) return 'skip';
  if (a.confidence >= m.actAt) return 'act';
  if (a.confidence >= m.askAt) return 'ask';
  return 'skip';
}

// ---------------------------------------------------------------- intents ---------------------------------------------

export type Intent =
  | { type: 'requote'; kind: 'requote'; cancelId: bigint }
  | { type: 'prune'; kind: 'requote'; ids: bigint[] }
  | { type: 'replant'; kind: 'replant' }
  | { type: 'harvest'; kind: 'harvest'; tokens: string[] }
  | { type: 'refuel'; kind: 'refuel' }
  | { type: 'hedgeReduce'; kind: 'hedge'; lot: bigint }
  | { type: 'hedgeOpen'; kind: 'hedge'; ratioBps: bigint };

// The exact intent for a choice, or null when the choice is to do nothing. Prices are NOT fixed here: the executor reads
// the book again immediately before each transaction and checks the result against the mandate (`checkBid`).
export function intentOf(q: Question, choice: Choice, o: Observation, m: Mandate): Intent | null {
  switch (q.id) {
    case 'tend': {
      const x = o.orders.find((y) => y.id === q.facts.orderId);
      if (!x) return null;
      if (choice === 'requote') return { type: 'requote', kind: 'requote', cancelId: x.id };
      if (choice === 'prune') return { type: 'prune', kind: 'requote', ids: [x.id] };
      return null;
    }
    case 'recover':
      return choice === 'replant' ? { type: 'replant', kind: 'replant' } : null;
    case 'harvest': {
      if (choice !== 'harvest') return null;
      const tokens: string[] = [];
      if (o.marginUsdc > 0n && !o.orders.some((x) => x.isBuy)) tokens.push(o.market.quoteAsset);
      if (o.marginMon > 0n) tokens.push(NATIVE);
      return tokens.length ? { type: 'harvest', kind: 'harvest', tokens } : null;
    }
    case 'hedge': {
      if (choice !== 'adjust' || !o.hedge) return null;
      const inv = gardenMon(o);
      const target = (m.hedgeMinBps + m.hedgeMaxBps) / 2n;
      if (o.hedge.shortLot > 0n) {
        const want = (inv * target) / BPS;
        const lot = o.hedge.shortLot - want;
        return lot > 0n ? { type: 'hedgeReduce', kind: 'hedge', lot } : null;
      }
      return { type: 'hedgeOpen', kind: 'hedge', ratioBps: target };
    }
  }
}

// The last check on a bid, made by the executor with the freshly read book right before the transaction.
export function checkBid(bid: ProvisionBid, o: Pick<Observation, 'book' | 'market'>, m: Mandate, lockedOther: bigint): string | null {
  if (!inRange(m, bid.price)) return 'The new bid would be outside your price range.';
  if (bid.price >= o.book.bestAsk) return 'The new bid would cross the best ask.';
  if (bid.size < o.market.minSize) return 'The new bid is below the market minimum.';
  if (lockedOther + quoteForSize(bid.size, bid.price, o.market, 'up').value > m.usdcBudget) return 'The new bid would lock more than your USDC budget.';
  return null;
}

export function describe(i: Intent): string {
  switch (i.type) {
    case 'requote': return `Re-place bid #${i.cancelId} one tick above the best bid (cancel, then plant what the freed money buys there).`;
    case 'prune': return `Cancel ${i.ids.map((x) => '#' + x).join(', ')}.`;
    case 'replant': return 'Plant the free USDC at Kuru as one flip bid one tick above the best bid.';
    case 'harvest': return `Withdraw the idle ${i.tokens.map((t) => (t === NATIVE ? 'MON' : 'USDC')).join(' and ')} from Kuru to the wallet.`;
    case 'refuel': return 'Withdraw the MON that is free at Kuru to the wallet for network fees.';
    case 'hedgeReduce': return `Buy back ${i.lot} MON of the Perpl short.`;
    case 'hedgeOpen': return `Open a Perpl short for ${i.ratioBps / 100n}% of the MON the garden holds.`;
  }
}
