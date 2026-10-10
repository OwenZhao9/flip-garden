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
  if (!process.stdin.isTTY) die('需要在终端里交互确认；请直接在终端运行，或显式加 --yes。');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = await new Promise((res) => rl.question(`${prompt}\n输入 YES 继续，其他任意输入取消: `, res));
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
  if (id !== cfg.chainId) die(`RPC 返回 chainId=${id}，期望 ${cfg.chainId}（Monad 主网）。拒绝继续。`);
}

function loadSigner(provider) {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) die('PRIVATE_KEY 格式不对（需要 0x 开头的 64 位十六进制）。');
  return new ethers.Wallet(pk, provider);
}

// Dry runs only need an address (ADDRESS env); the private key is needed only for --live.
async function context({ needSigner = false, needAddr = false } = {}) {
  const provider = makeProvider();
  await ensureChain(provider);
  const signer = loadSigner(provider);
  if (needSigner && !signer) {
    die('--live 要用私钥：先在终端里设置环境变量 PRIVATE_KEY（见 README，用 read -rs 的方式，不要写进任何文件）。');
  }
  const envAddr = process.env.ADDRESS || null;
  if (envAddr && !ethers.utils.isAddress(envAddr)) die('ADDRESS 不是合法地址。');
  if (signer && envAddr && lc(envAddr) !== lc(signer.address)) die('ADDRESS 与 PRIVATE_KEY 对应的地址不一致，请只设置其中一个。');
  const addr = signer ? signer.address : envAddr;
  if (needAddr && !addr) die('需要 ADDRESS（你的钱包地址，演练用）或 PRIVATE_KEY（--live 用）。');
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
    [verified === true, `MarginAccount 认可这个市场 (verifiedMarket=${verified})`],
    [lc(mp.quoteAsset) === lc(USDC), `计价币是 USDC (${mp.quoteAsset})`],
    [mp.baseAsset === ZERO, `基础币是原生 MON (${mp.baseAsset})`],
    [mp.quoteDecimals === 6 && mp.baseDecimals === 18, `精度 USDC=${mp.quoteDecimals}、MON=${mp.baseDecimals}`],
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
      die(`state/baseline.json 属于另一个地址 (${short(existing.address)})。换钱包的话先把 state/ 文件夹改名备份。`);
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
  say(`== 预检（只读，不发任何交易）· 市场 ${MARKET_NAME} ==`);

  const head = await retry(() => provider.getBlockNumber());
  const gasPrice = await retry(() => provider.getGasPrice());
  rec(true, `Monad 主网 (chainId ${cfg.chainId})，区块 ${head}，gas 价 ${ethers.utils.formatUnits(gasPrice, 'gwei')} gwei`);

  const v = await verifyMarket(provider);
  v.checks.forEach(([ok, t]) => rec(ok, t));
  const mp = v.mp;
  const f = fmtFactory(mp);
  const book = await readBook(provider, mp);
  const spreadTicks = (book.ask - book.bid) / mp.tickSize;
  say(
    `   盘口：买一 ${f.price(book.bid)}，卖一 ${f.price(book.ask)} USDC（价差 ${spreadTicks} 个最小报价单位 tick，tick=${f.price(mp.tickSize)}）`,
  );
  const minOrderUsdc = u.quoteForSize(mp.minSize, book.ask, mp, true);
  say(`   最小下单量 ${f.size(mp.minSize)} MON ≈ ${f.usdc(minOrderUsdc)} USDC；最大 ${f.size(mp.maxSize)} MON`);
  say(`   手续费（链上读到）：taker ${mp.takerFeeBps} bps，maker ${mp.makerFeeBps} bps`);

  try {
    const sp = await KuruSdk.ParamFetcher.getMarketParams(provider, MARKET);
    const same =
      toBig(sp.pricePrecision) === mp.pricePrecision &&
      toBig(sp.sizePrecision) === mp.sizePrecision &&
      toBig(sp.tickSize) === mp.tickSize &&
      toBig(sp.minSize) === mp.minSize;
    rec(same, 'SDK 读到的市场参数与直接读合约一致');
  } catch (e) {
    rec(false, `SDK ParamFetcher 读取失败：${errMsg(e)}`);
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
  rec(r1.ok, `模拟：一张合法的翻转买单可以下 ${r1.ok ? '' : `（被拒：${r1.error}）`}`);
  const r2 = await simulateProvision(provider, simFrom, [{ ...good[0], liquidity: mp.minSize - 1n }], true, overrides);
  rec(!r2.ok && r2.error === 'SizeError', `对照：低于最小量会被拒（SizeError）→ 实际 ${r2.ok ? '没被拒，模拟不可信' : r2.error}`);
  const crossing = [{ price: book.ask + mp.tickSize, flipPrice: book.ask + 5n * mp.tickSize, liquidity: sizeOk }];
  const r3 = await simulateProvision(provider, simFrom, crossing, true, overrides);
  rec(!r3.ok && r3.error === 'ProvisionError', `对照：穿过卖盘的买单会被拒（ProvisionError）→ 实际 ${r3.ok ? '没被拒，模拟不可信' : r3.error}`);

  say('');
  if (addr) {
    const b = await readBalances(provider, addr);
    const minGas = u.parseUnits(cfg.limits.minWalletMon, 18);
    say(`   钱包 ${short(addr)}：MON ${f.mon(b.walletMon)}（付 gas），USDC ${f.usdc(b.walletUsdc)}`);
    say(`   保证金账户：USDC ${f.usdc(b.marginUsdc)}，MON ${f.mon(b.marginMon)}`);
    rec(b.walletMon >= minGas, `钱包 MON 够付 gas（至少 ${cfg.limits.minWalletMon}）`);
    const need = minOrderUsdc + u.parseUnits('0.5', 6);
    rec(b.walletUsdc + b.marginUsdc >= need, `USDC 够下 1 张最小单（需要 ≥ ${f.usdc(need)}）`);
  } else {
    say('   （没设置 PRIVATE_KEY 或 ADDRESS，跳过钱包检查）');
    say(`   建议准备：约 ${f.usdc(minOrderUsdc + u.parseUnits('1', 6))} USDC + 约 5 MON（gas），放在专用测试钱包里。`);
  }

  appendLog({ type: 'preflight', ok: allOk, block: head });
  say(allOk ? '\n✅ 预检通过。' : '\n❌ 预检没通过，先别往下做，把上面的输出贴给我。');
  process.exit(allOk ? 0 : 2);
}

async function cmdDeposit(args) {
  if (!args.usdc || args.usdc === true) die('用法：deposit --usdc 6 --live');
  const amount = u.parseUnits(String(args.usdc), 6);
  const cap = u.parseUnits(cfg.limits.maxDepositUsdc, 6);
  if (amount <= 0n || amount > cap) die(`金额必须大于 0 且不超过 ${cfg.limits.maxDepositUsdc} USDC（上限写在 config/kuru.mainnet.json）。`);

  const { provider, signer, addr } = await context({ needSigner: Boolean(args.live), needAddr: true });
  const v = await verifyMarket(provider);
  v.checks.forEach(([ok, t]) => say(`${ok ? '✅' : '❌'} ${t}`));
  if (!v.ok) die('市场校验没通过，停止。');
  const f = fmtFactory(v.mp);
  const bal = await readBalances(provider, addr);
  if (bal.walletUsdc < amount) die(`钱包 USDC 不够：有 ${f.usdc(bal.walletUsdc)}，要存 ${f.usdc(amount)}。`);
  if (bal.walletMon < u.parseUnits(cfg.limits.minWalletMon, 18)) die(`钱包 MON 太少（${f.mon(bal.walletMon)}），付不起 gas。`);

  say(`\n将把 ${f.usdc(amount)} USDC 从钱包 ${short(addr)} 存入 Kuru 保证金账户 ${short(MARGIN)}。`);
  say(`存之前：钱包 USDC ${f.usdc(bal.walletUsdc)}，保证金 USDC ${f.usdc(bal.marginUsdc)}`);
  if (!args.live) {
    say('\n（演练：没加 --live，没有发任何交易。）');
    return;
  }
  if (!(await confirm('这是真实交易（会先授权恰好这个金额，再存入）。', args))) die('已取消。', 0);
  await ensureBaseline(provider, addr); // before any transaction, so deposits count as transfers, not gains

  const usdc = mkUsdc(signer);
  const allowance = toBig(await retry(() => usdc.allowance(addr, MARGIN)));
  if (allowance < amount) {
    say('1/2 授权 USDC（金额恰好等于存入额）…');
    const tx = await usdc.approve(MARGIN, amount);
    const rc = await tx.wait();
    const t = await recordTx(provider, rc, 'approve');
    say(`    ✅ 已授权，交易 ${t.hash}`);
  }
  say('2/2 存入保证金账户…');
  let receipt;
  try {
    receipt = await KuruSdk.MarginDeposit.deposit(signer, MARGIN, addr, USDC, String(args.usdc), 6, false);
  } catch (e) {
    die(`存入失败：${errMsg(e)}`);
  }
  const t = await recordTx(provider, receipt, 'deposit');
  const after = await readBalances(provider, addr);
  const delta = after.marginUsdc - bal.marginUsdc;
  say(`    ✅ 已存入，交易 ${t.hash}`);
  say(`存之后：钱包 USDC ${f.usdc(after.walletUsdc)}，保证金 USDC ${f.usdc(after.marginUsdc)}`);
  say(delta === amount ? '✅ 保证金增加额与存入额完全一致。' : `⚠️ 保证金增加了 ${f.usdc(delta)}，与存入额 ${f.usdc(amount)} 不一致 → 把这行贴给我。`);
  appendLog({ type: 'deposit', amount, marginDelta: delta, exact: delta === amount });
}

async function cmdPlant(args) {
  const simFunds = Boolean(args['sim-funds']);
  if (simFunds && args.live) die('--sim-funds 只能用于演练，不能和 --live 一起用。');
  const { provider, signer, addr } = await context({ needSigner: Boolean(args.live), needAddr: true });
  const v = await verifyMarket(provider);
  v.checks.forEach(([ok, t]) => say(`${ok ? '✅' : '❌'} ${t}`));
  if (!v.ok) die('市场校验没通过，停止。');
  const mp = v.mp;
  const f = fmtFactory(mp);

  const count = Number(args.orders || 1);
  if (!Number.isInteger(count) || count < 1 || count > cfg.limits.maxOrdersPerPlant) {
    die(`--orders 必须是 1 到 ${cfg.limits.maxOrdersPerPlant} 的整数（上限写在 config）。`);
  }
  const sd = u.log10Exact(mp.sizePrecision);
  const sizeRaw = u.parseUnits(String(args['size-mon'] || u.formatUnits(mp.minSize + 10n ** BigInt(sd), sd)), sd);
  if (sizeRaw < mp.minSize) die(`每张单至少 ${f.size(mp.minSize)} MON。`);
  if (sizeRaw > mp.maxSize) die('超过最大下单量。');

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
  say(`\n盘口：买一 ${f.price(book.bid)}，卖一 ${f.price(book.ask)} USDC`);
  say('档位  买入价(USDC)  翻转卖价(USDC)  数量(MON)  占用(USDC)  走完一轮的理论毛利(USDC)');
  bids.forEach((b, i) => {
    const q = u.quoteForSize(b.liquidity, b.price, mp, true);
    needQuote += q;
    const gross = u.quoteForSize(b.liquidity, b.flipPrice - b.price, mp);
    say(`${String(i + 1).padStart(2)}    ${f.price(b.price).padEnd(12)}  ${f.price(b.flipPrice).padEnd(14)}  ${f.size(b.liquidity).padEnd(9)}  ${f.usdc(q).padEnd(10)}  ${f.usdc(gross)}`);
  });
  const cap = u.parseUnits(cfg.limits.maxNotionalUsdcPerPlant, 6);
  if (needQuote > cap) die(`合计占用 ${f.usdc(needQuote)} USDC 超过上限 ${cfg.limits.maxNotionalUsdcPerPlant}（config）。`);

  const bal = await readBalances(provider, addr);
  say(`\n保证金账户可用 USDC：${f.usdc(bal.marginUsdc)}；本次需要：${f.usdc(needQuote)}`);
  let overrides;
  if (simFunds) {
    say('（演练：假设保证金账户里有足够的 USDC，仅用于预览和模拟，不代表你真的有这笔钱。）');
    overrides = {
      [MARGIN]: { stateDiff: { [marginSlot(addr, USDC)]: ethers.constants.MaxUint256.toHexString() } },
      [addr]: { balance: '0x56bc75e2d63100000' },
    };
  } else {
    if (bal.marginUsdc < needQuote) die('保证金账户里的 USDC 不够，先运行 deposit。');
    if (bal.walletMon < u.parseUnits(cfg.limits.minWalletMon, 18)) die(`钱包 MON 太少（${f.mon(bal.walletMon)}），付不起 gas。`);
  }

  say(simFunds ? '\n模拟（假设有资金，不发交易）…' : '\n模拟（用你的真实余额，不发交易）…');
  const sim = await simulateProvision(provider, addr, bids, true, overrides);
  if (!sim.ok) die(`模拟被合约拒绝：${sim.error}。没有下单。`);
  say('✅ 模拟通过：每张单都会被创建（没有被跳过的单）。');

  if (!args.live) {
    say('\n（演练：没加 --live，没有发任何交易。）');
    return;
  }
  if (!(await confirm(`这是真实下单：${count} 张翻转买单，共占用 ${f.usdc(needQuote)} USDC。可随时用 unwind 撤单取回。`, args))) die('已取消。', 0);
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
    die(`下单失败：${errMsg(e)}`);
  }
  const t = await recordTx(provider, receipt, 'plant');
  const evs = parseMarketLogs(receipt);
  const created = evs.filter((e) => e.name === 'FlipOrderCreated' && lc(e.args.owner) === lc(addr));
  if (receipt.status !== 1) die(`交易失败，状态 ${receipt.status}，交易 ${t.hash}`);

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

  say(`\n交易 ${t.hash}（区块 ${receipt.blockNumber}）`);
  say(`gas：用了 ${t.gasUsed}，上限 ${t.gasLimit}；若按上限收费 ≈ ${u.formatUnits(t.feeIfGasLimitWei, 18, 6)} MON，按实际用量 ≈ ${u.formatUnits(t.feeIfGasUsedWei, 18, 6)} MON`);
  if (created.length === count) {
    say(`✅ 链上确认创建了 ${created.length}/${count} 张翻转单：订单号 ${created.map((e) => e.args.orderId).join(', ')}`);
  } else {
    say(`❌ 只创建了 ${created.length}/${count} 张（有单被跳过）。别继续，把这段输出贴给我。`);
  }
  appendLog({ type: 'plant', requested: count, created: created.length, orderIds: created.map((e) => e.args.orderId) });
  say('\n下一步：node scripts/gate.cjs status --watch   （等一次成交；Ctrl+C 可随时退出，再进来不丢状态）');
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
    `[${t}] 区块 ${head} | 盘口 ${f.price(book.bid)}/${f.price(book.ask)} | 活跃订单 ${live.length}（买 ${live.filter((o) => o.isBuy).length}/卖 ${live.filter((o) => !o.isBuy).length}）| 新事件 ${fresh.length} | 保证金 USDC ${f.usdc(bal.marginUsdc)} MON ${f.mon(bal.marginMon)} | 锁定 USDC ${f.usdc(lock.quote)} MON ${f.mon(lock.base)}`,
  );
  for (const ev of fresh) {
    const a = ev.args;
    if (ev.name === 'Trade') {
      const priceRaw = u.eventPriceToRaw(BigInt(a.price), mp.pricePrecision);
      say(`   🔔 成交 订单${a.orderId} ${makerBuys(a.isBuy) ? '我方买单被吃（对手卖出）' : '我方卖单被吃（对手买入）'} 价 ${f.price(priceRaw)} 成交量 ${f.size(BigInt(a.filledSize))} MON 剩余 ${f.size(BigInt(a.updatedSize))} | 对手 taker ${short(a.takerAddress)} / 发起人 ${short(a.txOrigin)} | 区块 ${ev.block}`);
    } else if (ev.name === 'FlippedOrderCreated') {
      say(`   🔁 翻转出新订单 ${a.orderId}（${a.isBuy ? '买' : '卖'}）价 ${f.price(BigInt(a.price))} 量 ${f.size(BigInt(a.size))} MON | 区块 ${ev.block}`);
    } else {
      say(`   · ${ev.name} ${JSON.stringify(a)} | 区块 ${ev.block}`);
    }
  }
  if (verbose) {
    for (const o of orders) {
      const reg0 = reg.orders[o.id];
      say(`   订单 ${o.id} ${(isLive(o) ? o.isBuy : reg0.isBuy) ? '买' : '卖'} ${isLive(o) ? '【活跃】' : '【已不在簿上】'} 价 ${f.price(isLive(o) ? o.price : BigInt(reg0.price))} 翻转价 ${f.price(isLive(o) ? o.flippedPrice : BigInt(reg0.flippedPrice))} 剩余 ${f.size(o.size)} MON（创建时 ${f.size(BigInt(reg0.size0))}） flippedId=${o.flippedId}`);
    }
  }
  return { orders, bal, lock };
}

async function cmdStatus(args) {
  const { provider, addr } = await context();
  if (!addr) die('需要 PRIVATE_KEY 或 ADDRESS 才知道看谁的订单。');
  const mp = await readMarketParams(provider);
  const f = fmtFactory(mp);
  const interval = Number(args.interval || 20);
  let stop = false;
  process.on('SIGINT', () => {
    stop = true;
    say('\n已退出（状态已保存，随时可以重新运行）。');
    process.exit(0);
  });
  do {
    const { reg, fresh, head, started } = await syncEvents(provider, addr);
    if (!started) die('还没有下过单（没有 state/scan.json）。先运行 plant --live。');
    await printStatus({ provider, addr, mp, f, reg, fresh, head, verbose: !args.watch || fresh.length > 0 });
    appendLog({ type: 'status', block: head, freshEvents: fresh.length });
    if (!args.watch) break;
    await sleep(interval * 1000);
  } while (!stop);
}

async function cmdUnwind(args) {
  const { provider, signer, addr } = await context({ needSigner: Boolean(args.live), needAddr: true });
  const v = await verifyMarket(provider);
  if (!v.ok) die('市场校验没通过，停止。');
  const mp = v.mp;
  const f = fmtFactory(mp);

  const { reg } = await syncEvents(provider, addr);
  const ids = Object.keys(reg.orders).map(Number);
  const orders = await Promise.all(ids.map((id) => readOrder(provider, id)));
  const live = orders.filter((o) => isLive(o) && lc(o.owner) === lc(addr));
  const bal = await readBalances(provider, addr);
  say(`\n追踪到 ${ids.length} 个订单，其中仍在簿上的 ${live.length} 个：${live.map((o) => o.id).join(', ') || '无'}`);
  say(`保证金账户：USDC ${f.usdc(bal.marginUsdc)}，MON ${f.mon(bal.marginMon)}`);
  if (!args.live) {
    say('\n（演练：没加 --live，没有发任何交易。）');
    return;
  }
  if (!(await confirm('这是真实交易：撤掉上面所有活跃订单，并把保证金账户里的 USDC / MON 全部提回钱包。', args))) die('已取消。', 0);

  if (live.length) {
    const liveIds = live.map((o) => o.id);
    const cancelled = [];
    try {
      cancelled.push(await KuruSdk.PositionWithdrawer.withdrawLiquidity(signer, MARKET, liveIds));
    } catch (e) {
      const why = decodeRevert(e);
      say(`批量撤翻转单失败：${why}`);
      if (!/WrongOrderTypeCancel/i.test(why)) die('撤单失败，没有提现。把上面的输出贴给我。');
      say('→ 订单类型不一致，改为逐个撤（先按翻转单，不行再按普通单）…');
      for (const id of liveIds) {
        try {
          cancelled.push(await KuruSdk.PositionWithdrawer.withdrawLiquidity(signer, MARKET, [id]));
        } catch (e2) {
          const why2 = decodeRevert(e2);
          if (!/WrongOrderTypeCancel/i.test(why2)) die(`订单 ${id} 撤单失败：${why2}`);
          cancelled.push(await KuruSdk.OrderCanceler.cancelOrders(signer, MARKET, [ethers.BigNumber.from(id)]));
        }
      }
    }
    for (const receipt of cancelled) {
      const t = await recordTx(provider, receipt, 'cancel');
      say(`✅ 撤单交易 ${t.hash}`);
    }
    const after = await Promise.all(liveIds.map((id) => readOrder(provider, id)));
    const still = after.filter(isLive);
    if (still.length) say(`⚠️ 仍在簿上：${still.map((o) => o.id).join(', ')}`);
  }

  const b2 = await readBalances(provider, addr);
  const tokens = [];
  if (b2.marginUsdc > 0n) tokens.push(USDC);
  if (b2.marginMon > 0n) tokens.push(ZERO);
  if (tokens.length) {
    const receipt = await KuruSdk.MarginWithdraw.batchClaimMaxTokens(signer, MARGIN, tokens);
    const t = await recordTx(provider, receipt, 'withdraw');
    say(`✅ 提现交易 ${t.hash}`);
  } else {
    say('保证金账户里没有可提余额。');
  }
  const fin = await readBalances(provider, addr);
  say(`\n最终：钱包 USDC ${f.usdc(fin.walletUsdc)}，MON ${f.mon(fin.walletMon)}；保证金 USDC ${f.usdc(fin.marginUsdc)}，MON ${f.mon(fin.marginMon)}`);
  appendLog({ type: 'unwind', cancelled: live.map((o) => o.id), final: fin });
  say('下一步：node scripts/gate.cjs report   （把输出贴给我）');
}

async function cmdReport() {
  const { provider, addr } = await context({ needAddr: true });
  const mp = await readMarketParams(provider);
  const f = fmtFactory(mp);
  const base = readJson(BASELINE_FILE, null);
  if (!base) die('没有 state/baseline.json：还没跑过 deposit --live。');
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

  say('==== 实测报告（可整段贴给我；不含私钥）====');
  say(`地址 ${short(addr)} | 市场 ${MARKET_NAME} | 区块 ${head} | 时间 ${new Date().toISOString()}`);
  say(`基线（区块 ${base.block}）：钱包 USDC ${f.usdc(baseBal.walletUsdc)} MON ${f.mon(baseBal.walletMon)}；保证金 USDC ${f.usdc(baseBal.marginUsdc)} MON ${f.mon(baseBal.marginMon)}`);
  say(`现在：钱包 USDC ${f.usdc(now.walletUsdc)} MON ${f.mon(now.walletMon)}；保证金 USDC ${f.usdc(now.marginUsdc)} MON ${f.mon(now.marginMon)}；挂单锁定 USDC ${f.usdc(lock.quote)} MON ${f.mon(lock.base)}`);
  say('');
  say(`追踪订单 ${ids.length} 个：`);
  for (const o of orders) {
    const rg = reg.orders[o.id];
    say(`  #${o.id} ${(isLive(o) ? o.isBuy : rg.isBuy) ? '买' : '卖'} ${isLive(o) ? '活跃' : '已不在簿上'} 价 ${f.price(isLive(o) ? o.price : BigInt(rg.price))} 翻转价 ${f.price(isLive(o) ? o.flippedPrice : BigInt(rg.flippedPrice))} 剩余 ${f.size(o.size)} MON（来源 ${rg.via}，创建量 ${f.size(BigInt(rg.size0))}，flippedId=${o.flippedId}）`);
  }
  say('');
  say(`我方作为挂单方的成交 ${fills.length} 笔：`);
  for (const x of fills) {
    const a = x.ev.args;
    say(`  区块 ${x.ev.block} 订单#${a.orderId} ${x.makerBuys ? '买入' : '卖出'} ${f.size(x.sizeRaw)} MON @ ${f.price(x.priceRaw)} = ${f.usdc(x.q)} USDC | 剩余 ${f.size(BigInt(a.updatedSize))} | taker ${short(a.takerAddress)} 发起人 ${short(a.txOrigin)}`);
  }
  say('');
  say('对账（净值 = 钱包 + 保证金 + 挂单锁定）：');
  say(`  USDC：余额变化 ${f.usdc(r.dQuote)} | 按成交推算 ${f.usdc(r.expected.quote)} | 未解释差额 ${u.formatUnits(r.quoteDiff, mp.quoteDecimals)}`);
  say(`  MON：余额变化 ${u.formatUnits(r.dBase, 18, 8)} | 按成交推算 ${u.formatUnits(r.expected.base, 18, 8)}`);
  say(`  gas 合计：若按上限收费 ${u.formatUnits(feeLimit, 18, 8)} MON；若按实际用量 ${u.formatUnits(feeUsed, 18, 8)} MON（共 ${txs.length} 笔交易）`);
  say(`  MON 未解释差额：按上限口径 ${u.formatUnits(r.baseDiffLimit, 18, 8)} | 按用量口径 ${u.formatUnits(r.baseDiffUsed, 18, 8)}`);
  const modelText =
    r.feeModel === 'gasLimit'
      ? 'gas 按上限收'
      : r.feeModel === 'gasUsed'
        ? 'gas 按实际用量收'
        : r.feeModel === 'either'
          ? '两种口径一致：Monad 收据里的 gasUsed 恰好等于上限'
          : '';
  say(`  结果：USDC ${r.quoteOk ? '对得上' : '对不上'}；MON ${r.baseOk ? `对得上（${modelText}）` : '对不上'}`);
  if (!r.meaningful) {
    say('  注意：还没有任何成交，这份报告只验证了存取和 gas，不能算通过。');
  } else if (r.quoteOk && r.baseOk) {
    say('  ✅ 对账部分成立（门槛还要求：创建、成交、翻转出的反向单、取消都能从链上读出）。');
  } else if (r.signFlipped) {
    say('  诊断：Trade.isBuy 的含义可能与假设相反（符号反了）。');
  } else {
    say('  诊断：差额来源未知（手续费/舍入/漏事件），把整段贴给我。');
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
  say(`Flip Garden 实测脚本（Kuru / Monad 主网）

  node scripts/gate.cjs preflight                 只读预检：链、市场、模拟下单、钱包
  node scripts/gate.cjs deposit --usdc 6 [--live] 授权并存入保证金账户
  node scripts/gate.cjs plant [--orders 1] [--size-mon 201] [--spread-bps 10] [--live]
                                                   下翻转买单（先模拟；--live 才真下）
  node scripts/gate.cjs status [--watch] [--interval 20]
                                                   看订单、成交、余额；--watch 持续盯盘
  node scripts/gate.cjs unwind [--live]            撤掉所有活跃订单并提现
  node scripts/gate.cjs report                     对账报告（贴给我）

  通用：--yes 跳过交互确认（不建议）。私钥只从环境变量 PRIVATE_KEY 读取。`);
}

// ---------------------------------------------------------------- main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'help';
  if (args.market && args.market !== true) {
    if (!cfg.markets[args.market]) die(`config 里没有市场 ${args.market}。`);
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
  console.error(`\n❌ 未预期的错误：${errMsg(e)}\n`);
  process.exit(1);
});
