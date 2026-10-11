// A fake Monad chain (just enough of Kuru's MarginAccount, OrderBook and USDC) plus a fake EIP-1193 wallet.
// Used by the tests and by web/fake.html. Nothing here signs anything or talks to a network: the wallet records
// every request it receives, and "sending" a transaction only applies it to the in-memory chain.
import { SELECTORS, decodeCall, selector } from '../../src/abi.ts';
import { TOPICS } from '../../src/events.ts';
import { CHAIN } from '../../src/plant.ts';

const lc = (s: string): string => s.toLowerCase();
const w32 = (x: bigint | number | boolean): string => BigInt(typeof x === 'boolean' ? (x ? 1 : 0) : x).toString(16).padStart(64, '0');
const aw = (a: string): string => lc(a).replace(/^0x/, '').padStart(64, '0');
const ZERO = '0x0000000000000000000000000000000000000000';

export class RpcError extends Error {
  code: number;
  data?: string;
  constructor(message: string, code = 3, data?: string) {
    super(message);
    this.code = code;
    this.data = data;
  }
}
const kuruError = (name: string): RpcError => new RpcError('execution reverted', 3, selector(`${name}()`));
const stringError = (msg: string): RpcError => {
  const bytes = [...new TextEncoder().encode(msg)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return new RpcError('execution reverted', 3, '0x08c379a0' + w32(32) + w32(msg.length) + bytes.padEnd(Math.ceil(bytes.length / 64) * 64, '0'));
};

type Order = { owner: string; size: bigint; price: bigint; flip: bigint; isBuy: boolean };
type Log = { address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string; logIndex: string };

export type FakeOptions = {
  failWith?: string; // every simulation of a state-changing call reverts with this Kuru error name
  dropFlipEvent?: boolean; // the plant transaction "forgets" to emit one FlipOrderCreated (to test "cannot explain")
  shortDeposit?: bigint; // credit this many raw units less than deposited
};

export class FakeChain {
  block = 112_300_000;
  walletMon = 5n * 10n ** 18n;
  walletUsdc = 20_000_000n;
  allowance = 0n;
  marginUsdc = 0n;
  marginMon = 0n;
  bestBid = 2_476_000n; // 0.02476 USDC per MON in price-precision units (1e8)
  bestAsk = 2_476_500n;
  chainIdHex = '0x8f';
  opts: FakeOptions = {};
  orders = new Map<bigint, Order>();
  private nextId = 5000n;
  private allLogs: Log[] = [];
  private txs = new Map<string, Record<string, unknown>>();
  private receipts = new Map<string, Record<string, unknown>>();
  private txCount = 0;
  // block timestamps: 0.4 s per block from a fixed origin, plus an optional jump from some block on (to age the garden)
  timeSkewFromBlock = Number.MAX_SAFE_INTEGER;
  timeSkewSeconds = 0;
  readonly user: string;
  calls: Array<{ method: string; params: unknown[] }> = [];

  constructor(user: string) {
    this.user = lc(user);
  }

  fetch = async (_url: string, init: { body: string }): Promise<{ json(): Promise<unknown> }> => {
    const { id, method, params } = JSON.parse(init.body);
    try {
      const result = this.handle(method, params);
      return { json: async () => ({ jsonrpc: '2.0', id, result }) };
    } catch (e) {
      const err = e as RpcError;
      return { json: async () => ({ jsonrpc: '2.0', id, error: { code: err.code ?? -32000, message: err.message, data: err.data } }) };
    }
  };

  private quote(size: bigint, price: bigint, up: boolean): bigint {
    const p = size * price * 10n ** 6n;
    const d = 10n ** 10n * 10n ** 8n;
    return up && p % d !== 0n ? p / d + 1n : p / d;
  }
  private baseOf(size: bigint): bigint {
    return (size * 10n ** 18n) / 10n ** 10n;
  }

  private handle(method: string, params: unknown[]): unknown {
    this.calls.push({ method, params });
    switch (method) {
      case 'eth_chainId':
        return this.chainIdHex;
      case 'eth_blockNumber':
        return '0x' + this.block.toString(16);
      case 'eth_getBlockByNumber': {
        const b = params[0] === 'latest' ? this.block : Number(BigInt(params[0] as string));
        return { number: '0x' + b.toString(16), timestamp: '0x' + this.timestampOf(b).toString(16) };
      }
      case 'eth_gasPrice':
        return '0x' + (100n * 10n ** 9n).toString(16);
      case 'eth_getBalance':
        return '0x' + this.walletMon.toString(16);
      case 'eth_getLogs': {
        const f = params[0] as { address?: string; topics?: Array<string | string[] | null>; fromBlock: string; toBlock: string };
        const from = Number(BigInt(f.fromBlock));
        const to = Number(BigInt(f.toBlock));
        const t0 = f.topics?.[0];
        const wanted = t0 === undefined || t0 === null ? null : Array.isArray(t0) ? t0 : [t0];
        return this.allLogs.filter((l) => {
          const b = Number(BigInt(l.blockNumber));
          return b >= from && b <= to && (!f.address || lc(f.address) === lc(l.address)) && (!wanted || wanted.includes(l.topics[0]));
        });
      }
      case 'eth_getTransactionByHash':
        return this.txs.get(params[0] as string) ?? null;
      case 'eth_getTransactionReceipt':
        return this.receipts.get(params[0] as string) ?? null;
      case 'eth_estimateGas': {
        const tx = params[0] as { from: string; to: string; data: string };
        this.execute(tx, true);
        return '0x' + (200_000).toString(16);
      }
      case 'eth_call': {
        const tx = params[0] as { from?: string; to: string; data: string };
        return this.ethCall(tx, params.length > 2);
      }
      default:
        throw new RpcError(`method not supported by the fake chain: ${method}`, -32601);
    }
  }

  private ethCall(tx: { from?: string; to: string; data: string }, overrides = false): string {
    const sel = tx.data.slice(0, 10);
    const to = lc(tx.to);
    const arg = (i: number): bigint => BigInt('0x' + tx.data.slice(10 + i * 64, 10 + (i + 1) * 64));
    if (to === lc(CHAIN.usdc) && sel === SELECTORS.balanceOf) return '0x' + w32(this.walletUsdc);
    if (to === lc(CHAIN.usdc) && sel === SELECTORS.allowance) return '0x' + w32(this.allowance);
    if (to === lc(CHAIN.marginAccount) && sel === SELECTORS.getBalance) return '0x' + w32(arg(1) === 0n ? this.marginMon : this.marginUsdc);
    if (to === lc(CHAIN.market) && sel === SELECTORS.bestBidAsk) return '0x' + w32(this.bestBid * 10n ** 10n) + w32(this.bestAsk * 10n ** 10n);
    if (to === lc(CHAIN.market) && sel === SELECTORS.getMarketParams) {
      return '0x' + [10n ** 8n, 10n ** 10n, BigInt(ZERO), 18n, BigInt(CHAIN.usdc), 6n, 100n, 200n * 10n ** 10n, 2n * 10n ** 18n, 0n, 0n].map((x) => w32(x)).join('');
    }
    if (to === lc(CHAIN.market) && sel === SELECTORS.s_orders) {
      const o = this.orders.get(arg(0));
      return '0x' + (o ? [BigInt(o.owner), o.size, 0n, 0n, 0n, o.price, o.flip, o.isBuy ? 1n : 0n] : [0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n]).map((x) => w32(x)).join('');
    }
    if (decodeCall(tx.data)) {
      this.execute({ from: tx.from ?? this.user, to: tx.to, data: tx.data }, true, [], overrides);
      return '0x';
    }
    throw new RpcError(`unsupported eth_call ${sel} to ${to}`, -32601);
  }

  // Applies a state-changing call. dryRun = simulate only (reverts exactly like the real call would).
  // `pretend` = the simulation carries state overrides (a throwaway sender with pretend funds).
  private execute(tx: { from: string; to: string; data: string }, dryRun: boolean, logs: Omit<Log, 'blockNumber' | 'transactionHash' | 'logIndex'>[] = [], pretend = false): void {
    const call = decodeCall(tx.data);
    if (!call) throw new RpcError('unknown function');
    if (this.opts.failWith && !['approve'].includes(call.name)) throw kuruError(this.opts.failWith);
    if (!pretend && lc(tx.from) !== this.user) throw new RpcError('unknown sender');
    const to = lc(tx.to);
    const a = call.args;
    const emit = (address: string, name: keyof typeof TOPICS, data: string): void => {
      logs.push({ address, topics: [TOPICS[name]], data });
    };
    switch (call.name) {
      case 'approve': {
        if (to !== lc(CHAIN.usdc)) throw new RpcError('wrong target');
        if (!dryRun) this.allowance = a[1] as bigint;
        return;
      }
      case 'deposit': {
        const amount = a[2] as bigint;
        if (this.allowance < amount) throw stringError('ERC20: insufficient allowance');
        if (this.walletUsdc < amount) throw stringError('ERC20: transfer amount exceeds balance');
        if (!dryRun) {
          this.allowance -= amount;
          this.walletUsdc -= amount;
          this.marginUsdc += amount - (this.opts.shortDeposit ?? 0n);
          emit(CHAIN.marginAccount, 'Deposit', w32(BigInt(this.user)) + aw(CHAIN.usdc) + w32(amount));
        }
        return;
      }
      case 'batchProvisionLiquidity': {
        const [prices, flips, sizes, isBuy, revertOnCross] = a as [bigint[], bigint[], bigint[], boolean[], boolean];
        let need = 0n;
        const accepted: number[] = [];
        prices.forEach((p, i) => {
          if (sizes[i] < 200n * 10n ** 10n) throw kuruError('SizeError');
          if (p % 100n !== 0n || flips[i] % 100n !== 0n) throw kuruError('TickSizeError');
          if (flips[i] <= p) throw kuruError('PriceError');
          if (isBuy[i] && p >= this.bestAsk) {
            if (revertOnCross) throw kuruError('ProvisionError');
            return;
          }
          accepted.push(i);
          need += this.quote(sizes[i], p, true);
        });
        if (!pretend && need > this.marginUsdc) throw kuruError('InsufficientBalance');
        if (dryRun) return;
        this.marginUsdc -= need;
        accepted.forEach((i, n) => {
          const id = this.nextId++;
          this.orders.set(id, { owner: this.user, size: sizes[i], price: prices[i], flip: flips[i], isBuy: true });
          if (this.opts.dropFlipEvent && n === 0) return;
          emit(CHAIN.market, 'FlipOrderCreated', [id, 0n, BigInt(this.user), sizes[i], prices[i], flips[i], 1n].map((x) => w32(x)).join(''));
        });
        return;
      }
      case 'batchCancelFlipOrders': {
        const ids = a[0] as bigint[];
        for (const id of ids) {
          const o = this.orders.get(id);
          if (!o || o.size === 0n || lc(o.owner) !== this.user) throw kuruError('OrderAlreadyFilledOrCancelled');
        }
        if (dryRun) return;
        for (const id of ids) {
          const o = this.orders.get(id)!;
          if (o.isBuy) this.marginUsdc += this.quote(o.size, o.price, true);
          else this.marginMon += this.baseOf(o.size);
          o.size = 0n;
        }
        emit(CHAIN.market, 'FlipOrdersCanceled', w32(64) + w32(BigInt(this.user)) + w32(ids.length) + ids.map((x) => w32(x)).join(''));
        return;
      }
      case 'batchWithdrawMaxTokens': {
        const tokens = a[0] as string[];
        if (dryRun) {
          if (tokens.length === 0) throw kuruError('LengthMismatch');
          return;
        }
        for (const t of tokens) {
          const native = lc(t) === ZERO;
          const amt = native ? this.marginMon : this.marginUsdc;
          if (native) {
            this.walletMon += amt;
            this.marginMon = 0n;
          } else {
            this.walletUsdc += amt;
            this.marginUsdc = 0n;
          }
          emit(CHAIN.marginAccount, 'Withdrawal', w32(BigInt(this.user)) + aw(t) + w32(amt));
        }
        return;
      }
      default:
        throw new RpcError('unsupported');
    }
  }

  // Called by the fake wallet when the (fake) user confirms a transaction. Returns its hash.
  mine(tx: { from: string; to: string; data: string; gas?: string }): string {
    this.block += 1;
    const hash = '0x' + w32(++this.txCount);
    const logs: Omit<Log, 'blockNumber' | 'transactionHash' | 'logIndex'>[] = [];
    let status = '0x1';
    try {
      this.execute(tx, false, logs);
    } catch {
      status = '0x0';
    }
    const gas = BigInt(tx.gas ?? '0x30d40');
    this.walletMon -= gas * 100n * 10n ** 9n;
    const full = logs.map((l, i) => ({ ...l, blockNumber: '0x' + this.block.toString(16), transactionHash: hash, logIndex: '0x' + i.toString(16) }));
    this.allLogs.push(...full);
    this.txs.set(hash, { hash, from: tx.from, to: tx.to, gas: '0x' + gas.toString(16) });
    this.receipts.set(hash, {
      status,
      blockNumber: '0x' + this.block.toString(16),
      gasUsed: '0x' + gas.toString(16),
      effectiveGasPrice: '0x' + (100n * 10n ** 9n).toString(16),
      from: tx.from,
      logs: full,
    });
    return hash;
  }

  timestampOf(block: number): number {
    return 1_790_000_000 + Math.floor((block * 2) / 5) + (block >= this.timeSkewFromBlock ? this.timeSkewSeconds : 0);
  }

  // Test and demo helper: the garden is `seconds` older from the next block on (mines one empty block).
  ageBy(seconds: number): void {
    this.block += 1;
    this.timeSkewFromBlock = this.block;
    this.timeSkewSeconds += seconds;
  }

  // Test and demo helper: a taker fills `take` of one of our orders (all of it by default), in its own transaction, with
  // the events Kuru emits: Trade, and FlippedOrderCreated for the opposite order (a sell after a bid, a bid after a sell,
  // sized as on mainnet). Returns the new order's id. A partly filled order stays on the book with what is left.
  fillOrder(id: bigint, take?: bigint): bigint {
    const o = this.orders.get(id);
    if (!o || o.size === 0n) throw new Error(`order ${id} is not resting`);
    const filled = take === undefined || take > o.size ? o.size : take;
    const newSize = o.isBuy ? filled : (filled * o.price) / o.flip;
    const next = this.nextId++;
    this.orders.set(next, { owner: o.owner, size: newSize, price: o.flip, flip: o.price, isBuy: !o.isBuy });
    o.size -= filled;
    this.block += 1;
    const hash = '0x' + w32(++this.txCount);
    const at = { blockNumber: '0x' + this.block.toString(16), transactionHash: hash };
    const taker = '0x' + 'ab'.repeat(20);
    this.allLogs.push(
      { address: CHAIN.market, topics: [TOPICS.Trade], data: [id, BigInt(this.user), o.isBuy ? 0n : 1n, o.price * 10n ** 10n, o.size, BigInt(taker), BigInt(taker), filled].map((x) => w32(x)).join(''), ...at, logIndex: '0x0' },
      { address: CHAIN.market, topics: [TOPICS.FlippedOrderCreated], data: [next, 0n, BigInt(this.user), newSize, o.flip, o.price, o.isBuy ? 0n : 1n].map((x) => w32(x)).join(''), ...at, logIndex: '0x1' },
    );
    return next;
  }

  // Test helper: a taker hits one of our bids completely; the opposite sell appears under a new id (as on mainnet).
  fillBid(id: bigint): bigint {
    const o = this.orders.get(id)!;
    const sell = this.nextId++;
    this.orders.set(sell, { owner: o.owner, size: o.size, price: o.flip, flip: o.price, isBuy: false });
    o.size = 0n;
    this.block += 1;
    const hash = '0x' + w32(++this.txCount);
    this.allLogs.push({
      address: CHAIN.market,
      topics: [TOPICS.FlippedOrderCreated],
      data: [sell, 0n, BigInt(this.user), o.size === 0n ? this.orders.get(sell)!.size : 0n, o.flip, o.price, 0n].map((x) => w32(x)).join(''),
      blockNumber: '0x' + this.block.toString(16),
      transactionHash: hash,
      logIndex: '0x0',
    });
    return sell;
  }
}

export type RequestRecord = { method: string; params?: unknown[] };

export class FakeWallet {
  requests: RequestRecord[] = [];
  chainIdHex = '0x8f';
  accounts: string[];
  rejectNext = false;
  knowsMonad = true;
  switchRejected = false;
  chain: FakeChain;
  constructor(chain: FakeChain, account: string) {
    this.chain = chain;
    this.accounts = [account];
  }

  async request(args: RequestRecord): Promise<unknown> {
    this.requests.push(args);
    const p = args.params ?? [];
    switch (args.method) {
      case 'eth_requestAccounts':
      case 'eth_accounts':
        return this.accounts;
      case 'eth_chainId':
        return this.chainIdHex;
      case 'wallet_switchEthereumChain':
        if (this.switchRejected) throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
        if (!this.knowsMonad) throw Object.assign(new Error('Unrecognized chain ID'), { code: 4902 });
        this.chainIdHex = '0x8f';
        this.chain.chainIdHex = '0x8f';
        return null;
      case 'wallet_addEthereumChain':
        this.knowsMonad = true;
        this.chainIdHex = '0x8f';
        return null;
      case 'eth_sendTransaction': {
        if (this.rejectNext) {
          this.rejectNext = false;
          throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
        }
        return this.chain.mine(p[0] as { from: string; to: string; data: string; gas?: string });
      }
      default:
        throw Object.assign(new Error(`the fake wallet does not support ${args.method}`), { code: -32601 });
    }
  }

  // Everything the page ever asked the wallet to do, by method.
  methods(): string[] {
    return this.requests.map((r) => r.method);
  }
}

