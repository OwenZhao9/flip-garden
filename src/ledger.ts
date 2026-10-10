// The ledger: Kuru events + the wallet's own transactions -> orders, fills, fees, balances.
// Pure function, no I/O. Every rule is in docs/LEDGER.md; every number is a BigInt.
//
// Accounting identity (per token, Kuru margin account):
//   equity  = opening + deposits - withdrawals + fill proceeds - fill payments - fees
//   locked  = what the open orders reserve (bid: quote for remaining size; ask: base)
//   free    = equity - locked
// Gas is paid from the wallet in the native token and is tracked separately.
//
// Unknown contract semantics are never guessed: they become an Issue with severity
// 'unknown', and any number that depends on them is marked uncertain.
import type { KuruEvent, TradeEvent, FlipCreatedEvent } from './events.ts';
import {
  type Amount,
  type Market,
  baseForSize,
  eventPriceToOrderPrice,
  feeOn,
  quoteForSize,
  NATIVE,
} from './units.ts';

export type Severity = 'error' | 'warn' | 'unknown' | 'info';

export type Issue = {
  code: string;
  severity: Severity;
  en: string;
  zh: string;
  market?: string;
  orderId?: bigint;
  tx?: string;
  block?: number;
  data?: Record<string, unknown>;
};

export type OwnTx = {
  hash: string;
  block: number;
  from: string;
  gasLimit: bigint;
  gasUsed?: bigint;
  effectiveGasPrice: bigint;
  status?: number;
  label?: string;
};

export type OrderStatus = 'open' | 'filled' | 'cancelled';

export type Order = {
  market: string;
  id: bigint;
  owner: string;
  isBuy: boolean | null; // null only for an order seen first through a Trade with unknown side
  price: bigint | null;
  flipPrice: bigint | null;
  origin: 'placed' | 'flipped' | 'opening' | 'unseen';
  parent: { orderId: bigint; fillKey: string } | null;
  children: bigint[];
  initialSize: bigint | null;
  remaining: bigint | null; // null = unknown (e.g. after an unexplained FlipOrderUpdated)
  filled: bigint;
  status: OrderStatus;
  createdBlock: number | null;
  closedBlock: number | null;
  fills: string[];
};

export type Fill = {
  key: string; // `${tx}:${logIndex}`
  market: string;
  orderId: bigint;
  block: number;
  tx: string;
  logIndex: number;
  side: 'buy' | 'sell'; // OUR side (we are the maker)
  size: bigint;
  price: bigint; // order-price units
  base: Amount; // base raw that moved
  quote: Amount; // quote raw that moved
  fee: { token: string; amount: Amount };
  remainingAfter: bigint;
  taker: string;
  txOrigin: string;
  flippedTo: bigint[]; // orders this fill created
};

export type Flow = {
  block: number;
  logIndex: number;
  tx: string;
  token: string;
  amount: bigint; // signed change of the Kuru account (or of the wallet for gas)
  kind: 'opening' | 'deposit' | 'withdrawal' | 'fill' | 'fee' | 'gas';
  ref?: string;
};

export type TokenBalance = {
  equity: bigint; // free + locked inside Kuru
  locked: bigint;
  free: bigint;
  lockedUncertain: boolean; // some open order's size is unknown
  roundingEquity: bigint; // max |error| from inexact fill / fee conversions (raw units)
  roundingLocked: bigint; // max |error| from inexact lock conversions
};

export type Ledger = {
  account: string;
  untilBlock: number | null;
  markets: Map<string, Market>;
  orders: Map<string, Order>; // key `${market}:${id}`
  fills: Fill[];
  flows: Flow[];
  balances: Map<string, TokenBalance>;
  gas: { token: string; totalWei: bigint; txs: OwnTx[] };
  issues: Issue[];
};

export type Opening = {
  block: number;
  equity: Record<string, bigint>; // token -> free + locked at `block`
  orders: Array<{ market: string; id: bigint; isBuy: boolean; price: bigint; flipPrice: bigint; remaining: bigint }>;
};

export type LedgerInput = {
  account: string;
  markets: Market[];
  events: KuruEvent[];
  txs?: OwnTx[];
  opening?: Opening;
  untilBlock?: number;
  // How to read Trade.isBuy. 'taker' is verified on-chain; 'maker' exists only so tests can
  // prove the wrong reading fails reconciliation.
  tradeIsBuy?: 'taker' | 'maker';
};

export const orderKey = (market: string, id: bigint): string => `${market.toLowerCase()}:${id}`;

const lc = (s: string): string => s.toLowerCase();

export function buildLedger(input: LedgerInput): Ledger {
  const account = lc(input.account);
  const semantics = input.tradeIsBuy ?? 'taker';
  const until = input.untilBlock ?? null;
  const markets = new Map(input.markets.map((m) => [lc(m.address), m]));
  const orders = new Map<string, Order>();
  const fills: Fill[] = [];
  const flows: Flow[] = [];
  const issues: Issue[] = [];
  const roundEq = new Map<string, bigint>();
  const bump = (m: Map<string, bigint>, t: string, by = 1n): void => {
    m.set(t, (m.get(t) ?? 0n) + by);
  };
  const issue = (i: Issue): void => {
    issues.push(i);
  };
  // Each inexact lock / release may move one raw unit between the user and the contract.
  const countLock = (o: Order, size: bigint, m: Market): void => {
    const l = lockFor(o, size, m);
    if (l && !l.amount.exact) bump(roundEq, l.token);
  };

  if (input.opening) {
    for (const [t, v] of Object.entries(input.opening.equity)) {
      flows.push({ block: input.opening.block, logIndex: -1, tx: '', token: lc(t), amount: v, kind: 'opening' });
    }
    for (const o of input.opening.orders) {
      orders.set(orderKey(o.market, o.id), {
        market: lc(o.market),
        id: o.id,
        owner: account,
        isBuy: o.isBuy,
        price: o.price,
        flipPrice: o.flipPrice,
        origin: 'opening',
        parent: null,
        children: [],
        initialSize: o.remaining,
        remaining: o.remaining,
        filled: 0n,
        status: o.remaining === 0n ? 'filled' : 'open',
        createdBlock: input.opening.block,
        closedBlock: null,
        fills: [],
      });
    }
  }

  // De-duplicate (idempotent re-scans) and order canonically.
  const seen = new Set<string>();
  const evs = input.events
    .filter((e) => until === null || e.block <= until)
    .filter((e) => (input.opening ? e.block > input.opening.block : true))
    .filter((e) => {
      const k = `${e.tx}:${e.logIndex}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);

  // Group by transaction: linking a flipped order to the fill that created it needs the whole tx.
  const groups: KuruEvent[][] = [];
  for (const e of evs) {
    const g = groups[groups.length - 1];
    if (g && g[0].tx === e.tx && g[0].block === e.block) g.push(e);
    else groups.push([e]);
  }

  const isOurMarket = (addr: string): boolean => markets.has(addr);
  const fillByKey = new Map<string, Fill>();
  const childrenByFill = new Map<string, bigint[]>();

  for (const group of groups) {
    const linkedTrades = new Set<string>();
    for (const e of group) {
      switch (e.name) {
        case 'Deposit':
        case 'Withdrawal':
          if (e.owner !== account) break;
          flows.push({
            block: e.block,
            logIndex: e.logIndex,
            tx: e.tx,
            token: e.token,
            amount: e.name === 'Deposit' ? e.amount : -e.amount,
            kind: e.name === 'Deposit' ? 'deposit' : 'withdrawal',
          });
          break;

        case 'FlipOrderCreated': {
          if (e.owner !== account || !isOurMarket(e.address)) break;
          const k = orderKey(e.address, e.orderId);
          if (orders.has(k)) {
            issue({
              code: 'ORDER_ID_REUSED',
              severity: 'error',
              en: `Order ${e.orderId} was created twice.`,
              zh: `订单 ${e.orderId} 被创建了两次。`,
              market: e.address,
              orderId: e.orderId,
              tx: e.tx,
              block: e.block,
            });
            break;
          }
          const placed = newOrder(e, 'placed', null);
          orders.set(k, placed);
          checkOrderShape(e, markets.get(e.address)!, issue);
          countLock(placed, e.size, markets.get(e.address)!);
          break;
        }

        case 'FlippedOrderCreated': {
          if (e.owner !== account || !isOurMarket(e.address)) break;
          const k = orderKey(e.address, e.orderId);
          if (orders.has(k)) {
            issue({
              code: 'ORDER_ID_REUSED',
              severity: 'error',
              en: `Order ${e.orderId} was created twice.`,
              zh: `订单 ${e.orderId} 被创建了两次。`,
              market: e.address,
              orderId: e.orderId,
              tx: e.tx,
              block: e.block,
            });
            break;
          }
          const parentTrade = findParentTrade(e, group, orders, linkedTrades, account);
          const o = newOrder(e, 'flipped', null);
          orders.set(k, o);
          countLock(o, e.size, markets.get(e.address)!);
          if (parentTrade) {
            linkedTrades.add(`${parentTrade.tx}:${parentTrade.logIndex}`);
            const pk = orderKey(e.address, parentTrade.orderId);
            const fk = `${parentTrade.tx}:${parentTrade.logIndex}`;
            o.parent = { orderId: parentTrade.orderId, fillKey: fk };
            orders.get(pk)!.children.push(e.orderId);
            childrenByFill.set(fk, [...(childrenByFill.get(fk) ?? []), e.orderId]);
            if (e.size !== parentTrade.filledSize) {
              issue({
                code: 'FLIP_SIZE_DIFFERS',
                severity: 'unknown',
                en: `Flipped order ${e.orderId} has size ${e.size} but the fill that created it was ${parentTrade.filledSize}. Only equal sizes have been observed; balances still follow the event.`,
                zh: `翻转出的订单 ${e.orderId} 数量 ${e.size}，与触发它的成交量 ${parentTrade.filledSize} 不同。目前只见过两者相等；余额仍按事件记。`,
                market: e.address,
                orderId: e.orderId,
                tx: e.tx,
                block: e.block,
              });
            }
          } else {
            issue({
              code: 'FLIP_PARENT_NOT_FOUND',
              severity: 'unknown',
              en: `Flipped order ${e.orderId} appeared without a matching fill of ours in the same transaction.`,
              zh: `翻转出的订单 ${e.orderId} 在同一笔交易里找不到对应的成交。`,
              market: e.address,
              orderId: e.orderId,
              tx: e.tx,
              block: e.block,
            });
          }
          break;
        }

        case 'Trade': {
          if (!isOurMarket(e.address)) break;
          const k = orderKey(e.address, e.orderId);
          let o = orders.get(k);
          if (!o && e.maker !== account) break; // somebody else's fill
          const m = markets.get(e.address)!;
          if (o && e.maker !== account) {
            issue({
              code: 'TRADE_MAKER_MISMATCH',
              severity: 'error',
              en: `Fill of our order ${e.orderId} names a different maker (${e.maker}).`,
              zh: `我方订单 ${e.orderId} 的成交事件里，挂单方地址是别人（${e.maker}）。`,
              market: e.address,
              orderId: e.orderId,
              tx: e.tx,
              block: e.block,
            });
          }
          // Our side as the maker. Verified: Trade.isBuy is the taker's side.
          const sideFromEvent = semantics === 'taker' ? !e.isBuy : e.isBuy;
          if (!o) {
            o = {
              market: e.address,
              id: e.orderId,
              owner: account,
              isBuy: sideFromEvent,
              price: null,
              flipPrice: null,
              origin: 'unseen',
              parent: null,
              children: [],
              initialSize: null,
              remaining: e.updatedSize + e.filledSize,
              filled: 0n,
              status: 'open',
              createdBlock: null,
              closedBlock: null,
              fills: [],
            };
            orders.set(k, o);
            issue({
              code: 'ORDER_NOT_SEEN',
              severity: 'warn',
              en: `Order ${e.orderId} was filled but its creation is outside the scanned range; its side comes from the Trade event.`,
              zh: `订单 ${e.orderId} 有成交，但创建事件不在扫描范围内；方向按成交事件推断。`,
              market: e.address,
              orderId: e.orderId,
              tx: e.tx,
              block: e.block,
            });
          } else if (o.isBuy !== sideFromEvent) {
            issue({
              code: 'TRADE_SIDE_MISMATCH',
              severity: 'error',
              en: `Order ${e.orderId} is a ${o.isBuy ? 'bid' : 'ask'}, but reading Trade.isBuy as the ${semantics} side says otherwise.`,
              zh: `订单 ${e.orderId} 是${o.isBuy ? '买单' : '卖单'}，但把 Trade.isBuy 当作${semantics === 'taker' ? '吃单方' : '挂单方'}方向来读，结论相反。`,
              market: e.address,
              orderId: e.orderId,
              tx: e.tx,
              block: e.block,
            });
          }
          if (o.status === 'cancelled') {
            issue({
              code: 'FILL_AFTER_CANCEL',
              severity: 'error',
              en: `Order ${e.orderId} was filled after it was cancelled.`,
              zh: `订单 ${e.orderId} 撤单后又出现成交。`,
              market: e.address,
              orderId: e.orderId,
              tx: e.tx,
              block: e.block,
            });
          }
          const pe = eventPriceToOrderPrice(e.price1e18, m);
          if (!pe.exact) {
            issue({
              code: 'TRADE_PRICE_NOT_ON_GRID',
              severity: 'error',
              en: `Fill price ${e.price1e18} (1e18) is not a whole order price.`,
              zh: `成交价 ${e.price1e18}（1e18 精度）不是整数个订单价格单位。`,
              market: e.address,
              orderId: e.orderId,
              tx: e.tx,
              block: e.block,
            });
          }
          if (o.price === null) o.price = pe.value;
          else if (o.price !== pe.value) {
            issue({
              code: 'TRADE_PRICE_MISMATCH',
              severity: 'error',
              en: `Order ${e.orderId} rests at ${o.price} but was filled at ${pe.value}.`,
              zh: `订单 ${e.orderId} 挂价 ${o.price}，成交价却是 ${pe.value}。`,
              market: e.address,
              orderId: e.orderId,
              tx: e.tx,
              block: e.block,
            });
          }
          if (o.remaining !== null && o.remaining - e.filledSize !== e.updatedSize) {
            issue({
              code: 'TRADE_SIZE_MISMATCH',
              severity: 'error',
              en: `Order ${e.orderId}: remaining ${o.remaining} minus filled ${e.filledSize} should be ${o.remaining - e.filledSize}, the event says ${e.updatedSize}. Using the event.`,
              zh: `订单 ${e.orderId}：剩余 ${o.remaining} 减去成交 ${e.filledSize} 应为 ${o.remaining - e.filledSize}，事件给的是 ${e.updatedSize}，按事件记。`,
              market: e.address,
              orderId: e.orderId,
              tx: e.tx,
              block: e.block,
            });
          }
          const ourBuy = o.isBuy ?? sideFromEvent;
          const side: 'buy' | 'sell' = ourBuy ? 'buy' : 'sell';
          // Received rounds down, paid rounds up (docs/LEDGER.md).
          const base = baseForSize(e.filledSize, m, ourBuy ? 'down' : 'up');
          const quote = quoteForSize(e.filledSize, pe.value, m, ourBuy ? 'up' : 'down');
          const feeToken = ourBuy ? m.baseAsset : m.quoteAsset;
          const fee = feeOn(ourBuy ? base.value : quote.value, m.makerFeeBps);
          const key = `${e.tx}:${e.logIndex}`;
          const f: Fill = {
            key,
            market: e.address,
            orderId: e.orderId,
            block: e.block,
            tx: e.tx,
            logIndex: e.logIndex,
            side,
            size: e.filledSize,
            price: pe.value,
            base,
            quote,
            fee: { token: feeToken, amount: fee },
            remainingAfter: e.updatedSize,
            taker: e.taker,
            txOrigin: e.txOrigin,
            flippedTo: [],
          };
          fills.push(f);
          fillByKey.set(key, f);
          o.fills.push(key);
          o.filled += e.filledSize;
          o.remaining = e.updatedSize;
          countLock(o, e.updatedSize, m); // the release of the filled part may round
          if (e.updatedSize === 0n) {
            o.status = 'filled';
            o.closedBlock = e.block;
          }
          const pos = { block: e.block, logIndex: e.logIndex, tx: e.tx, ref: key };
          flows.push({ ...pos, token: m.baseAsset, amount: ourBuy ? base.value : -base.value, kind: 'fill' });
          flows.push({ ...pos, token: m.quoteAsset, amount: ourBuy ? -quote.value : quote.value, kind: 'fill' });
          if (fee.value !== 0n) flows.push({ ...pos, token: feeToken, amount: -fee.value, kind: 'fee' });
          if (!base.exact) bump(roundEq, m.baseAsset);
          if (!quote.exact) bump(roundEq, m.quoteAsset);
          if (!fee.exact) bump(roundEq, feeToken);
          break;
        }

        case 'FlipOrderUpdated': {
          if (!isOurMarket(e.address)) break;
          const o = orders.get(orderKey(e.address, e.orderId));
          if (!o) break; // not ours (the event has no owner field)
          o.remaining = null;
          issue({
            code: 'FLIP_ORDER_UPDATED',
            severity: 'unknown',
            en: `FlipOrderUpdated(${e.orderId}, ${e.size}): what this size means has not been observed on-chain, so the order's remaining size (and the locked/free split) is unknown until it is cancelled or filled. Totals are unaffected.`,
            zh: `FlipOrderUpdated(${e.orderId}, ${e.size})：这个数量的含义还没在链上观察到，订单剩余量（以及可用/锁定的划分）在撤单或成交前记为未知。总额不受影响。`,
            market: e.address,
            orderId: e.orderId,
            tx: e.tx,
            block: e.block,
            data: { size: e.size },
          });
          break;
        }

        case 'FlipOrdersCanceled': {
          if (e.owner !== account || !isOurMarket(e.address)) break;
          for (const id of e.orderIds) {
            const o = orders.get(orderKey(e.address, id));
            if (!o) {
              issue({
                code: 'CANCEL_UNKNOWN_ORDER',
                severity: 'warn',
                en: `Cancelled order ${id} was created outside the scanned range; its released amount is unknown.`,
                zh: `被撤的订单 ${id} 创建于扫描范围之外，释放金额未知。`,
                market: e.address,
                orderId: id,
                tx: e.tx,
                block: e.block,
              });
              continue;
            }
            if (o.status !== 'open') {
              issue({
                code: 'CANCEL_CLOSED_ORDER',
                severity: 'error',
                en: `Order ${id} was cancelled but the ledger has it as ${o.status}.`,
                zh: `订单 ${id} 被撤，但账本里它已是「${o.status === 'filled' ? '已成交' : '已撤'}」。`,
                market: e.address,
                orderId: id,
                tx: e.tx,
                block: e.block,
              });
            }
            if (o.remaining !== null && o.remaining > 0n) countLock(o, o.remaining, markets.get(e.address)!);
            o.status = 'cancelled';
            o.remaining = 0n;
            o.closedBlock = e.block;
          }
          break;
        }
      }
    }

    // A full fill of a flip order is expected to create a flipped order in the same tx.
    for (const e of group) {
      if (e.name !== 'Trade') continue;
      const f = fillByKey.get(`${e.tx}:${e.logIndex}`);
      if (!f) continue;
      const o = orders.get(orderKey(e.address, e.orderId))!;
      const kids = childrenByFill.get(f.key) ?? [];
      f.flippedTo = kids;
      if (kids.length === 0 && (o.origin === 'placed' || o.origin === 'flipped')) {
        issue({
          code: e.updatedSize === 0n ? 'FLIP_MISSING' : 'PARTIAL_FILL_NO_FLIP',
          severity: 'unknown',
          en:
            e.updatedSize === 0n
              ? `Order ${e.orderId} filled in full but no flipped order appeared in the same transaction. The proceeds are counted in equity; where they sit (free or locked) is unverified.`
              : `Partial fill of flip order ${e.orderId} with no flipped order in the same transaction. Partial-fill behaviour has not been observed on-chain; the proceeds are counted in equity and assumed free.`,
          zh:
            e.updatedSize === 0n
              ? `订单 ${e.orderId} 全部成交，但同一笔交易里没有翻转出新订单。成交所得已计入总额；它在「可用」还是「锁定」里未经验证。`
              : `翻转单 ${e.orderId} 部分成交，同一笔交易里没有翻转出新订单。部分成交的行为还没在链上观察到；成交所得已计入总额，暂按「可用」处理。`,
          market: e.address,
          orderId: e.orderId,
          tx: e.tx,
          block: e.block,
        });
      }
    }
  }

  // Gas: Monad charges gasLimit × effectiveGasPrice (verified: receipt gasUsed == gasLimit).
  const gasSeen = new Set<string>();
  const gasTxs: OwnTx[] = [];
  let gasTotal = 0n;
  for (const t of input.txs ?? []) {
    if (lc(t.from) !== account) continue;
    if (until !== null && t.block > until) continue;
    if (input.opening && t.block <= input.opening.block) continue;
    const h = lc(t.hash);
    if (gasSeen.has(h)) continue;
    gasSeen.add(h);
    const fee = t.gasLimit * t.effectiveGasPrice;
    gasTotal += fee;
    gasTxs.push(t);
    flows.push({ block: t.block, logIndex: -1, tx: h, token: NATIVE, amount: -fee, kind: 'gas', ref: t.label });
  }

  // Balances.
  const balances = new Map<string, TokenBalance>();
  const tb = (t: string): TokenBalance => {
    let b = balances.get(t);
    if (!b) {
      b = { equity: 0n, locked: 0n, free: 0n, lockedUncertain: false, roundingEquity: roundEq.get(t) ?? 0n, roundingLocked: 0n };
      balances.set(t, b);
    }
    return b;
  };
  for (const m of markets.values()) {
    tb(m.baseAsset);
    tb(m.quoteAsset);
  }
  for (const f of flows) if (f.kind !== 'gas') tb(f.token).equity += f.amount;
  for (const o of orders.values()) {
    if (o.status !== 'open') continue;
    const m = markets.get(o.market);
    if (!m) continue;
    if (o.isBuy === null) continue;
    const token = o.isBuy ? m.quoteAsset : m.baseAsset;
    if (o.remaining === null || o.price === null) {
      tb(token).lockedUncertain = true;
      continue;
    }
    const l = lockFor(o, o.remaining, m)!;
    tb(token).locked += l.amount.value;
    if (!l.amount.exact) tb(token).roundingLocked += 1n;
  }
  for (const [t, b] of balances) {
    b.free = b.equity - b.locked;
    if (b.free < -(b.roundingEquity + b.roundingLocked) && !b.lockedUncertain) {
      issue({
        code: 'NEGATIVE_FREE',
        severity: 'error',
        en: `Free balance of ${t} would be negative (${b.free}): some event is missing or misread.`,
        zh: `${t} 的可用余额算出来是负数（${b.free}）：有事件缺失或读错了。`,
      });
    }
  }

  return {
    account,
    untilBlock: until,
    markets,
    orders,
    fills,
    flows,
    balances,
    gas: { token: NATIVE, totalWei: gasTotal, txs: gasTxs },
    issues,
  };
}

// What an order reserves for `size`: a bid locks quote (rounded up), an ask locks base.
function lockFor(o: Order, size: bigint, m: Market): { token: string; amount: Amount } | null {
  if (o.isBuy === null || o.price === null) return null;
  return o.isBuy
    ? { token: m.quoteAsset, amount: quoteForSize(size, o.price, m, 'up') }
    : { token: m.baseAsset, amount: baseForSize(size, m, 'up') };
}

function newOrder(e: FlipCreatedEvent, origin: 'placed' | 'flipped', parent: Order['parent']): Order {
  return {
    market: e.address,
    id: e.orderId,
    owner: e.owner,
    isBuy: e.isBuy,
    price: e.price,
    flipPrice: e.flippedPrice,
    origin,
    parent,
    children: [],
    initialSize: e.size,
    remaining: e.size,
    filled: 0n,
    status: e.size === 0n ? 'filled' : 'open',
    createdBlock: e.block,
    closedBlock: null,
    fills: [],
  };
}

function checkOrderShape(e: FlipCreatedEvent, m: Market, issue: (i: Issue) => void): void {
  const bad = (code: string, en: string, zh: string): void =>
    issue({ code, severity: 'warn', en, zh, market: e.address, orderId: e.orderId, tx: e.tx, block: e.block });
  if (e.price % m.tickSize !== 0n || e.flippedPrice % m.tickSize !== 0n) {
    bad('PRICE_OFF_TICK', `Order ${e.orderId} has a price off the tick grid.`, `订单 ${e.orderId} 的价格不在最小报价单位的整数倍上。`);
  }
  if (e.isBuy ? e.flippedPrice <= e.price : e.flippedPrice >= e.price) {
    bad('FLIP_PRICE_WRONG_SIDE', `Order ${e.orderId}: flip price is on the wrong side of the order price.`, `订单 ${e.orderId}：翻转价在挂单价的错误一侧。`);
  }
}

// The fill that created a flipped order: same tx, one of our orders, opposite side, prices swapped.
// Observed order of logs: FlippedOrderCreated comes right BEFORE its Trade. Prefer the first
// matching Trade after the event; fall back to any matching Trade in the tx.
function findParentTrade(
  e: FlipCreatedEvent,
  group: KuruEvent[],
  orders: Map<string, Order>,
  taken: Set<string>,
  account: string,
): TradeEvent | null {
  const matches = (t: KuruEvent): t is TradeEvent => {
    if (t.name !== 'Trade' || t.address !== e.address) return false;
    if (taken.has(`${t.tx}:${t.logIndex}`)) return false;
    const o = orders.get(orderKey(t.address, t.orderId));
    if (!o || o.owner !== account) return false;
    return o.isBuy === !e.isBuy && o.flipPrice === e.price && o.price === e.flippedPrice;
  };
  const after = group.find((t) => t.logIndex > e.logIndex && matches(t));
  if (after) return after as TradeEvent;
  const any = group.find((t) => matches(t));
  return (any as TradeEvent | undefined) ?? null;
}
