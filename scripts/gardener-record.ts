// Records real MON-USDC market data for the Gardener replay (read-only: eth_call at past blocks and eth_getLogs only;
// it never signs or sends anything). Usage:
//   node scripts/gardener-record.ts <label> <account|-> <fromBlock> <toBlock> [out.json]
// With "-" as the account no own events are recorded and the replay starts from a fresh bid at the first block.
// Writes the best bid and ask for every block (stored only when they change), every Trade on the market, and the
// account's own flip-order events, so the replay can start from the same garden the owner really planted.
import { writeFileSync } from 'node:fs';
import { JsonRpc } from '../src/rpc.ts';
import { decodeLog, MARKET_TOPICS } from '../src/events.ts';
import { CHAIN } from '../src/plant.ts';
import { eventPriceToOrderPrice } from '../src/units.ts';

const [label, account, fromS, toS, outArg] = process.argv.slice(2);
if (!label || !account || !fromS || !toS) {
  console.error('usage: node scripts/gardener-record.ts <label> <account> <fromBlock> <toBlock> [out.json]');
  process.exit(1);
}
const from = Number(fromS);
const to = Number(toS);
const out = outArg ?? `test/fixtures/gardener-replay-${label}.json`;
const rpc = new JsonRpc(CHAIN.rpcUrl, { retries: 6 });
const market = await rpc.marketParams(CHAIN.market, to);

// Book for every block, a few requests at a time.
const books = new Map<number, { bestBid: bigint; bestAsk: bigint }>();
const blocks = Array.from({ length: to - from + 1 }, (_, i) => from + i);
const CONCURRENCY = 6;
let next = 0;
async function worker(): Promise<void> {
  while (next < blocks.length) {
    const b = blocks[next++];
    books.set(b, await rpc.bestBidAsk(market, b));
    if (books.size % 500 === 0) console.error(`${books.size} / ${blocks.length} blocks`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const book: [number, string, string][] = [];
let last = '';
for (const b of blocks) {
  const x = books.get(b)!;
  const k = `${x.bestBid}:${x.bestAsk}`;
  if (k !== last) book.push([b, x.bestBid.toString(), x.bestAsk.toString()]);
  last = k;
}

// Trades on the market and the account's own flip-order events, in chunks.
const trades: [number, string, boolean, string][] = [];
const own: Record<string, unknown>[] = [];
const acct = account === '-' ? '' : account.toLowerCase();
for (let a = from; a <= to; a += 100) {
  const logs = await rpc.getLogs({ address: CHAIN.market, topics: [MARKET_TOPICS], fromBlock: a, toBlock: Math.min(to, a + 99) });
  for (const l of logs) {
    const e = decodeLog(l);
    if (!e) continue;
    if (e.name === 'Trade') {
      trades.push([e.block, eventPriceToOrderPrice(e.price1e18, market).value.toString(), e.isBuy, e.filledSize.toString()]);
      if (acct && (e.maker === acct || e.txOrigin === acct)) own.push({ name: e.name, block: e.block, tx: e.tx, orderId: e.orderId.toString(), takerIsBuy: e.isBuy, filledSize: e.filledSize.toString(), updatedSize: e.updatedSize.toString() });
    } else if ((e.name === 'FlipOrderCreated' || e.name === 'FlippedOrderCreated') && acct && e.owner === acct) {
      own.push({ name: e.name, block: e.block, tx: e.tx, orderId: e.orderId.toString(), price: e.price.toString(), flippedPrice: e.flippedPrice.toString(), size: e.size.toString(), isBuy: e.isBuy });
    } else if (e.name === 'FlipOrdersCanceled' && acct && e.owner === acct) {
      own.push({ name: e.name, block: e.block, tx: e.tx, orderIds: e.orderIds.map(String) });
    }
  }
}

const json = {
  _comment: `Real Monad mainnet MON-USDC data recorded read-only for the Gardener replay (${label}). book: [block, bestBid, bestAsk] in order-price units (1e8), one row whenever the top of the book changed; trades: [block, price, takerIsBuy, filledSize]; own: the account's flip-order events. Public chain data only.`,
  label,
  account,
  fromBlock: from,
  toBlock: to,
  market: { address: market.address, pricePrecision: market.pricePrecision.toString(), sizePrecision: market.sizePrecision.toString(), tickSize: market.tickSize.toString(), minSize: market.minSize.toString(), maxSize: market.maxSize.toString(), baseDecimals: market.baseDecimals, quoteDecimals: market.quoteDecimals, baseAsset: market.baseAsset, quoteAsset: market.quoteAsset, makerFeeBps: market.makerFeeBps.toString(), takerFeeBps: market.takerFeeBps.toString() },
  book,
  trades,
  own,
};
writeFileSync(out, JSON.stringify(json) + '\n');
console.error(`wrote ${out}: ${book.length} book rows, ${trades.length} trades, ${own.length} own events`);
