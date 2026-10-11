#!/usr/bin/env node
'use strict';
/**
 * Flip Garden: gate test CLI (stage A).
 *
 * Goal: prove, with a few real dollars on Monad mainnet, that the loop
 *   plant (flip bid) -> fill -> flipped ask -> ledger -> cancel -> withdraw
 * is readable from chain state and that our computed numbers reconcile with
 * on-chain balances.
 *
 * Safety rails
 *   - Nothing is sent unless the command carries --live AND you type YES.
 *   - The private key is read only from the PRIVATE_KEY env var and never printed or stored.
 *   - Hard caps live in config/kuru.mainnet.json (deposit, order count, notional).
 *   - The market is verified on-chain (MarginAccount.verifiedMarket, token addresses) before any tx.
 *   - plant simulates the exact transaction first and refuses if any order would be skipped.
 *
 * Commands: preflight | deposit | plant | status | unwind | report | help
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { ethers } = require('ethers');
const KuruSdk = require('@kuru-labs/kuru-sdk');
const u = require('../lib/units.cjs');
const { reconcile, makerBuys } = require('../lib/reconcile.cjs');
const cfg = require('../config/kuru.mainnet.json');

// ---------------------------------------------------------------- constants

const ROOT = path.join(__dirname, '..');
const STATE_DIR = process.env.FLIPGARDEN_STATE_DIR || path.join(ROOT, 'state');
const LOG_FILE = path.join(STATE_DIR, 'gate-log.jsonl');
const ORDERS_FILE = path.join(STATE_DIR, 'orders.json');
const SCAN_FILE = path.join(STATE_DIR, 'scan.json');
const EVENTS_FILE = path.join(STATE_DIR, 'events.jsonl');
const BASELINE_FILE = path.join(STATE_DIR, 'baseline.json');

const ZERO = ethers.constants.AddressZero;
const USDC = cfg.tokens.USDC.address;
const MARGIN = cfg.marginAccount;

function loadAbi(name) {
  let json;
  try {
    json = require(`@kuru-labs/kuru-sdk/abi/${name}.json`);
  } catch (_) {
    const main = require.resolve('@kuru-labs/kuru-sdk');
    json = JSON.parse(fs.readFileSync(path.resolve(path.dirname(main), '..', 'abi', `${name}.json`), 'utf8'));
  }
  return Array.isArray(json) ? json : json.abi;
}
const OB_ABI = loadAbi('OrderBook');
const MA_ABI = loadAbi('MarginAccount');
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
];
const obIface = new ethers.utils.Interface(OB_ABI);
const EVENT_NAMES = ['Trade', 'FlipOrderCreated', 'FlippedOrderCreated', 'FlipOrderUpdated', 'FlipOrdersCanceled'];
const TOPICS = EVENT_NAMES.map((n) => obIface.getEventTopic(n));

let MARKET_NAME = cfg.defaultMarket;
let MARKET = cfg.markets[MARKET_NAME];

// ---------------------------------------------------------------- tiny helpers

const say = (s = '') => console.log(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toBig = (x) => BigInt(x.toString());
const lc = (s) => String(s).toLowerCase();
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const errMsg = (e) => String((e && (e.reason || e.message)) || e).slice(0, 300);

function die(msg, code = 1) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

function jsonSafe(v) {
  return JSON.parse(JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x)));
}
function ensureState() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}
function writeJson(file, obj) {
  ensureState();
  fs.writeFileSync(file, JSON.stringify(jsonSafe(obj), null, 2));
}
function appendLog(entry) {
  ensureState();
  fs.appendFileSync(LOG_FILE, JSON.stringify(jsonSafe({ ts: new Date().toISOString(), market: MARKET, ...entry })) + '\n');
}

async function retry(fn, tries = 6, baseMs = 500) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await sleep(baseMs * 2 ** i);
    }
  }
  throw last;
}

async function confirm(prompt, args) {
  if (args.yes) return true;
  if (!process.stdin.isTTY) die('Confirmation needs an interactive terminal; run this directly in a terminal, or pass --yes explicitly.');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = await new Promise((res) => rl.question(`${prompt}\nType YES to continue; anything else cancels: `, res));
  rl.close();
  return ans.trim() === 'YES';
}

// ---------------------------------------------------------------- chain access

function makeProvider() {
  const url = process.env.MONAD_RPC_URL || cfg.rpcUrl;
  return new ethers.providers.StaticJsonRpcProvider({ url, timeout: 20000 }, { chainId: cfg.chainId, name: 'monad' });
}

async function ensureChain(provider) {
  const id = parseInt(await retry(() => provider.send('eth_chainId', [])), 16);
  if (id !== cfg.chainId) die(`RPC returned chainId=${id}, expected ${cfg.chainId} (Monad mainnet). Refusing to continue.`);
}

function loadSigner(provider) {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) die('PRIVATE_KEY has the wrong format (expected 0x followed by 64 hex characters).');
  return new ethers.Wallet(pk, provider);
}

// Dry runs only need an address (ADDRESS env); the private key is needed only for --live.
async function context({ needSigner = false, needAddr = false } = {}) {
  const provider = makeProvider();
  await ensureChain(provider);
  const signer = loadSigner(provider);
  if (needSigner && !signer) {
    die('--live needs a private key: set the PRIVATE_KEY environment variable in your terminal first (see the runbook; use read -rs and never write it to a file).');
  }
  const envAddr = process.env.ADDRESS || null;
  if (envAddr && !ethers.utils.isAddress(envAddr)) die('ADDRESS is not a valid address.');
  if (signer && envAddr && lc(envAddr) !== lc(signer.address)) die('ADDRESS does not match the address of PRIVATE_KEY; set only one of them.');
  const addr = signer ? signer.address : envAddr;
  if (needAddr && !addr) die('Set ADDRESS (your wallet address, for dry runs) or PRIVATE_KEY (for --live).');
  return { provider, signer, addr };
}

const mkMarket = (p) => new ethers.Contract(MARKET, OB_ABI, p);
const mkMargin = (p) => new ethers.Contract(MARGIN, MA_ABI, p);
const mkUsdc = (p) => new ethers.Contract(USDC, ERC20_ABI, p);

async function readMarketParams(provider) {
  const r = await retry(() => mkMarket(provider).getMarketParams());
  return {
    pricePrecision: toBig(r[0]),
    sizePrecision: toBig(r[1]),
    baseAsset: r[2],
    baseDecimals: Number(r[3].toString()),
    quoteAsset: r[4],
    quoteDecimals: Number(r[5].toString()),
    tickSize: toBig(r[6]),
    minSize: toBig(r[7]),
    maxSize: toBig(r[8]),
    takerFeeBps: toBig(r[9]),
    makerFeeBps: toBig(r[10]),
  };
}

async function readBook(provider, mp) {
  const r = await retry(() => mkMarket(provider).bestBidAsk());
  const bid1e18 = toBig(r[0]);
  const ask1e18 = toBig(r[1]);
  return {
    bid: u.eventPriceToRaw(bid1e18, mp.pricePrecision),
    ask: u.eventPriceToRaw(ask1e18, mp.pricePrecision),
  };
}

async function readBalances(provider, addr) {
  const ma = mkMargin(provider);
  const [walletMon, walletUsdc, marginUsdc, marginMon] = await Promise.all([
    retry(() => provider.getBalance(addr)),
    retry(() => mkUsdc(provider).balanceOf(addr)),
    retry(() => ma.getBalance(addr, USDC)),
    retry(() => ma.getBalance(addr, ZERO)),
  ]);
  return {
    walletMon: toBig(walletMon),
    walletUsdc: toBig(walletUsdc),
    marginUsdc: toBig(marginUsdc),
    marginMon: toBig(marginMon),
  };
}

async function readOrder(provider, id) {
  const o = await retry(() => mkMarket(provider).s_orders(id));
  return {
    id: Number(id),
    owner: o.ownerAddress,
    size: toBig(o.size),
    flippedId: Number(o.flippedId),
    price: toBig(o.price),
    flippedPrice: toBig(o.flippedPrice),
    isBuy: o.isBuy,
  };
}
const isLive = (o) => o.owner !== ZERO && o.size > 0n;

function lockedFromOrders(orders, mp) {
  let quote = 0n;
  let base = 0n;
  for (const o of orders) {
    if (!isLive(o)) continue;
    if (o.isBuy) quote += u.quoteForSize(o.size, o.price, mp, true);
    else base += u.baseForSize(o.size, mp);
  }
  return { quote, base };
}

function fmtFactory(mp) {
  const pd = u.log10Exact(mp.pricePrecision);
  const sd = u.log10Exact(mp.sizePrecision);
  return {
    usdc: (x) => u.formatUnits(x, mp.quoteDecimals),
    mon: (x) => u.formatUnits(x, mp.baseDecimals, 6),
    size: (x) => u.formatUnits(x, sd),
    price: (x) => u.formatUnits(x, pd),
  };
}

async function verifyMarket(provider) {
  const verified = await retry(() => mkMargin(provider).verifiedMarket(MARKET));
  const mp = await readMarketParams(provider);
  const checks = [
    [verified === true, `MarginAccount recognises this market (verifiedMarket=${verified})`],
    [lc(mp.quoteAsset) === lc(USDC), `Quote asset is USDC (${mp.quoteAsset})`],
    [mp.baseAsset === ZERO, `Base asset is native MON (${mp.baseAsset})`],
    [mp.quoteDecimals === 6 && mp.baseDecimals === 18, `Decimals: USDC=${mp.quoteDecimals}, MON=${mp.baseDecimals}`],
  ];
  return { ok: checks.every((c) => c[0]), checks, mp };
}

// ---------------------------------------------------------------- simulation

function marginSlot(owner, token) {
  const key = ethers.utils.keccak256(ethers.utils.solidityPack(['address', 'address'], [owner, token]));
  const one = ethers.utils.hexZeroPad('0x01', 32);
  return ethers.utils.keccak256(ethers.utils.concat([key, one]));
}

function decodeRevert(e) {
  const cands = [];
  const push = (x) => {
    if (typeof x === 'string' && x.startsWith('0x') && x.length >= 10) cands.push(x);
  };
  const walk = (o, d = 0) => {
    if (!o || typeof o !== 'object' || d > 4) return;
    push(o.data);
    if (o.data && typeof o.data === 'object') walk(o.data, d + 1);
    if (o.error) walk(o.error, d + 1);
  };
  walk(e);
  if (e && typeof e.body === 'string') {
    try {
      const b = JSON.parse(e.body);
      walk(b.error, 1);
    } catch (_) {
      /* ignore */
    }
  }
  for (const d of cands) {
    try {
      return obIface.parseError(d).name;
    } catch (_) {
      /* try next */
    }
  }
  return errMsg(e);
}

async function simulateProvision(provider, from, bids, provisionOrRevert, overrides) {
  const data = obIface.encodeFunctionData('batchProvisionLiquidity', [
    bids.map((b) => b.price),
    bids.map((b) => b.flipPrice),
    bids.map((b) => b.liquidity),
    bids.map(() => true),
    provisionOrRevert,
  ]);
  const tx = { from, to: MARKET, data };
  try {
    await (overrides ? provider.send('eth_call', [tx, 'latest', overrides]) : provider.send('eth_call', [tx, 'latest']));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: decodeRevert(e) };
  }
}

// ---------------------------------------------------------------- state files

const loadRegistry = () => readJson(ORDERS_FILE, { market: MARKET, orders: {} });
const saveRegistry = (r) => writeJson(ORDERS_FILE, r);

function loadSeen() {
  const seen = new Set();
  try {
    for (const line of fs.readFileSync(EVENTS_FILE, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const ev = JSON.parse(line);
      seen.add(`${ev.tx}:${ev.logIndex}`);
    }
  } catch (_) {
    /* no file yet */
  }
  return seen;
}

async function ensureBaseline(provider, addr) {
  const existing = readJson(BASELINE_FILE, null);
  if (existing) {
    if (lc(existing.address) !== lc(addr)) {
      die(`state/baseline.json belongs to another address (${short(existing.address)}). If you switch wallets, rename the state/ folder as a backup first.`);
    }
    return existing;
  }
  const balances = await readBalances(provider, addr);
  const block = await retry(() => provider.getBlockNumber());
  const b = { address: addr, market: MARKET, block, ts: new Date().toISOString(), balances };
  writeJson(BASELINE_FILE, b);
  appendLog({ type: 'baseline', ...b });
  return b;
}

// ---------------------------------------------------------------- events

function normEvent(parsed, log) {
  const args = {};
  for (const f of parsed.eventFragment.inputs) {
    const v = parsed.args[f.name];
    if (Array.isArray(v)) args[f.name] = v.map((x) => x.toString());
    else if (v && v._isBigNumber) args[f.name] = v.toString();
    else if (typeof v === 'boolean') args[f.name] = v;
    else args[f.name] = String(v);
  }
  return { name: parsed.name, block: log.blockNumber, tx: log.transactionHash, logIndex: log.logIndex, args };
}

function parseMarketLogs(receipt) {
  const out = [];
  for (const l of receipt.logs) {
    if (lc(l.address) !== lc(MARKET)) continue;
    try {
      out.push(normEvent(obIface.parseLog(l), l));
    } catch (_) {
      /* not an OrderBook event */
    }
  }
  return out;
}

async function scanEvents(provider, from, to) {
  const step = cfg.scan.maxBlocksPerRequest;
  const windows = [];
  for (let s = from; s <= to; s += step) windows.push([s, Math.min(s + step - 1, to)]);
  const results = [];
  const conc = 4;
  for (let i = 0; i < windows.length; i += conc) {
    const part = await Promise.all(
      windows.slice(i, i + conc).map(([a, b]) =>
        retry(() => provider.getLogs({ address: MARKET, topics: [TOPICS], fromBlock: a, toBlock: b })),
      ),
    );
    for (const logs of part) {
      for (const l of logs) {
        try {
          results.push(normEvent(obIface.parseLog(l), l));
        } catch (_) {
          /* skip */
        }
      }
    }
  }
  results.sort((x, y) => x.block - y.block || x.logIndex - y.logIndex);
  return results;
}

function isMine(ev, me, ids) {
  const a = ev.args;
  switch (ev.name) {
    case 'Trade':
      return lc(a.makerAddress) === lc(me) || ids.has(a.orderId);
    case 'FlipOrderCreated':
    case 'FlippedOrderCreated':
    case 'FlipOrdersCanceled':
      return lc(a.owner) === lc(me);
    case 'FlipOrderUpdated':
      return ids.has(a.orderId);
    default:
      return false;
  }
}

function applyToRegistry(reg, ev) {
  const a = ev.args;
  if (ev.name === 'FlipOrderCreated' || ev.name === 'FlippedOrderCreated') {
    if (!reg.orders[a.orderId]) {
      reg.orders[a.orderId] = {
        id: Number(a.orderId),
        via: ev.name,
        flippedIdField: a.flippedId,
        isBuy: a.isBuy === true || a.isBuy === 'true',
        price: a.price,
        flippedPrice: a.flippedPrice,
        size0: a.size,
        block: ev.block,
        tx: ev.tx,
      };
    }
  }
}

// Scan [lastBlock+1, head] for events that concern us; persist; return them.
async function syncEvents(provider, addr) {
  const reg = loadRegistry();
  const scan = readJson(SCAN_FILE, null);
  const head = await retry(() => provider.getBlockNumber());
  if (!scan) return { reg, fresh: [], head, scanned: 0, started: false };
  const from = scan.lastBlock + 1;
  if (from > head) return { reg, fresh: [], head, scanned: 0, started: true };
  const evs = await scanEvents(provider, from, head);
  const ids = new Set(Object.keys(reg.orders));
  const seen = loadSeen();
  const fresh = [];
  for (const ev of evs) {
    if (!isMine(ev, addr, ids)) continue;
    const key = `${ev.tx}:${ev.logIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    applyToRegistry(reg, ev);
    if (reg.orders[ev.args.orderId]) ids.add(String(ev.args.orderId));
    fresh.push(ev);
  }
  if (fresh.length) {
    ensureState();
    fs.appendFileSync(EVENTS_FILE, fresh.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
  writeJson(SCAN_FILE, { lastBlock: head });
  saveRegistry(reg);
  return { reg, fresh, head, scanned: head - from + 1, started: true };
}

function loadMyEvents() {
  const out = [];
  try {
    for (const line of fs.readFileSync(EVENTS_FILE, 'utf8').split('\n')) {
      if (line.trim()) out.push(JSON.parse(line));
    }
  } catch (_) {
    /* none yet */
  }
  return out;
}

// ---------------------------------------------------------------- tx bookkeeping

async function recordTx(provider, receipt, label) {
  const tx = await retry(() => provider.getTransaction(receipt.transactionHash));
  const gasPrice = toBig(receipt.effectiveGasPrice || tx.gasPrice || 0);
  const gasUsed = toBig(receipt.gasUsed);
  const gasLimit = toBig(tx.gasLimit);
  const entry = {
    type: 'tx',
    label,
    hash: receipt.transactionHash,
    block: receipt.blockNumber,
    status: receipt.status,
    gasUsed,
    gasLimit,
    gasPriceWei: gasPrice,
    feeIfGasUsedWei: gasUsed * gasPrice,
    feeIfGasLimitWei: gasLimit * gasPrice,
  };
  appendLog(entry);
  return entry;
}

// ---------------------------------------------------------------- commands

async function cmdPreflight() {
  const { provider, addr } = await context();
  let allOk = true;
  const rec = (ok, text) => {
    if (!ok) allOk = false;
    say(`${ok ? '✅' : '❌'} ${text}`);
  };
  say(`== Preflight (read-only, sends no transactions) · market ${MARKET_NAME} ==`);

  const head = await retry(() => provider.getBlockNumber());
  const gasPrice = await retry(() => provider.getGasPrice());
  rec(true, `Monad mainnet (chainId ${cfg.chainId}), block ${head}, gas price ${ethers.utils.formatUnits(gasPrice, 'gwei')} gwei`);

  const v = await verifyMarket(provider);
  v.checks.forEach(([ok, t]) => rec(ok, t));
  const mp = v.mp;
  const f = fmtFactory(mp);
  const book = await readBook(provider, mp);
  const spreadTicks = (book.ask - book.bid) / mp.tickSize;
  say(
    `   Book: best bid ${f.price(book.bid)}, best ask ${f.price(book.ask)} USDC (spread ${spreadTicks} ticks, tick=${f.price(mp.tickSize)})`,
  );
  const minOrderUsdc = u.quoteForSize(mp.minSize, book.ask, mp, true);
  say(`   Minimum order ${f.size(mp.minSize)} MON ≈ ${f.usdc(minOrderUsdc)} USDC; maximum ${f.size(mp.maxSize)} MON`);
  say(`   Fees (read on-chain): taker ${mp.takerFeeBps} bps, maker ${mp.makerFeeBps} bps`);

  try {
    const sp = await KuruSdk.ParamFetcher.getMarketParams(provider, MARKET);
    const same =
      toBig(sp.pricePrecision) === mp.pricePrecision &&
      toBig(sp.sizePrecision) === mp.sizePrecision &&
      toBig(sp.tickSize) === mp.tickSize &&
      toBig(sp.minSize) === mp.minSize;
    rec(same, 'Market parameters read by the SDK match a direct contract read');
  } catch (e) {
    rec(false, `SDK ParamFetcher failed: ${errMsg(e)}`);
  }

  // Simulations on a throwaway address with a faked margin balance (state override): costs nothing.
  const simFrom = ethers.Wallet.createRandom().address;
  const overrides = {
    [MARGIN]: { stateDiff: { [marginSlot(simFrom, USDC)]: ethers.constants.MaxUint256.toHexString() } },
    [simFrom]: { balance: '0x56bc75e2d63100000' },
  };
  const sizeOk = mp.minSize + u.parseUnits('1', u.log10Exact(mp.sizePrecision));
  const good = u.buildBidLadder({ bestBid: book.bid, bestAsk: book.ask, tick: mp.tickSize, count: 1, sizeRaw: sizeOk });
  const r1 = await simulateProvision(provider, simFrom, good, true, overrides);
  rec(r1.ok, `Simulation: a valid flip bid can be placed ${r1.ok ? '' : `(rejected: ${r1.error})`}`);
  const r2 = await simulateProvision(provider, simFrom, [{ ...good[0], liquidity: mp.minSize - 1n }], true, overrides);
  rec(!r2.ok && r2.error === 'SizeError', `Control: an order below the minimum is rejected (SizeError) → actual ${r2.ok ? 'not rejected, so the simulation cannot be trusted' : r2.error}`);
  const crossing = [{ price: book.ask + mp.tickSize, flipPrice: book.ask + 5n * mp.tickSize, liquidity: sizeOk }];
  const r3 = await simulateProvision(provider, simFrom, crossing, true, overrides);
  rec(!r3.ok && r3.error === 'ProvisionError', `Control: a bid that crosses the book is rejected (ProvisionError) → actual ${r3.ok ? 'not rejected, so the simulation cannot be trusted' : r3.error}`);

  say('');
  if (addr) {
    const b = await readBalances(provider, addr);
    const minGas = u.parseUnits(cfg.limits.minWalletMon, 18);
    say(`   Wallet ${short(addr)}: MON ${f.mon(b.walletMon)} (pays gas), USDC ${f.usdc(b.walletUsdc)}`);
    say(`   Margin account: USDC ${f.usdc(b.marginUsdc)}, MON ${f.mon(b.marginMon)}`);
    rec(b.walletMon >= minGas, `Wallet has enough MON for gas (at least ${cfg.limits.minWalletMon})`);
    const need = minOrderUsdc + u.parseUnits('0.5', 6);
    rec(b.walletUsdc + b.marginUsdc >= need, `Enough USDC for one minimum order (need at least ${f.usdc(need)})`);
  } else {
    say('   (neither PRIVATE_KEY nor ADDRESS is set; skipping the wallet check)');
    say(`   Suggested funding: about ${f.usdc(minOrderUsdc + u.parseUnits('1', 6))} USDC + about 5 MON (gas), in a dedicated test wallet.`);
  }

  appendLog({ type: 'preflight', ok: allOk, block: head });
  say(allOk ? '\n✅ Preflight passed.' : '\n❌ Preflight failed. Do not continue; share the output above.');
  process.exit(allOk ? 0 : 2);
}

async function cmdDeposit(args) {
  if (!args.usdc || args.usdc === true) die('Usage: deposit --usdc 6 --live');
  const amount = u.parseUnits(String(args.usdc), 6);
  const cap = u.parseUnits(cfg.limits.maxDepositUsdc, 6);
  if (amount <= 0n || amount > cap) die(`The amount must be above 0 and at most ${cfg.limits.maxDepositUsdc} USDC (the cap is in config/kuru.mainnet.json).`);

  const { provider, signer, addr } = await context({ needSigner: Boolean(args.live), needAddr: true });
  const v = await verifyMarket(provider);
  v.checks.forEach(([ok, t]) => say(`${ok ? '✅' : '❌'} ${t}`));
  if (!v.ok) die('Market verification failed; stopping.');
  const f = fmtFactory(v.mp);
  const bal = await readBalances(provider, addr);
  if (bal.walletUsdc < amount) die(`Not enough USDC in the wallet: it has ${f.usdc(bal.walletUsdc)}, the deposit needs ${f.usdc(amount)}.`);
  if (bal.walletMon < u.parseUnits(cfg.limits.minWalletMon, 18)) die(`Too little MON in the wallet (${f.mon(bal.walletMon)}) to pay for gas.`);

  say(`\nAbout to deposit ${f.usdc(amount)} USDC from wallet ${short(addr)} into the Kuru margin account ${short(MARGIN)}.`);
  say(`Before: wallet USDC ${f.usdc(bal.walletUsdc)}, margin USDC ${f.usdc(bal.marginUsdc)}`);
  if (!args.live) {
    say('\n(Dry run: no --live flag, so no transaction was sent.)');
    return;
  }
  if (!(await confirm('This is a real transaction (it first approves exactly this amount, then deposits it).', args))) die('Cancelled.', 0);
  await ensureBaseline(provider, addr); // before any transaction, so deposits count as transfers, not gains

  const usdc = mkUsdc(signer);
  const allowance = toBig(await retry(() => usdc.allowance(addr, MARGIN)));
  if (allowance < amount) {
    say('1/2 Approving USDC (exactly the deposit amount)…');
    const tx = await usdc.approve(MARGIN, amount);
    const rc = await tx.wait();
    const t = await recordTx(provider, rc, 'approve');
    say(`    ✅ Approved, transaction ${t.hash}`);
  }
  say('2/2 Depositing into the margin account…');
  let receipt;
  try {
    receipt = await KuruSdk.MarginDeposit.deposit(signer, MARGIN, addr, USDC, String(args.usdc), 6, false);
  } catch (e) {
    die(`Deposit failed: ${errMsg(e)}`);
  }
  const t = await recordTx(provider, receipt, 'deposit');
  const after = await readBalances(provider, addr);
  const delta = after.marginUsdc - bal.marginUsdc;
  say(`    ✅ Deposited, transaction ${t.hash}`);
  say(`After: wallet USDC ${f.usdc(after.walletUsdc)}, margin USDC ${f.usdc(after.marginUsdc)}`);
  say(delta === amount ? '✅ The margin grew by exactly the deposited amount.' : `⚠️ The margin grew by ${f.usdc(delta)}, which differs from the deposit of ${f.usdc(amount)}. Share this line.`);
  appendLog({ type: 'deposit', amount, marginDelta: delta, exact: delta === amount });
}

async function cmdPlant(args) {
  const simFunds = Boolean(args['sim-funds']);
  if (simFunds && args.live) die('--sim-funds is for dry runs only and cannot be combined with --live.');
  const { provider, signer, addr } = await context({ needSigner: Boolean(args.live), needAddr: true });
  const v = await verifyMarket(provider);
  v.checks.forEach(([ok, t]) => say(`${ok ? '✅' : '❌'} ${t}`));
  if (!v.ok) die('Market verification failed; stopping.');
  const mp = v.mp;
  const f = fmtFactory(mp);

  const count = Number(args.orders || 1);
  if (!Number.isInteger(count) || count < 1 || count > cfg.limits.maxOrdersPerPlant) {
    die(`--orders must be an integer from 1 to ${cfg.limits.maxOrdersPerPlant} (the cap is in the config).`);
  }
  const sd = u.log10Exact(mp.sizePrecision);
  const sizeRaw = u.parseUnits(String(args['size-mon'] || u.formatUnits(mp.minSize + 10n ** BigInt(sd), sd)), sd);
  if (sizeRaw < mp.minSize) die(`Each order must be at least ${f.size(mp.minSize)} MON.`);
  if (sizeRaw > mp.maxSize) die('Above the maximum order size.');

  const book = await readBook(provider, mp);
  const bids = u.buildBidLadder({
    bestBid: book.bid,
    bestAsk: book.ask,
    tick: mp.tickSize,
    count,
    sizeRaw,
    // Default: as close to the best ask as a bid may go (ask - 1 tick). Market-maker bots re-quote ~5 times a
    // second, so "best bid + 1 tick" loses the front of the queue within seconds; ask - 1 tick cannot be outbid.
    // Pass --offset-ticks 1 for the passive placement.
    offsetTicks: BigInt(args['offset-ticks'] === undefined ? 1000 : args['offset-ticks']),
    stepBps: BigInt(args['step-bps'] === undefined ? 10 : args['step-bps']),
    spreadBps: BigInt(args['spread-bps'] === undefined ? 10 : args['spread-bps']),
  });

  let needQuote = 0n;
  say(`\nBook: best bid ${f.price(book.bid)}, best ask ${f.price(book.ask)} USDC`);
  say('Level  Bid price(USDC)  Flip ask(USDC)  Size(MON)  Locked(USDC)  Gross profit per full round trip(USDC)');
  bids.forEach((b, i) => {
    const q = u.quoteForSize(b.liquidity, b.price, mp, true);
    needQuote += q;
    const gross = u.quoteForSize(b.liquidity, b.flipPrice - b.price, mp);
    say(`${String(i + 1).padStart(2)}    ${f.price(b.price).padEnd(12)}  ${f.price(b.flipPrice).padEnd(14)}  ${f.size(b.liquidity).padEnd(9)}  ${f.usdc(q).padEnd(10)}  ${f.usdc(gross)}`);
  });
  const cap = u.parseUnits(cfg.limits.maxNotionalUsdcPerPlant, 6);
  if (needQuote > cap) die(`Total locked ${f.usdc(needQuote)} USDC exceeds the cap of ${cfg.limits.maxNotionalUsdcPerPlant} (config).`);

  const bal = await readBalances(provider, addr);
  say(`\nFree margin USDC: ${f.usdc(bal.marginUsdc)}; needed now: ${f.usdc(needQuote)}`);
  let overrides;
  if (simFunds) {
    say('(Dry run: assumes the margin account holds enough USDC; for preview and simulation only, not proof that you have the money.)');
    overrides = {
      [MARGIN]: { stateDiff: { [marginSlot(addr, USDC)]: ethers.constants.MaxUint256.toHexString() } },
      [addr]: { balance: '0x56bc75e2d63100000' },
    };
  } else {
    if (bal.marginUsdc < needQuote) die('Not enough USDC in the margin account; run deposit first.');
    if (bal.walletMon < u.parseUnits(cfg.limits.minWalletMon, 18)) die(`Too little MON in the wallet (${f.mon(bal.walletMon)}) to pay for gas.`);
  }

  say(simFunds ? '\nSimulating (assuming funds; no transaction is sent)…' : '\nSimulating (with your real balance; no transaction is sent)…');
  const sim = await simulateProvision(provider, addr, bids, true, overrides);
  if (!sim.ok) die(`The contract rejected the simulation: ${sim.error}. No order was placed.`);
  say('✅ Simulation passed: every order will be created (none will be skipped).');

  if (!args.live) {
    say('\n(Dry run: no --live flag, so no transaction was sent.)');
    return;
  }
  if (!(await confirm(`This is a real order: ${count} flip bid(s), locking ${f.usdc(needQuote)} USDC in total. You can cancel and withdraw at any time with unwind.`, args))) die('Cancelled.', 0);
  await ensureBaseline(provider, addr); // no-op when deposit already recorded it

  const batch = {
    bids,
    asks: [],
    quoteLiquidity: needQuote,
    baseLiquidity: 0n,
    minSizeError: false,
  };
  let receipt;
  try {
    receipt = await KuruSdk.PositionProvider.provisionLiquidity(signer, MARKET, batch);
  } catch (e) {
    die(`Placing the order failed: ${errMsg(e)}`);
  }
  const t = await recordTx(provider, receipt, 'plant');
  const evs = parseMarketLogs(receipt);
  const created = evs.filter((e) => e.name === 'FlipOrderCreated' && lc(e.args.owner) === lc(addr));
  if (receipt.status !== 1) die(`Transaction failed, status ${receipt.status}, transaction ${t.hash}`);

  const reg = loadRegistry();
  created.forEach((e) => applyToRegistry(reg, e));
  saveRegistry(reg);
  ensureState();
  const seen = loadSeen();
  const toStore = created.filter((e) => !seen.has(`${e.tx}:${e.logIndex}`));
  if (toStore.length) fs.appendFileSync(EVENTS_FILE, toStore.map((e) => JSON.stringify(e)).join('\n') + '\n');
  // Never move the scan point forward here: events between an earlier scan and this plant must not be skipped.
  const prevScan = readJson(SCAN_FILE, null);
  writeJson(SCAN_FILE, { lastBlock: prevScan ? Math.min(prevScan.lastBlock, receipt.blockNumber - 1) : receipt.blockNumber - 1 });

  say(`\nTransaction ${t.hash} (block ${receipt.blockNumber})`);
  say(`gas: used ${t.gasUsed}, limit ${t.gasLimit}; charged on the limit ≈ ${u.formatUnits(t.feeIfGasLimitWei, 18, 6)} MON, on actual use ≈ ${u.formatUnits(t.feeIfGasUsedWei, 18, 6)} MON`);
  if (created.length === count) {
    say(`✅ Confirmed on-chain: created ${created.length}/${count} flip order(s): order id(s) ${created.map((e) => e.args.orderId).join(', ')}`);
  } else {
    say(`❌ Only ${created.length}/${count} order(s) were created (some were skipped). Do not continue; share this output.`);
  }
  appendLog({ type: 'plant', requested: count, created: created.length, orderIds: created.map((e) => e.args.orderId) });
  say('\nNext: node scripts/gate.cjs status --watch   (wait for a fill; Ctrl+C exits at any time and the state is kept)');
}

async function printStatus({ provider, addr, mp, f, reg, fresh, head, verbose }) {
  const book = await readBook(provider, mp);
  const ids = Object.keys(reg.orders).map(Number);
  const orders = await Promise.all(ids.map((id) => readOrder(provider, id)));
  const bal = await readBalances(provider, addr);
  const lock = lockedFromOrders(orders, mp);
  const live = orders.filter(isLive);
  const t = new Date().toLocaleTimeString();
  say(
    `[${t}] block ${head} | book ${f.price(book.bid)}/${f.price(book.ask)} | live orders ${live.length} (bids ${live.filter((o) => o.isBuy).length} / asks ${live.filter((o) => !o.isBuy).length}) | new events ${fresh.length} | margin USDC ${f.usdc(bal.marginUsdc)} MON ${f.mon(bal.marginMon)} | locked USDC ${f.usdc(lock.quote)} MON ${f.mon(lock.base)}`,
  );
  for (const ev of fresh) {
    const a = ev.args;
    if (ev.name === 'Trade') {
      const priceRaw = u.eventPriceToRaw(BigInt(a.price), mp.pricePrecision);
      say(`   🔔 Fill: order ${a.orderId} ${makerBuys(a.isBuy) ? 'our bid was hit (the counterparty sold)' : 'our ask was hit (the counterparty bought)'} price ${f.price(priceRaw)} filled ${f.size(BigInt(a.filledSize))} MON remaining ${f.size(BigInt(a.updatedSize))} | taker ${short(a.takerAddress)} / origin ${short(a.txOrigin)} | block ${ev.block}`);
    } else if (ev.name === 'FlippedOrderCreated') {
      say(`   🔁 Flipped into new order ${a.orderId} (${a.isBuy ? 'bid' : 'ask'}) price ${f.price(BigInt(a.price))} size ${f.size(BigInt(a.size))} MON | block ${ev.block}`);
    } else {
      say(`   · ${ev.name} ${JSON.stringify(a)} | block ${ev.block}`);
    }
  }
  if (verbose) {
    for (const o of orders) {
      const reg0 = reg.orders[o.id];
      say(`   Order ${o.id} ${(isLive(o) ? o.isBuy : reg0.isBuy) ? 'bid' : 'ask'} ${isLive(o) ? '[live]' : '[off the book]'} price ${f.price(isLive(o) ? o.price : BigInt(reg0.price))} flip price ${f.price(isLive(o) ? o.flippedPrice : BigInt(reg0.flippedPrice))} remaining ${f.size(o.size)} MON (at creation ${f.size(BigInt(reg0.size0))}) flippedId=${o.flippedId}`);
    }
  }
  return { orders, bal, lock };
}

async function cmdStatus(args) {
  const { provider, addr } = await context();
  if (!addr) die('Set PRIVATE_KEY or ADDRESS so the tool knows whose orders to show.');
  const mp = await readMarketParams(provider);
  const f = fmtFactory(mp);
  const interval = Number(args.interval || 20);
  let stop = false;
  process.on('SIGINT', () => {
    stop = true;
    say('\nExited (state is saved; you can run it again at any time).');
    process.exit(0);
  });
  do {
    const { reg, fresh, head, started } = await syncEvents(provider, addr);
    if (!started) die('No order has been placed yet (there is no state/scan.json). Run plant --live first.');
    await printStatus({ provider, addr, mp, f, reg, fresh, head, verbose: !args.watch || fresh.length > 0 });
    appendLog({ type: 'status', block: head, freshEvents: fresh.length });
    if (!args.watch) break;
    await sleep(interval * 1000);
  } while (!stop);
}

async function cmdUnwind(args) {
  const { provider, signer, addr } = await context({ needSigner: Boolean(args.live), needAddr: true });
  const v = await verifyMarket(provider);
  if (!v.ok) die('Market verification failed; stopping.');
  const mp = v.mp;
  const f = fmtFactory(mp);

  const { reg } = await syncEvents(provider, addr);
  const ids = Object.keys(reg.orders).map(Number);
  const orders = await Promise.all(ids.map((id) => readOrder(provider, id)));
  const live = orders.filter((o) => isLive(o) && lc(o.owner) === lc(addr));
  const bal = await readBalances(provider, addr);
  say(`\nTracking ${ids.length} order(s), ${live.length} still on the book: ${live.map((o) => o.id).join(', ') || 'none'}`);
  say(`Margin account: USDC ${f.usdc(bal.marginUsdc)}, MON ${f.mon(bal.marginMon)}`);
  if (!args.live) {
    say('\n(Dry run: no --live flag, so no transaction was sent.)');
    return;
  }
  if (!(await confirm('This is a real transaction: it cancels every live order above and withdraws all USDC and MON from the margin account back to the wallet.', args))) die('Cancelled.', 0);

  if (live.length) {
    const liveIds = live.map((o) => o.id);
    const cancelled = [];
    try {
      cancelled.push(await KuruSdk.PositionWithdrawer.withdrawLiquidity(signer, MARKET, liveIds));
    } catch (e) {
      const why = decodeRevert(e);
      say(`Batch cancel of flip orders failed: ${why}`);
      if (!/WrongOrderTypeCancel/i.test(why)) die('Cancel failed; nothing was withdrawn. Share the output above.');
      say('→ The order types differ; cancelling one by one (as a flip order first, then as a plain order)…');
      for (const id of liveIds) {
        try {
          cancelled.push(await KuruSdk.PositionWithdrawer.withdrawLiquidity(signer, MARKET, [id]));
        } catch (e2) {
          const why2 = decodeRevert(e2);
          if (!/WrongOrderTypeCancel/i.test(why2)) die(`Cancelling order ${id} failed: ${why2}`);
          cancelled.push(await KuruSdk.OrderCanceler.cancelOrders(signer, MARKET, [ethers.BigNumber.from(id)]));
        }
      }
    }
    for (const receipt of cancelled) {
      const t = await recordTx(provider, receipt, 'cancel');
      say(`✅ Cancel transaction ${t.hash}`);
    }
    const after = await Promise.all(liveIds.map((id) => readOrder(provider, id)));
    const still = after.filter(isLive);
    if (still.length) say(`⚠️ Still on the book: ${still.map((o) => o.id).join(', ')}`);
  }

  const b2 = await readBalances(provider, addr);
  const tokens = [];
  if (b2.marginUsdc > 0n) tokens.push(USDC);
  if (b2.marginMon > 0n) tokens.push(ZERO);
  if (tokens.length) {
    const receipt = await KuruSdk.MarginWithdraw.batchClaimMaxTokens(signer, MARGIN, tokens);
    const t = await recordTx(provider, receipt, 'withdraw');
    say(`✅ Withdraw transaction ${t.hash}`);
  } else {
    say('The margin account has nothing to withdraw.');
  }
  const fin = await readBalances(provider, addr);
  say(`\nFinal: wallet USDC ${f.usdc(fin.walletUsdc)}, MON ${f.mon(fin.walletMon)}; margin USDC ${f.usdc(fin.marginUsdc)}, MON ${f.mon(fin.marginMon)}`);
  appendLog({ type: 'unwind', cancelled: live.map((o) => o.id), final: fin });
  say('Next: node scripts/gate.cjs report');
}

async function cmdReport() {
  const { provider, addr } = await context({ needAddr: true });
  const mp = await readMarketParams(provider);
  const f = fmtFactory(mp);
  const base = readJson(BASELINE_FILE, null);
  if (!base) die('There is no state/baseline.json: deposit --live has not been run yet.');
  // JSON stores BigInts as strings: convert back before doing any arithmetic.
  const baseBal = Object.fromEntries(Object.entries(base.balances).map(([k, v]) => [k, BigInt(v)]));
  const { reg } = await syncEvents(provider, addr);

  const ids = Object.keys(reg.orders).map(Number);
  const orders = await Promise.all(ids.map((id) => readOrder(provider, id)));
  const now = await readBalances(provider, addr);
  const lock = lockedFromOrders(orders, mp);
  const head = await retry(() => provider.getBlockNumber());

  const logs = [];
  try {
    for (const line of fs.readFileSync(LOG_FILE, 'utf8').split('\n')) if (line.trim()) logs.push(JSON.parse(line));
  } catch (_) {
    /* none */
  }
  const txs = logs.filter((l) => l.type === 'tx');
  const feeLimit = txs.reduce((s, t) => s + BigInt(t.feeIfGasLimitWei), 0n);
  const feeUsed = txs.reduce((s, t) => s + BigInt(t.feeIfGasUsedWei), 0n);

  const fills = [];
  for (const ev of loadMyEvents()) {
    if (ev.name !== 'Trade' || lc(ev.args.makerAddress) !== lc(addr)) continue;
    const priceRaw = u.eventPriceToRaw(BigInt(ev.args.price), mp.pricePrecision);
    const sizeRaw = BigInt(ev.args.filledSize);
    fills.push({
      ev,
      priceRaw,
      sizeRaw,
      makerBuys: makerBuys(ev.args.isBuy), // Trade.isBuy is the taker's side
      q: u.quoteForSize(sizeRaw, priceRaw, mp),
    });
  }
  const r = reconcile({ baseline: baseBal, now, locked: lock, fills, feeLimit, feeUsed, mp });

  say('==== Gate-test report (safe to share; contains no private key) ====');
  say(`Address ${short(addr)} | market ${MARKET_NAME} | block ${head} | time ${new Date().toISOString()}`);
  say(`Baseline (block ${base.block}): wallet USDC ${f.usdc(baseBal.walletUsdc)} MON ${f.mon(baseBal.walletMon)}; margin USDC ${f.usdc(baseBal.marginUsdc)} MON ${f.mon(baseBal.marginMon)}`);
  say(`Now: wallet USDC ${f.usdc(now.walletUsdc)} MON ${f.mon(now.walletMon)}; margin USDC ${f.usdc(now.marginUsdc)} MON ${f.mon(now.marginMon)}; locked in orders USDC ${f.usdc(lock.quote)} MON ${f.mon(lock.base)}`);
  say('');
  say(`Tracked orders (${ids.length}):`);
  for (const o of orders) {
    const rg = reg.orders[o.id];
    say(`  #${o.id} ${(isLive(o) ? o.isBuy : rg.isBuy) ? 'bid' : 'ask'} ${isLive(o) ? 'live' : 'off the book'} price ${f.price(isLive(o) ? o.price : BigInt(rg.price))} flip price ${f.price(isLive(o) ? o.flippedPrice : BigInt(rg.flippedPrice))} remaining ${f.size(o.size)} MON (from ${rg.via}, size at creation ${f.size(BigInt(rg.size0))}, flippedId=${o.flippedId})`);
  }
  say('');
  say(`Fills where we were the maker (${fills.length}):`);
  for (const x of fills) {
    const a = x.ev.args;
    say(`  block ${x.ev.block} order #${a.orderId} ${x.makerBuys ? 'bought' : 'sold'} ${f.size(x.sizeRaw)} MON @ ${f.price(x.priceRaw)} = ${f.usdc(x.q)} USDC | remaining ${f.size(BigInt(a.updatedSize))} | taker ${short(a.takerAddress)} origin ${short(a.txOrigin)}`);
  }
  say('');
  say('Reconciliation (net worth = wallet + margin + locked in orders):');
  say(`  USDC: balance change ${f.usdc(r.dQuote)} | implied by fills ${f.usdc(r.expected.quote)} | unexplained difference ${u.formatUnits(r.quoteDiff, mp.quoteDecimals)}`);
  say(`  MON: balance change ${u.formatUnits(r.dBase, 18, 8)} | implied by fills ${u.formatUnits(r.expected.base, 18, 8)}`);
  say(`  Total gas: ${u.formatUnits(feeLimit, 18, 8)} MON if charged on the limit; ${u.formatUnits(feeUsed, 18, 8)} MON if charged on actual use (${txs.length} transactions)`);
  say(`  MON unexplained difference: limit basis ${u.formatUnits(r.baseDiffLimit, 18, 8)} | used-gas basis ${u.formatUnits(r.baseDiffUsed, 18, 8)}`);
  const modelText =
    r.feeModel === 'gasLimit'
      ? 'gas charged on the limit'
      : r.feeModel === 'gasUsed'
        ? 'gas charged on actual use'
        : r.feeModel === 'either'
          ? 'both bases agree: in Monad receipts gasUsed equals the limit'
          : '';
  say(`  Result: USDC ${r.quoteOk ? 'matches' : 'does not match'}; MON ${r.baseOk ? `matches (${modelText})` : 'does not match'}`);
  if (!r.meaningful) {
    say('  Note: there are no fills yet, so this report only exercises deposits, withdrawals and gas; it does not count as a pass.');
  } else if (r.quoteOk && r.baseOk) {
    say('  ✅ The reconciliation holds (the gate also requires that creation, a fill, the flipped opposite order and the cancel can all be read from the chain).');
  } else if (r.signFlipped) {
    say('  Diagnosis: Trade.isBuy may mean the opposite of what was assumed (signs reversed).');
  } else {
    say('  Diagnosis: the source of the difference is unknown (fees, rounding or a missed event); share the whole report.');
  }
  appendLog({
    type: 'report',
    head,
    dQuote: r.dQuote,
    expQuote: r.expected.quote,
    dBase: r.dBase,
    expBase: r.expected.base,
    feeLimit,
    feeUsed,
    quoteOk: r.quoteOk,
    baseOk: r.baseOk,
    feeModel: r.feeModel,
    fills: fills.length,
  });
}

function cmdHelp() {
  say(`Flip Garden gate-test tool (Kuru on Monad mainnet)

  node scripts/gate.cjs preflight                 read-only preflight: chain, market, simulated order, wallet
  node scripts/gate.cjs deposit --usdc 6 [--live] approve and deposit into the margin account
  node scripts/gate.cjs plant [--orders 1] [--size-mon 201] [--spread-bps 10] [--live]
                                                   place flip bids (simulated first; only --live sends)
  node scripts/gate.cjs status [--watch] [--interval 20]
                                                   show orders, fills and balances; --watch keeps watching
  node scripts/gate.cjs unwind [--live]            cancel every live order and withdraw everything
  node scripts/gate.cjs report                     reconciliation report (safe to share)

  Common: --yes skips the interactive confirmation (not recommended). The private key is read only from the PRIVATE_KEY environment variable.`);
}

// ---------------------------------------------------------------- main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'help';
  if (args.market && args.market !== true) {
    if (!cfg.markets[args.market]) die(`The config has no market named ${args.market}.`);
    MARKET_NAME = args.market;
    MARKET = cfg.markets[MARKET_NAME];
  }
  switch (cmd) {
    case 'preflight':
      return cmdPreflight(args);
    case 'deposit':
      return cmdDeposit(args);
    case 'plant':
      return cmdPlant(args);
    case 'status':
      return cmdStatus(args);
    case 'unwind':
      return cmdUnwind(args);
    case 'report':
      return cmdReport(args);
    default:
      return cmdHelp();
  }
}

main().catch((e) => {
  console.error(`\n❌ Unexpected error: ${errMsg(e)}\n`);
  process.exit(1);
});
