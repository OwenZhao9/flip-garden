// Raw chain data -> what the page shows. Pure functions, no I/O, no floating point:
// every number is a BigInt and is formatted with fixed-point string maths.
// The ledger core (../../src) does the accounting; this file only decides how to present it.
import { decodeLog, type KuruEvent, type RawLog } from '../../src/events.ts';
import { buildLedger, orderKey, type Issue, type Ledger, type Order, type OwnTx } from '../../src/ledger.ts';
import { marketPnl, accountView, type Book } from '../../src/pnl.ts';
import { reconcile, type ChainState } from '../../src/reconcile.ts';
import { add, floor, mul, q, type Q } from '../../src/rational.ts';
import { NATIVE, baseForSize, formatUnits, log10Exact, priceRaw, type Market } from '../../src/units.ts';

// Everything the data layer fetched, in its final typed form.
export type Bundle = {
  account: string;
  market: Market;
  symbols: { base: string; quote: string };
  marginAccount: string;
  startBlock: number;
  endBlock: number; // last block included
  logs: RawLog[];
  txs: OwnTx[];
  chain: ChainState; // read at endBlock (margin, orders, wallet)
  book: Book | null; // best bid / ask at endBlock
};

export type BadgeStatus = 'empty' | 'match' | 'unexplained' | 'mismatch';

export type CheckRow = { label: string; ledger: string; chain: string; diff: string; ok: boolean };
export type IssueRow = { severity: Issue['severity']; text: string; where: string };
export type BalanceRow = { symbol: string; wallet: string; free: string; locked: string; equity: string; approx: boolean };
export type OrderRow = {
  id: string;
  depth: number; // 0 = the order you planted; 1+ = flipped out of its parent
  side: string;
  price: string;
  flipPrice: string;
  size: string;
  filled: string;
  status: 'open' | 'filled' | 'cancelled';
  statusLabel: string;
  origin: string;
  blocks: string;
};
export type FillRow = {
  block: number;
  side: 'buy' | 'sell';
  sideLabel: string;
  price: string;
  base: string;
  quote: string;
  fee: string;
  orderId: string;
  flippedTo: string;
  takerContract: string;
  initiator: string;
  tx: string;
  txShort: string;
};
export type Tile = { price: string; side: string; state: 'planted' | 'harvested' | 'pruned'; label: string; orderId: string };

export type View = {
  account: string;
  market: string;
  range: { start: number; end: number };
  status: BadgeStatus;
  headline: string;
  detail: string;
  checks: CheckRow[];
  issues: IssueRow[];
  balances: BalanceRow[];
  netWorth: string | null; // in quote token, at mid
  markNote: string;
  orders: OrderRow[];
  tiles: Tile[];
  fills: FillRow[];
  money: {
    quoteChange: string; // Σ fill quote flows net of fees
    baseChange: string;
    gas: string;
    fees: string;
    realized: string;
    cycles: number;
    unrealizedMid: string;
    unrealizedExecutable: string;
    executableNote: string;
    totalMid: string;
    growth: string;
    growthNote: string;
    baseShare: string;
    imbalance: string;
  };
};

const EXPLORER = 'https://monadscan.com';
export const txUrl = (hash: string): string => `${EXPLORER}/tx/${hash}`;
export const addressUrl = (a: string): string => `${EXPLORER}/address/${a}`;

export const short = (s: string): string => (s.length > 14 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s);

// Signed fixed-point with an explicit "+" for gains; `cut` truncates toward zero for display.
export function fmt(value: bigint, decimals: number, cut?: number): string {
  return formatUnits(value, decimals, cut);
}
const signed = (value: bigint, decimals: number, cut?: number): string => (value > 0n ? '+' : '') + fmt(value, decimals, cut);

// Rational -> string at a token's decimals, rounded toward negative infinity once (a gain is never overstated).
function qFmt(x: Q | null, decimals: number, cut?: number): string {
  if (x === null) return 'n/a';
  return signed(floor(x), decimals, cut);
}

const bpsPercent = (bps: bigint): string => `${bps > 0n ? '+' : ''}${formatUnits(bps, 2)}%`;

const CAUSES: Record<string, string> = {
  'scan-range-too-short': 'The start block may be too late: the wallet had orders or balances before it. Try an earlier start block.',
  'missing-event': 'Some Kuru event for this wallet may be missing from the scanned range.',
  'other-market-same-token': 'Another Kuru market using the same token may also be moving this balance.',
  'trade-side-reversed': 'The buy/sell direction of fills looks reversed.',
  'fee-model-unverified': 'This market charges a fee; how Kuru takes it is not verified yet.',
  'free-locked-split': 'Free versus locked margin is split differently than the ledger expects.',
  'partial-fill-semantics': 'A partially filled order does not match what the chain says.',
};

const CHECK_LABEL: Record<string, string> = {
  ORDER_SIZE: 'Order size left',
  EQUITY: 'Kuru balance (free + locked)',
  FREE: 'Free margin',
  WALLET: 'Wallet + Kuru',
};

export function buildView(b: Bundle): View {
  const m = b.market;
  const events = b.logs.map((l) => decodeLog(l)).filter((e): e is KuruEvent => e !== null);
  const ledger = buildLedger({ account: b.account, markets: [m], events, txs: b.txs, untilBlock: b.endBlock });
  const report = reconcile(ledger, b.chain);
  const pnl = marketPnl(ledger, m.address, b.book ?? undefined);
  const acct = accountView(ledger, m.address, b.book ?? undefined);

  const baseDec = m.baseDecimals;
  const quoteDec = m.quoteDecimals;
  const priceDec = log10Exact(m.pricePrecision);
  const symOf = (token: string): string => (token === m.baseAsset ? b.symbols.base : token === m.quoteAsset ? b.symbols.quote : short(token));
  const decOf = (token: string): number => (token === m.baseAsset ? baseDec : quoteDec);
  const cutOf = (token: string): number | undefined => (decOf(token) > 6 ? 6 : undefined);
  const amount = (token: string, v: bigint): string => fmt(v, decOf(token), cutOf(token));
  const sizeToBase = (size: bigint): string => fmt(baseForSize(size, m, 'down').value, baseDec, 6);
  const priceStr = (p: bigint | null): string => (p === null ? '?' : fmt(p, priceDec));

  // --- reconciliation -------------------------------------------------------------------
  const checks: CheckRow[] = report.diffs.map((d) => {
    const dec = d.token ? decOf(d.token) : 0;
    const f = (v: bigint): string => (d.token ? `${amount(d.token, v)} ${symOf(d.token)}` : String(v));
    const tail = d.token ? ` ${symOf(d.token)}` : '';
    return {
      label: d.check === 'ORDER_SIZE' ? `${CHECK_LABEL[d.check]} #${d.orderId}` : `${CHECK_LABEL[d.check]}${tail ? ' · ' + symOf(d.token!) : ''}`,
      ledger: f(d.expected),
      chain: f(d.actual),
      diff: d.token ? `${signed(d.diff, dec, cutOf(d.token))}${tail}` : String(d.diff),
      ok: d.ok,
    };
  });
  const issues: IssueRow[] = ledger.issues.map((i) => ({
    severity: i.severity,
    text: i.en,
    where: i.tx ? short(i.tx) : '',
  }));

  const noActivity = ledger.orders.size === 0 && ledger.fills.length === 0 && ledger.flows.length === 0;
  let status: BadgeStatus;
  let headline: string;
  let detail: string;
  if (noActivity) {
    status = 'empty';
    headline = 'No Kuru activity found';
    detail = `This wallet has no Kuru flip orders or margin deposits between blocks ${b.startBlock} and ${b.endBlock}. Try an earlier start block.`;
  } else if (!report.ok) {
    status = 'mismatch';
    headline = 'Does not match the chain';
    const bad = report.diffs.filter((d) => !d.ok);
    const hints = [...new Set(bad.flatMap((d) => d.hints))].map((h) => CAUSES[h]).filter(Boolean);
    detail = [
      bad.length > 0 ? `${bad.length} of ${report.diffs.length} checks differ from what Kuru reports on-chain.` : 'The ledger found events that contradict each other.',
      ...hints,
    ].join(' ');
  } else if (report.unknowns.length > 0) {
    status = 'unexplained';
    headline = 'Matches, but part of the history cannot be fully explained';
    detail = `All ${report.diffs.length} balance checks agree with the chain, but ${report.unknowns.length} event pattern(s) have behavior we have not verified on-chain. Numbers that depend on them are marked below.`;
  } else {
    status = 'match';
    headline = 'Matches the chain';
    const exact = report.diffs.every((d) => d.diff === 0n);
    detail =
      exact
        ? `All ${report.diffs.length} checks agree with the chain to the last raw unit (difference 0) at block ${report.block}.`
        : `All ${report.diffs.length} checks agree with the chain within the ledger's own rounding allowance at block ${report.block}.`;
  }

  // --- balances ------------------------------------------------------------------------
  const tokens = [m.quoteAsset, m.baseAsset];
  const balances: BalanceRow[] = tokens.map((t) => {
    const bal = ledger.balances.get(t);
    const wallet = b.chain.wallet?.[t];
    return {
      symbol: symOf(t),
      wallet: wallet === undefined ? 'n/a' : amount(t, wallet),
      free: amount(t, bal?.free ?? 0n),
      locked: amount(t, bal?.locked ?? 0n),
      equity: amount(t, bal?.equity ?? 0n),
      approx: bal?.lockedUncertain ?? false,
    };
  });

  const book = b.book;
  const mid: Q | null = book && book.bestBid > 0n && book.bestAsk > book.bestBid ? priceRaw(q(book.bestBid + book.bestAsk, 2n), m) : null;
  let netWorth: string | null = null;
  if (mid && b.chain.wallet) {
    const own = (t: string): bigint => (b.chain.wallet?.[t] ?? 0n) + (ledger.balances.get(t)?.equity ?? 0n);
    const total = add(q(own(m.quoteAsset)), mul(q(own(m.baseAsset)), mid));
    netWorth = `${fmt(floor(total), quoteDec)} ${b.symbols.quote}`;
  }
  const markNote = book
    ? `Prices at block ${b.endBlock}: best bid ${priceStr(book.bestBid)}, best ask ${priceStr(book.bestAsk)} ${b.symbols.quote} per ${b.symbols.base}. Mid = average of the two.`
    : `No order book was readable at block ${b.endBlock}, so values at market price are not shown.`;

  // --- orders and flip chains ------------------------------------------------------------
  const all = [...ledger.orders.values()];
  const byKey = new Map(all.map((o) => [orderKey(o.market, o.id), o]));
  const roots = all.filter((o) => !o.parent).sort(byAge);
  const rows: OrderRow[] = [];
  const visited = new Set<string>();
  const visit = (o: Order, depth: number): void => {
    const k = orderKey(o.market, o.id);
    if (visited.has(k)) return;
    visited.add(k);
    rows.push(orderRow(o, depth));
    for (const c of o.children) {
      const child = byKey.get(orderKey(o.market, c));
      if (child) visit(child, depth + 1);
    }
  };
  for (const r of roots) visit(r, 0);
  for (const o of all.sort(byAge)) visit(o, 0); // orphans with a parent we never saw

  function orderRow(o: Order, depth: number): OrderRow {
    const status = o.status;
    return {
      id: String(o.id),
      depth,
      side: o.isBuy === null ? '?' : o.isBuy ? 'Buy' : 'Sell',
      price: priceStr(o.price),
      flipPrice: priceStr(o.flipPrice),
      size: o.initialSize === null ? '?' : sizeToBase(o.initialSize),
      filled: sizeToBase(o.filled),
      status,
      statusLabel: status === 'open' ? 'Resting' : status === 'filled' ? 'Filled' : 'Cancelled',
      origin:
        o.origin === 'flipped' && o.parent
          ? `Flipped out of #${o.parent.orderId}`
          : o.origin === 'placed'
            ? 'Planted by you'
            : o.origin === 'unseen'
              ? 'Created before the scanned range'
              : 'Already open at the start',
      blocks: `${o.createdBlock ?? '?'} → ${o.closedBlock ?? 'still open'}`,
    };
  }

  const tiles: Tile[] = rows.map((r) => {
    const state: Tile['state'] = r.status === 'open' ? 'planted' : r.status === 'filled' ? 'harvested' : 'pruned';
    return {
      price: r.price,
      side: r.side,
      state,
      label: state === 'planted' ? 'Planted' : state === 'harvested' ? 'Harvested' : 'Pruned',
      orderId: r.id,
    };
  });

  // --- fills ---------------------------------------------------------------------------
  const fills: FillRow[] = ledger.fills.map((f) => ({
    block: f.block,
    side: f.side,
    sideLabel: f.side === 'buy' ? 'Bought' : 'Sold',
    price: fmt(f.price, priceDec),
    base: fmt(f.base.value, baseDec, 6),
    quote: fmt(f.quote.value, quoteDec),
    fee: f.fee.amount.value === 0n ? '0' : `${amount(f.fee.token, f.fee.amount.value)} ${symOf(f.fee.token)}`,
    orderId: String(f.orderId),
    flippedTo: f.flippedTo.length ? f.flippedTo.map((id) => `#${id}`).join(', ') : '—',
    takerContract: f.taker,
    initiator: f.txOrigin,
    tx: f.tx,
    txShort: short(f.tx),
  }));

  // --- profit and loss -----------------------------------------------------------------
  const feeParts: string[] = [];
  if (pnl.fees.quote !== 0n) feeParts.push(`${fmt(pnl.fees.quote, quoteDec)} ${b.symbols.quote}`);
  if (pnl.fees.base !== 0n) feeParts.push(`${fmt(pnl.fees.base, baseDec, 6)} ${b.symbols.base}`);
  const gasToken = NATIVE === m.baseAsset ? b.symbols.base : 'MON';
  const growth = acct.growth;

  const money: View['money'] = {
    quoteChange: `${signed(pnl.flows.quote, quoteDec)} ${b.symbols.quote}`,
    baseChange: `${signed(pnl.flows.base, baseDec, 6)} ${b.symbols.base}`,
    gas: `${fmt(ledger.gas.totalWei, 18, 6)} ${gasToken}`,
    fees: feeParts.length ? feeParts.join(' + ') : '0',
    realized: `${qFmt(pnl.realized, quoteDec)} ${b.symbols.quote}`,
    cycles: pnl.cycles.length,
    unrealizedMid: pnl.unrealized.mid.value ? `${qFmt(pnl.unrealized.mid.value, quoteDec)} ${b.symbols.quote}` : 'n/a',
    unrealizedExecutable: pnl.unrealized.executable.value ? `${qFmt(pnl.unrealized.executable.value, quoteDec)} ${b.symbols.quote}` : 'n/a',
    executableNote: pnl.unrealized.executable.note,
    totalMid: pnl.total.mid ? `${qFmt(pnl.total.mid, quoteDec)} ${b.symbols.quote}` : 'n/a',
    growth: growth.growthBps === null ? 'n/a' : bpsPercent(growth.growthBps),
    growthNote:
      growth.netQuoteEquivMid && growth.capitalQuoteEquivMid
        ? `Net result at mid, after gas: ${qFmt(growth.netQuoteEquivMid, quoteDec)} ${b.symbols.quote}, on capital of ${fmt(floor(growth.capitalQuoteEquivMid), quoteDec)} ${b.symbols.quote}.`
        : 'Needs a readable order book and at least one deposit.',
    baseShare: acct.inventory.baseShareBps === null ? 'Nothing held in Kuru' : `${formatUnits(acct.inventory.baseShareBps, 2)}%`,
    imbalance: acct.inventory.imbalanceBps === null ? 'Nothing held in Kuru' : bpsPercent(acct.inventory.imbalanceBps),
  };

  return {
    account: b.account,
    market: `${b.symbols.base}-${b.symbols.quote}`,
    range: { start: b.startBlock, end: b.endBlock },
    status,
    headline,
    detail,
    checks,
    issues,
    balances,
    netWorth,
    markNote,
    orders: rows,
    tiles,
    fills,
    money,
  };
}

function byAge(a: Order, b: Order): number {
  const x = a.createdBlock ?? 0;
  const y = b.createdBlock ?? 0;
  return x - y || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

// Plain-language text for failures of the data layer (public node limits, bad input, offline).
export function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/abort/i.test(msg)) return 'Cancelled.';
  if (/limited to a \d+ range|range/i.test(msg)) return 'The public node refused the block range. This is a bug in the page: please report it.';
  if (/429|rate|too many|limit/i.test(msg)) return 'The public Monad node is rate-limiting this browser. Wait a minute and press the button again; blocks already read are kept and will not be fetched twice.';
  if (/failed to fetch|networkerror|load failed|fetch/i.test(msg)) return 'Could not reach the public Monad node (rpc.monad.xyz). Check your internet connection and try again; blocks already read are kept.';
  return `Something went wrong while reading the chain: ${msg}`;
}
