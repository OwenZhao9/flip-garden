// A deliberately simple reference "chain": a Kuru-like market with flip orders, written
// independently of src/ (it shares only the event shapes). Default behaviour follows what was
// observed on mainnet (docs/FINDINGS.md); 'flip-per-fill' is a hypothetical alternative. It keeps real balances the way a
// contract would (free margin + a per-order reserve) and emits the events a scanner would see.
//
// Contract rounding for inexact amounts is unknown, so in 'random' mode every inexact
// conversion rounds down or up at random: the ledger must stay within its rounding budget
// whatever the contract does. Fee and partial-fill behaviour follow the ASSUMED model in
// docs/LEDGER.md (unverified on-chain); the ledger reads sizes from events, not from the model.
import type { KuruEvent } from '../../src/events.ts';
import type { OwnTx } from '../../src/ledger.ts';
import type { ChainState, ChainOrder } from '../../src/reconcile.ts';

export type SimMarket = {
  address: string;
  baseAsset: string;
  quoteAsset: string;
  baseDecimals: number;
  quoteDecimals: number;
  pricePrecision: bigint;
  sizePrecision: bigint;
  tickSize: bigint;
  minSize: bigint;
  makerFeeBps: bigint;
  takerFeeBps: bigint;
};

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randBig(r: () => number, lo: bigint, hi: bigint): bigint {
  if (hi <= lo) return lo;
  const span = hi - lo + 1n;
  // 53 random bits at a time are plenty for test ranges.
  let x = 0n;
  for (let i = 0; i < 4; i++) x = (x << 30n) | BigInt(Math.floor(r() * 2 ** 30));
  return lo + (x % span);
}

type SimOrder = {
  id: bigint;
  isBuy: boolean;
  price: bigint;
  flipPrice: bigint;
  size: bigint;
  reserve: bigint; // what the contract holds for this order (quote for a bid, base for an ask)
  child: bigint | null; // last flipped order created from this one (update-existing mode)
};

export class Chain {
  readonly m: SimMarket;
  readonly account: string;
  readonly r: () => number;
  readonly rounding: 'random' | 'down';
  readonly partial: 'flip-per-fill' | 'update-existing';
  wallet = new Map<string, bigint>();
  margin = new Map<string, bigint>();
  orders = new Map<bigint, SimOrder>();
  everCreated = new Map<bigint, { isBuy: boolean; price: bigint }>();
  events: KuruEvent[] = [];
  txs: OwnTx[] = [];
  block = 1000;
  private logIndex = 0;
  private nextId = 1n;
  private txn = 0;
  readonly native = '0x0000000000000000000000000000000000000000';
  // Truth for PnL: quote/base the account gained from trading (fills net of fees).
  tradedQuote = 0n;
  tradedBase = 0n;

  constructor(m: SimMarket, opts: { seed: number; rounding?: 'random' | 'down'; partial?: 'flip-per-fill' | 'update-existing' }) {
    this.m = m;
    this.account = '0x00000000000000000000000000000000000000aa';
    this.r = rng(opts.seed);
    this.rounding = opts.rounding ?? 'random';
    this.partial = opts.partial ?? 'update-existing';
  }

  // floor or ceil of num/den; exact when divisible.
  private conv(num: bigint, den: bigint): bigint {
    const t = num / den;
    if (num % den === 0n) return t;
    if (this.rounding === 'down') return t;
    return this.r() < 0.5 ? t : t + 1n;
  }
  private quoteOf(size: bigint, price: bigint): bigint {
    return this.conv(size * price * 10n ** BigInt(this.m.quoteDecimals), this.m.sizePrecision * this.m.pricePrecision);
  }
  private baseOf(size: bigint): bigint {
    return this.conv(size * 10n ** BigInt(this.m.baseDecimals), this.m.sizePrecision);
  }
  private fee(amount: bigint): bigint {
    return this.conv(amount * this.m.makerFeeBps, 10_000n);
  }

  private add(map: Map<string, bigint>, t: string, v: bigint): void {
    map.set(t, (map.get(t) ?? 0n) + v);
  }
  private nextBlock(): void {
    this.block += 1 + Math.floor(this.r() * 3);
    this.logIndex = 0;
  }
  private txHash(): string {
    this.txn++;
    return '0x' + this.txn.toString(16).padStart(64, '0');
  }
  private emit(tx: string, e: Record<string, unknown>): void {
    this.events.push({ ...e, block: this.block, logIndex: this.logIndex++, tx, address: this.m.address } as KuruEvent);
  }
  // One transaction sent by the account: pays gas in the native token at the gas LIMIT.
  private ownTx(label: string): string {
    this.nextBlock();
    const hash = this.txHash();
    const gasLimit = BigInt(80_000 + Math.floor(this.r() * 300_000));
    const price = BigInt(100_000_000_000 + Math.floor(this.r() * 3_000_000_000));
    this.add(this.wallet, this.native, -gasLimit * price);
    this.txs.push({ hash, block: this.block, from: this.account, gasLimit, gasUsed: gasLimit, effectiveGasPrice: price, label });
    return hash;
  }

  fund(token: string, amount: bigint): void {
    this.add(this.wallet, token, amount);
  }

  deposit(token: string, amount: bigint): void {
    const tx = this.ownTx('deposit');
    this.add(this.wallet, token, -amount);
    this.add(this.margin, token, amount);
    this.events.push({ name: 'Deposit', owner: this.account, token, amount, block: this.block, logIndex: this.logIndex++, tx, address: '0xmargin' } as KuruEvent);
  }

  withdraw(token: string, amount: bigint): void {
    const tx = this.ownTx('withdraw');
    if ((this.margin.get(token) ?? 0n) < amount) throw new Error('sim: withdraw more than free');
    this.add(this.margin, token, -amount);
    this.add(this.wallet, token, amount);
    this.events.push({ name: 'Withdrawal', owner: this.account, token, amount, block: this.block, logIndex: this.logIndex++, tx, address: '0xmargin' } as KuruEvent);
  }

  // Places flip orders in one transaction; skips (like provisionOrRevert=false) any it cannot fund.
  place(specs: Array<{ isBuy: boolean; price: bigint; flipPrice: bigint; size: bigint }>): bigint[] {
    const tx = this.ownTx('plant');
    const ids: bigint[] = [];
    for (const s of specs) {
      const reserve = s.isBuy ? this.quoteOf(s.size, s.price) : this.baseOf(s.size);
      const tok = s.isBuy ? this.m.quoteAsset : this.m.baseAsset;
      if ((this.margin.get(tok) ?? 0n) < reserve || s.size <= 0n) continue;
      this.add(this.margin, tok, -reserve);
      const id = this.nextId++;
      this.orders.set(id, { id, isBuy: s.isBuy, price: s.price, flipPrice: s.flipPrice, size: s.size, reserve, child: null });
      this.everCreated.set(id, { isBuy: s.isBuy, price: s.price });
      this.emit(tx, { name: 'FlipOrderCreated', orderId: id, flippedId: 0n, owner: this.account, size: s.size, price: s.price, flippedPrice: s.flipPrice, isBuy: s.isBuy });
      ids.push(id);
    }
    return ids;
  }

  cancel(ids: bigint[]): void {
    const tx = this.ownTx('cancel');
    const done: bigint[] = [];
    for (const id of ids) {
      const o = this.orders.get(id);
      if (!o) continue;
      this.add(this.margin, o.isBuy ? this.m.quoteAsset : this.m.baseAsset, o.reserve);
      this.orders.delete(id);
      done.push(id);
    }
    if (done.length) this.emit(tx, { name: 'FlipOrdersCanceled', orderIds: done, owner: this.account });
  }

  // A taker fills `f` of our resting order in somebody else's transaction (no gas for us).
  takerFill(id: bigint, f: bigint): void {
    const o = this.orders.get(id);
    if (!o || f <= 0n || f > o.size) throw new Error('sim: bad fill');
    this.nextBlock();
    const tx = this.txHash();
    const m = this.m;
    const completes = f === o.size;
    let received: bigint;
    let recvToken: string;
    if (o.isBuy) {
      const pay = completes ? o.reserve : this.quoteOf(f, o.price);
      o.reserve -= pay;
      const b = this.baseOf(f);
      const fee = this.fee(b);
      received = b - fee;
      recvToken = m.baseAsset;
      this.tradedQuote -= pay;
      this.tradedBase += received;
    } else {
      const give = completes ? o.reserve : this.baseOf(f);
      o.reserve -= give;
      const qt = this.quoteOf(f, o.price);
      const fee = this.fee(qt);
      received = qt - fee;
      recvToken = m.quoteAsset;
      this.tradedBase -= give;
      this.tradedQuote += received;
    }
    o.size -= f;

    // The flipped side: opposite direction at the flip price, funded from the proceeds.
    const flipIsBuy = !o.isBuy;
    // Verified rule (fee 0): a bid fill flips out the filled size; an ask fill flips out
    // floor(filled × price / flipPrice). With a fee the proceeds shrink (assumed model).
    let fs = this.m.makerFeeBps === 0n ? (o.isBuy ? f : (f * o.price) / o.flipPrice) : this.maxFlipSize(flipIsBuy, o.flipPrice, f, received);
    let flipReserve = fs === 0n ? 0n : flipIsBuy ? this.quoteOf(fs, o.flipPrice) : this.baseOf(fs);
    while (this.m.makerFeeBps !== 0n && fs > 0n && flipReserve > received) {
      fs -= 1n;
      flipReserve = fs === 0n ? 0n : flipIsBuy ? this.quoteOf(fs, o.flipPrice) : this.baseOf(fs);
    }
    const existing = o.child !== null ? this.orders.get(o.child) : undefined;
    if (fs > 0n && this.partial === 'update-existing' && existing) {
      existing.size += fs;
      existing.reserve += flipReserve;
      this.add(this.margin, recvToken, received - flipReserve);
      this.emit(tx, { name: 'FlipOrderUpdated', orderId: existing.id, size: existing.size });
    } else if (fs > 0n) {
      const nid = this.nextId++;
      this.orders.set(nid, { id: nid, isBuy: flipIsBuy, price: o.flipPrice, flipPrice: o.price, size: fs, reserve: flipReserve, child: null });
      this.everCreated.set(nid, { isBuy: flipIsBuy, price: o.flipPrice });
      o.child = nid;
      this.add(this.margin, recvToken, received - flipReserve);
      // Observed log order: FlippedOrderCreated right before the Trade that caused it.
      // Verified: flippedId is the parent's id after a partial fill, 0 after a full fill.
      this.emit(tx, { name: 'FlippedOrderCreated', orderId: nid, flippedId: completes ? 0n : id, owner: this.account, size: fs, price: o.flipPrice, flippedPrice: o.price, isBuy: flipIsBuy });
    } else {
      this.add(this.margin, recvToken, received);
    }
    const shift = 18n - BigInt(m.pricePrecision.toString().length - 1);
    this.emit(tx, {
      name: 'Trade',
      orderId: id,
      maker: this.account,
      isBuy: !o.isBuy, // the taker's side
      price1e18: o.price * 10n ** shift,
      updatedSize: o.size,
      taker: '0x00000000000000000000000000000000000000bb',
      txOrigin: '0x00000000000000000000000000000000000000cc',
      filledSize: f,
    });
    if (o.size === 0n) {
      if (o.reserve !== 0n) throw new Error('sim: reserve left on a filled order');
      this.orders.delete(id);
    }
  }

  // Largest flipped size ≤ the filled size that the proceeds can fund (assumed model).
  private maxFlipSize(isBuy: boolean, price: bigint, f: bigint, received: bigint): bigint {
    const m = this.m;
    const cap = isBuy
      ? (received * m.sizePrecision * m.pricePrecision) / (price * 10n ** BigInt(m.quoteDecimals))
      : (received * m.sizePrecision) / 10n ** BigInt(m.baseDecimals);
    return cap < f ? cap : f;
  }

  // Truth: what the account holds inside Kuru per token (free + reserves).
  equity(token: string): bigint {
    let s = this.margin.get(token) ?? 0n;
    for (const o of this.orders.values()) if ((o.isBuy ? this.m.quoteAsset : this.m.baseAsset) === token) s += o.reserve;
    return s;
  }

  snapshot(): ChainState {
    const orders: ChainOrder[] = [];
    for (const [id, c] of this.everCreated) {
      const o = this.orders.get(id);
      orders.push({ market: this.m.address, id, size: o ? o.size : 0n, isBuy: c.isBuy, price: c.price });
    }
    const tokens = new Set([this.m.baseAsset, this.m.quoteAsset, this.native]);
    const rec = (map: Map<string, bigint>): Record<string, bigint> => Object.fromEntries([...tokens].map((t) => [t, map.get(t) ?? 0n]));
    return { block: this.block, margin: rec(this.margin), wallet: rec(this.wallet), orders };
  }

  openOrders(): SimOrder[] {
    return [...this.orders.values()];
  }
}
