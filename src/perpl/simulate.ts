// Read-only Perpl simulations on Monad mainnet. Usage: node src/perpl/simulate.ts [--json]
// Sends nothing, uses no key: eth_call and debug_traceCall with state overrides from a throwaway
// address (random each run). The output is what docs/PERPL-ONCHAIN.md quotes.
import fs from 'node:fs';
import path from 'node:path';
import { JsonRpc } from '../rpc.ts';
import { keccak256 } from '../keccak.ts';
import { PerplReader } from './state.ts';
import { ErrorBook, simOverrides, simulate, simulateTrace } from './sim.ts';
import { cancelOrder, changeOrder, closeShort, encodeCreateAccount, encodeExecOrders, encodeWithdrawCollateral, openLong, openShort } from './encode.ts';

const root = path.join(import.meta.dirname, '..', '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config', 'perpl.mainnet.json'), 'utf8'));
// The token's own errors (OpenZeppelin ERC-20 custom errors) are named too: AUSD reverts with them.
const errBook = new ErrorBook([
  ...JSON.parse(fs.readFileSync(path.join(root, 'config', 'perpl.errors.json'), 'utf8')).errors,
  'ERC20InsufficientAllowance(address,uint256,uint256)',
  'ERC20InsufficientBalance(address,uint256,uint256)',
]);
const asJson = process.argv.includes('--json');

const rpc = new JsonRpc(process.env.MONAD_RPC_URL ?? cfg.rpcUrl, { retries: 0 });
const reader = new PerplReader(rpc, cfg.exchange);
const market = cfg.markets[cfg.defaultMarket];

const randomAddress = (): string => {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return '0x' + keccak256(b).slice(26);
};

type Row = { label: string; expect: 'ok' | 'revert'; result: string; pass: boolean; gas?: string };
const rows: Row[] = [];
const say = (s = ''): void => {
  if (!asJson) console.log(s);
};

async function main(): Promise<void> {
  // Every read and every simulation uses this one block, so the book cannot move between steps (a resting
  // order id or a marketable price read at one block would otherwise be stale at the next).
  const block = Number(BigInt(await rpc.call<string>('eth_blockNumber', []))) - 2;
  const tag = '0x' + block.toString(16);
  const version = await reader.contractVersion(block);
  const minOpen = await reader.minAccountOpenCNS(block);
  const perp = await reader.perpetual(market.perpId, block);
  const base = perp.basePricePNS;
  const bestBid = perp.maxBidPriceONS + base;
  const bestAsk = perp.minAskPriceONS + base;
  say(`Simulations at block ${block} (${new Date().toISOString()})`);
  say(`Exchange ${cfg.exchange}, contract v${version.join('.')}, minimum to open an account ${minOpen} CNS`);
  say(`${market.name}: best bid ${bestBid}, best ask ${bestAsk} (10^-${perp.priceDecimals} AUSD), lot decimals ${perp.lotDecimals}, status ${perp.status}`);
  say('');

  const sender = randomAddress();
  const ov = (ausd: bigint, allowance = true) => {
    const o = simOverrides({ exchange: cfg.exchange, ausd: cfg.ausd, sender, ausdAmount: ausd, nativeWei: 10n ** 20n });
    if (!allowance) {
      const sd = o[cfg.ausd.address].stateDiff as Record<string, string>;
      delete sd[Object.keys(sd)[1]];
    }
    return o;
  };
  const funds = minOpen * 100n; // 1000 AUSD, only a number inside the simulation
  const create = encodeCreateAccount(minOpen);
  const perpId = BigInt(market.perpId);
  const lev = 500n;
  const run = async (label: string, expect: 'ok' | 'revert', calls: string[], overrides = ov(funds), want?: string): Promise<void> => {
    const r = await simulate(rpc, { sender, exchange: cfg.exchange, calls, overrides, block: tag }, errBook);
    let result: string;
    let pass: boolean;
    if (r.ok) {
      result = 'ok';
      pass = expect === 'ok';
    } else {
      result = `revert ${r.revert.name ?? r.revert.data.slice(0, 10)}${r.revert.words ? '(' + r.revert.words.join(',') + ')' : ''}`;
      pass = expect === 'revert' && (want === undefined || r.revert.name === want);
    }
    rows.push({ label, expect, result, pass });
    say(`${pass ? 'PASS' : 'FAIL'}  ${label}  ->  ${result}`);
  };

  // --- account creation
  await run('createAccount with the minimum deposit (10 AUSD)', 'ok', [create]);
  await run('control: createAccount 1 unit below the minimum', 'revert', [encodeCreateAccount(minOpen - 1n)], undefined, 'InsufficentAmountToOpenAccount');
  await run('control: createAccount without any AUSD', 'revert', [create], ov(0n));
  await run('control: createAccount without allowance', 'revert', [create], ov(funds, false));

  // --- orders
  const lot = 1000n;
  const rest = openShort({ perpId, pricePNS: (bestAsk * 103n) / 100n, lotLNS: lot, leverageHdths: lev, postOnly: true });
  const post = encodeExecOrders([rest], true);
  await run('OpenShort 1000 MON resting post-only, 3% above the best ask (account created first)', 'ok', [create, post]);
  await run('control: OpenShort with no account', 'revert', [post], ov(funds), 'AccountDoesNotExist');
  await run('control: post-only OpenShort that crosses the book', 'revert', [create, encodeExecOrders([openShort({ perpId, pricePNS: bestBid - 50n, lotLNS: lot, leverageHdths: lev, postOnly: true })], true)], ov(funds), 'CrossesBook');
  await run('control: OpenShort price far outside the exchange limits', 'revert', [create, encodeExecOrders([openShort({ perpId, pricePNS: bestAsk * 3n, lotLNS: lot, leverageHdths: lev, postOnly: true })], true)], ov(funds), 'CantPostOrder');
  await run('control: OpenShort needing more margin than the account has (5,000,000 MON)', 'revert', [create, encodeExecOrders([openShort({ perpId, pricePNS: (bestAsk * 103n) / 100n, lotLNS: 5_000_000n, leverageHdths: lev, postOnly: true })], true)], ov(funds), 'CantPostOrder');
  await run('OpenLong 1000 MON resting post-only, 3% below the best bid', 'ok', [create, encodeExecOrders([openLong({ perpId, pricePNS: (bestBid * 97n) / 100n, lotLNS: lot, leverageHdths: lev, postOnly: true })], true)]);

  // --- resting order lifecycle: place, then cancel and change it
  const placed = await simulateTrace(rpc, { sender, calls: [create, post], overrides: ov(funds), block: tag });
  const placedEv = placed.events.find((e) => e.name === 'OrderPlaced');
  if (placedEv) {
    const orderId = placedEv.fields.orderId as bigint;
    const cancel = cancelOrder({ perpId, orderId, pricePNS: rest.pricePNS, lotLNS: lot });
    await run(`cancel the resting order (id ${orderId}) in the same simulation`, 'ok', [create, post, encodeExecOrders([cancel], true)]);
    const change = changeOrder({ perpId, orderId, pricePNS: (bestAsk * 104n) / 100n, lotLNS: lot, leverageHdths: lev });
    await run(`change the resting order (id ${orderId}): move the price 1% up`, 'ok', [create, post, encodeExecOrders([change], true)]);
  } else say('SKIP  cancel/change: no OrderPlaced event in the trace');

  // --- the hedge itself: a marketable short (IOC at the best bid) and its unwind
  const hedgeLot = 100n;
  const hedge = openShort({ perpId, pricePNS: bestBid, lotLNS: hedgeLot, leverageHdths: lev, immediateOrCancel: true });
  const hedgeCall = encodeExecOrders([hedge], true);
  await run('hedge: OpenShort 100 MON, IOC at the best bid (fills immediately)', 'ok', [create, hedgeCall]);
  const unwind = encodeExecOrders([closeShort({ perpId, pricePNS: (bestAsk * 102n) / 100n, lotLNS: hedgeLot, leverageHdths: lev, immediateOrCancel: true })], true);
  await run('unwind: CloseShort 100 MON, IOC up to 2% above the best ask, after the hedge', 'ok', [create, hedgeCall, unwind]);
  await run('control: CloseShort with no position', 'revert', [create, unwind]);

  // --- withdraw
  await run('withdraw 5 AUSD of the 10 AUSD deposit', 'ok', [create, encodeWithdrawCollateral(5_000_000n)]);
  await run('control: withdraw more than the balance (11 AUSD)', 'revert', [create, encodeWithdrawCollateral(11_000_000n)]);

  // --- events and gas of the hedge, for the record
  const tr = await simulateTrace(rpc, { sender, calls: [create, hedgeCall, unwind], overrides: ov(funds), block: tag });
  say('');
  say('Events of create + hedge + unwind:');
  for (const e of tr.events) say(`  ${e.name} ${JSON.stringify(e.fields, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
  say(`Gas used per forwarded call (EVM-executed; Monad bills the limit): ${tr.gasUsed.join(', ')}`);

  const failed = rows.filter((r) => !r.pass);
  say('');
  say(`${rows.length - failed.length}/${rows.length} as expected`);
  if (asJson) console.log(JSON.stringify({ block, version: version.map(String), rows, events: tr.events.map((e) => ({ name: e.name, fields: JSON.parse(JSON.stringify(e.fields, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))) })), gasUsed: tr.gasUsed.map(String) }, null, 2));
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 2;
});
