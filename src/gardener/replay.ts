// Replay: what a Gardener would have done, block by block, on recorded real market data (scripts/gardener-record.ts).
// It runs the same policy (stop conditions, questions, routing, intents, the last bid check) and the same deciders as the
// page; only the chain is simulated, with a deliberately simple model that is stated here in full:
//   - The book is the recorded best bid and ask of every block (our own orders are not added to it).
//   - A resting bid at price p fills completely in block b if a recorded taker sell in b traded at p or lower, or the
//     recorded best ask in b is at or below p. A resting sell at q fills if a taker buy traded at q or higher, or the best
//     bid is at or above q. A filled order flips into the opposite order at its flip price, as Kuru does.
//   - A transaction sent at block d is included at d + latency. A bid that would cross the best ask at inclusion reverts
//     (Kuru's ProvisionError, as on 2026-10-11); a cancel of an order that is no longer resting reverts. A reverted
//     transaction pays its gas limit. Before sending, the book of block d is checked, as sendStep does (no fee if refused).
//   - Network fees use the gas limits the executor sets (1.2 x the measured estimates) at the recorded gas price.
//   - Hedging is not replayed (no Perpl prices were recorded); the hedge logic is covered by the fake-chain tests.
// Pure computation over the fixture; no network unless the decider itself calls one (the Jev decider).
import { BPS, quoteForSize, type Market } from '../units.ts';
import type { Decider } from './decide.ts';
import { defaultMandate, failuresSince, type Mandate, type Spend } from './mandate.ts';
import {
  afterAction, checkBid, distanceBps, freshMemory, intentOf, moneyFor, needsRefuel, passiveBid, questions, remember, route, sizeFor, stopCheck, POLICY,
  type Choice, type GOrder, type Intent, type Memory, type Observation,
} from './policy.ts';

export type ReplayFixture = {
  label: string;
  account: string;
  fromBlock: number;
  toBlock: number;
  market: Record<string, string | number>;
  book: [number, string, string][];
  trades: [number, string, boolean, string][];
  own: { name: string; block: number; price?: string; flippedPrice?: string; size?: string; isBuy?: boolean }[];
};

export type ReplayOptions = {
  decider: Decider | null; // null = no Gardener: the flip orders alone after the first planting
  everyBlocks?: number; // a check every this many blocks
  latencyBlocks?: number;
  msPerBlock?: number;
  gasPriceWei?: bigint;
  mandate?: (m: Mandate) => Mandate;
};

export type ReplayMetrics = {
  label: string;
  gardener: string;
  blocks: number;
  bidFills: number;
  sellFills: number; // completed round trips
  blocksOutOfRange: number; // blocks in which a resting bid sat more than the band under the best bid
  blocksIdle: number; // blocks with free USDC at Kuru and no bid resting
  txs: number;
  failedTxs: number;
  refusedBeforeSending: number;
  feeWei: bigint;
  decisions: number; // questions asked
  acted: number;
  asked: number; // would have asked the user (counted, not carried out)
  skipped: number; // no answer or confidence too low
  endValueUsdc: bigint; // free, locked and harvested USDC, plus MON valued at the final mid, minus fees valued at the final mid (raw USDC)
  startValueUsdc: bigint;
};

const GAS = { plant: 338_268n, cancel: 213_803n, withdraw: 228_065n }; // 1.2 x 281,890 / 178,169 / 190,054 (2026-10-10)

export function marketOf(f: ReplayFixture): Market {
  const m = f.market;
  return {
    address: String(m.address), pricePrecision: BigInt(m.pricePrecision), sizePrecision: BigInt(m.sizePrecision), baseAsset: String(m.baseAsset), baseDecimals: Number(m.baseDecimals),
    quoteAsset: String(m.quoteAsset), quoteDecimals: Number(m.quoteDecimals), tickSize: BigInt(m.tickSize), minSize: BigInt(m.minSize), maxSize: BigInt(m.maxSize), takerFeeBps: BigInt(m.takerFeeBps), makerFeeBps: BigInt(m.makerFeeBps),
  };
}

type Book = { bestBid: bigint; bestAsk: bigint };
type Pending = { at: number; run: () => void };

export async function replay(f: ReplayFixture, o: ReplayOptions): Promise<ReplayMetrics> {
  const market = marketOf(f);
  const every = o.everyBlocks ?? 16; // about 5 s
  const latency = o.latencyBlocks ?? 5; // about 1.5 s from the last book check to inclusion
  const msPerBlock = o.msPerBlock ?? 302;
  const gasPrice = o.gasPriceWei ?? 101_500_000_000n;

  // book per block
  const bookAt = new Map<number, Book>();
  let cur: Book = { bestBid: 0n, bestAsk: 0n };
  let bi = 0;
  for (let b = f.fromBlock; b <= f.toBlock; b++) {
    while (bi < f.book.length && f.book[bi][0] <= b) cur = { bestBid: BigInt(f.book[bi][1]), bestAsk: BigInt(f.book[bi][2]) }, bi++;
    bookAt.set(b, cur);
  }
  const tradesAt = new Map<number, { price: bigint; takerBuy: boolean }[]>();
  for (const [b, p, takerBuy] of f.trades) tradesAt.set(b, [...(tradesAt.get(b) ?? []), { price: BigInt(p), takerBuy }]);

  // The garden at the first planting; for a window without one (account "-"), a fresh 6 USDC bid one tick above the best
  // bid at the first block with a usable book.
  let first = f.own.find((e) => e.name === 'FlipOrderCreated') as { block: number; price?: string; flippedPrice?: string; size?: string } | undefined;
  if (!first) {
    let b = f.fromBlock;
    while (b < f.toBlock && !(bookAt.get(b)!.bestBid > 0n && bookAt.get(b)!.bestAsk > bookAt.get(b)!.bestBid)) b++;
    const bk = bookAt.get(b)!;
    const price = passiveBid({ book: bk, market }, market.minSize).price;
    const bid = passiveBid({ book: bk, market }, sizeFor(market, price, 6_000_000n));
    first = { block: b, price: String(bid.price), flippedPrice: String(bid.flipPrice), size: String(bid.size) };
  }
  let nextId = 1n;
  const orders = new Map<bigint, GOrder>();
  const firstOrder: GOrder = { id: nextId++, isBuy: true, price: BigInt(first.price!), flipPrice: BigInt(first.flippedPrice!), size: BigInt(first.size!) };
  orders.set(firstOrder.id, firstOrder);
  const lockOf = (x: GOrder): bigint => quoteForSize(x.size, x.price, market, 'up').value;
  const monOf = (x: GOrder): bigint => (x.size * 10n ** BigInt(market.baseDecimals)) / market.sizePrecision;
  let marginUsdc = 0n;
  let marginMon = 0n;
  let walletMon = 5n * 10n ** 18n;
  let harvestedUsdc = 0n; // withdrawn to the wallet: still the owner's money, counted in the value
  const startBook = bookAt.get(first.block)!;

  let mandate = defaultMandate(f.account, first.block * msPerBlock, startBook, market.tickSize);
  mandate = { ...mandate, usdcBudget: ((lockOf(firstOrder) + 999_999n) / 1_000_000n) * 1_000_000n, expiresMs: (f.toBlock + 1) * msPerBlock };
  if (o.mandate) mandate = o.mandate(mandate);

  const startMid = (startBook.bestBid + startBook.bestAsk) / 2n;
  const valueAt = (mid: bigint, fee: bigint): bigint => {
    let usdc = marginUsdc + harvestedUsdc;
    let mon = marginMon;
    for (const x of orders.values()) x.isBuy ? (usdc += lockOf(x)) : (mon += monOf(x));
    const monUsdc = (mon * mid * 10n ** BigInt(market.quoteDecimals)) / (10n ** BigInt(market.baseDecimals) * market.pricePrecision);
    const feeUsdc = (fee * mid * 10n ** BigInt(market.quoteDecimals)) / (10n ** 18n * market.pricePrecision);
    return usdc + monUsdc - feeUsdc;
  };
  const m: ReplayMetrics = {
    label: f.label, gardener: o.decider?.name ?? 'none', blocks: f.toBlock - first.block + 1, bidFills: 0, sellFills: 0, blocksOutOfRange: 0, blocksIdle: 0,
    txs: 0, failedTxs: 0, refusedBeforeSending: 0, feeWei: 0n, decisions: 0, acted: 0, asked: 0, skipped: 0, startValueUsdc: valueAt(startMid, 0n), endValueUsdc: 0n,
  };

  let spend: Spend = [];
  let mem: Memory = freshMemory();
  const mids: bigint[] = [];
  const pending: Pending[] = [];
  let busyUntil = 0; // one intent at a time, as in the page
  let block = first.block;

  const pay = (b: number, kind: keyof typeof GAS, ok: boolean): void => {
    const fee = GAS[kind] * gasPrice;
    m.txs++;
    m.feeWei += fee;
    walletMon -= fee;
    if (!ok) m.failedTxs++;
    spend = [...spend, { atMs: b * msPerBlock, kind, feeWei: fee, ok }];
  };

  // Simulated executor: the same steps as execute.ts, with inclusion `latency` blocks after sending.
  function send(b: number, intent: Intent, lockedOther: bigint, done: (ok: boolean) => void): void {
    const plantAt = (sendBlock: number, size: (bk: Book) => bigint): void => {
      const bk = bookAt.get(sendBlock)!;
      const sz = size(bk);
      if (sz <= 0n) return (m.refusedBeforeSending++, done(false));
      const bid = passiveBid({ book: bk, market }, sz);
      if (checkBid(bid, { book: bk, market }, mandate, lockedOther) || marginUsdc < lockOf({ ...bid, id: 0n, isBuy: true })) return (m.refusedBeforeSending++, done(false));
      const inc = sendBlock + latency;
      pending.push({
        at: inc,
        run: () => {
          const now = bookAt.get(inc) ?? bk;
          if (bid.price >= now.bestAsk) return (pay(inc, 'plant', false), done(false));
          const x: GOrder = { id: nextId++, isBuy: true, price: bid.price, flipPrice: bid.flipPrice, size: bid.size };
          marginUsdc -= lockOf(x);
          orders.set(x.id, x);
          pay(inc, 'plant', true);
          done(true);
        },
      });
    };
    switch (intent.type) {
      case 'requote':
      case 'prune': {
        const ids = intent.type === 'requote' ? [intent.cancelId] : intent.ids;
        const inc = b + latency;
        pending.push({
          at: inc,
          run: () => {
            if (!ids.every((id) => orders.has(id))) return (pay(inc, 'cancel', false), done(false));
            for (const id of ids) {
              const x = orders.get(id)!;
              x.isBuy ? (marginUsdc += lockOf(x)) : (marginMon += monOf(x));
              orders.delete(id);
            }
            pay(inc, 'cancel', true);
            if (intent.type === 'requote') plantAt(inc, (bk) => sizeFor(market, passiveBid({ book: bk, market }, market.minSize).price, moneyFor(observe(inc), mandate, lockedOther)));
            else done(true);
          },
        });
        return;
      }
      case 'replant':
        return plantAt(b, (bk) => sizeFor(market, passiveBid({ book: bk, market }, market.minSize).price, moneyFor(observe(b), mandate, lockedOther)));
      case 'harvest':
      case 'refuel': {
        const inc = b + latency;
        pending.push({
          at: inc,
          run: () => {
            if (intent.type === 'refuel' || intent.tokens.some((t) => t === '0x0000000000000000000000000000000000000000')) (walletMon += marginMon), (marginMon = 0n);
            if (intent.type === 'harvest' && intent.tokens.some((t) => t !== '0x0000000000000000000000000000000000000000')) (harvestedUsdc += marginUsdc), (marginUsdc = 0n);
            pay(inc, 'withdraw', true);
            done(true);
          },
        });
        return;
      }
      default:
        return done(false); // hedging is not replayed
    }
  }

  function observe(b: number): Observation {
    return { block: b, readAtMs: b * msPerBlock, market, book: bookAt.get(b)!, mids: [...mids], orders: [...orders.values()], walletMon, marginUsdc, marginMon, hedge: null, gasPriceWei: gasPrice };
  }

  for (let b = first.block + 1; b <= f.toBlock; b++) {
    block = b;
    const bk = bookAt.get(b)!;
    // 1. fills in this block
    const trades = tradesAt.get(b) ?? [];
    for (const x of [...orders.values()]) {
      const hit = x.isBuy ? trades.some((t) => !t.takerBuy && t.price <= x.price) || bk.bestAsk <= x.price : trades.some((t) => t.takerBuy && t.price >= x.price) || bk.bestBid >= x.price;
      if (!hit) continue;
      orders.delete(x.id);
      const y: GOrder = { id: nextId++, isBuy: !x.isBuy, price: x.flipPrice, flipPrice: x.price, size: x.size };
      if (x.isBuy) m.bidFills++;
      else {
        m.sellFills++;
        // the sell paid out USDC that the new bid locks at a lower price; the difference is the round trip's profit
        marginUsdc += quoteForSize(x.size, x.price, market, 'down').value - lockOf(y);
      }
      orders.set(y.id, y);
    }
    // 2. transactions included in this block
    for (const p of pending.filter((q) => q.at === b)) p.run();
    pending.splice(0, pending.length, ...pending.filter((q) => q.at !== b));
    // 3. metrics for this block
    if ([...orders.values()].some((x) => x.isBuy && distanceBps({ book: bk } as Observation, x.price) > mandate.bandBps)) m.blocksOutOfRange++;
    if (marginUsdc >= quoteForSize(market.minSize, bk.bestBid, market, 'up').value && ![...orders.values()].some((x) => x.isBuy)) m.blocksIdle++;
    // 4. a check
    if ((b - first.block) % every !== 0 || bk.bestAsk <= bk.bestBid || bk.bestBid === 0n) continue;
    mids.push((bk.bestBid + bk.bestAsk) / 2n);
    if (mids.length > 20) mids.shift();
    if (!o.decider || b < busyUntil) continue;
    const now = b * msPerBlock;
    const obs = observe(b);
    mem = remember(mem, obs, now);
    if (stopCheck(obs, mandate, spend, mem, now)) continue;
    let intent: Intent | null = null;
    if (needsRefuel(obs, mandate, spend, mem, now)) intent = { type: 'refuel', kind: 'refuel' };
    else {
      const qs = questions(obs, mandate, spend, mem, now);
      if (!qs.length) continue;
      m.decisions += qs.length;
      const answers = await o.decider.decide(qs, { obs, mandate, failures: failuresSince(spend, now - POLICY.failureWindowMs), checkSeconds: (every * msPerBlock) / 1000 });
      for (let i = 0; i < qs.length && !intent; i++) {
        const r = route(qs[i], answers[i] ?? null, mandate);
        if (r === 'skip') { m.skipped++; continue; }
        const it = intentOf(qs[i], answers[i]!.choice as Choice, obs, mandate);
        if (!it) continue;
        if (r === 'ask') { m.asked++; continue; } // a person would have been asked; the replay does not guess the answer
        m.acted++;
        intent = it;
      }
    }
    if (!intent) continue;
    const kind = intent.kind;
    const lockedOther = [...orders.values()].filter((x) => x.isBuy && !(intent!.type === 'requote' && x.id === (intent as { cancelId: bigint }).cancelId)).reduce((a, x) => a + lockOf(x), 0n);
    busyUntil = Number.MAX_SAFE_INTEGER;
    send(b, intent, lockedOther, (ok) => {
      busyUntil = 0;
      mem = afterAction(mem, kind, ok, block * msPerBlock);
    });
  }
  const endBook = bookAt.get(f.toBlock)!;
  m.endValueUsdc = valueAt((endBook.bestBid + endBook.bestAsk) / 2n, m.feeWei);
  return m;
}

export const bpsOf = (a: bigint, b: bigint): bigint => (b === 0n ? 0n : (a * BPS) / b);
