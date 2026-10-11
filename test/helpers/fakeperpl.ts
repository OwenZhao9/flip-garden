// A fake Monad chain that behaves like just enough of the Perpl exchange and AUSD for the hedge flow: one MON market
// with a bid and an ask side, accounts, one short position per account, immediate-or-cancel orders, collateral and fees
// following the rules measured on the real exchange (docs/PERPL-ONCHAIN.md). Used by the tests and by web/fake-hedge.html.
// Nothing here signs anything or talks to a network: the fake wallet only applies a transaction to this in-memory state.
import { EVENT_TOPICS } from '../../src/perpl/events.ts';
import { selector } from '../../src/perpl/abi.ts';
import { CHAIN } from '../../src/plant.ts';
import { SEL, decodeApprove, decodeExecOrders, decodeUintCall, PERPL } from '../../src/perpl/guard.ts';

const lc = (s: string): string => s.toLowerCase();
const w32 = (x: bigint | number | boolean): string => {
  let v = BigInt(typeof x === 'boolean' ? (x ? 1 : 0) : x);
  if (v < 0n) v += 1n << 256n;
  return v.toString(16).padStart(64, '0');
};
const aw = (a: string): string => lc(a).replace(/^0x/, '').padStart(64, '0');
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export class RpcError extends Error {
  code: number;
  data?: string;
  constructor(message: string, code = 3, data?: string) {
    super(message);
    this.code = code;
    this.data = data;
  }
}
const revert = (name: string): RpcError => new RpcError('execution reverted', 3, selector(`${name}()`));

type Pos = { type: number; deposit: bigint; price: bigint; lot: bigint; entryBlock: bigint; premium: bigint };
type Acct = { id: bigint; address: string; balance: bigint; locked: bigint; frozen: number; pos: Pos | null };
type State = {
  block: number; walletMon: bigint; walletAusd: bigint; allowance: bigint; accounts: Acct[]; nextId: bigint; txCount: number;
  bids: { price: bigint; lot: bigint }[]; asks: { price: bigint; lot: bigint }[]; mark: bigint;
};
export type Log = { address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string; logIndex: string };
type RawLog = Omit<Log, 'blockNumber' | 'transactionHash' | 'logIndex'>;

export type FakePerplOptions = {
  halted?: boolean;
  minOpen?: bigint;
  rate?: bigint; // funding rate per event, hundred-thousandths
  fundingOnClose?: bigint; // CNS credited (+) or charged (-) to a short when it closes
  failWith?: string; // every state-changing simulation reverts with this error name
  dropFillEvent?: boolean; // the open transaction forgets its PositionOpenedV2 event (to test "cannot explain")
  skewDeposit?: bigint; // the exchange locks this many raw units more than the event says
  liquidityAfterSim?: bigint; // the real transaction finds only this many lots on the book although the simulation filled everything (0 = nothing)
};

export class FakePerplChain {
  s: State;
  opts: FakePerplOptions = {};
  chainIdHex = '0x8f';
  readonly user: string;
  calls: { method: string; params: unknown[] }[] = [];
  private receipts = new Map<string, Record<string, unknown>>();
  private mining = false;

  constructor(user: string) {
    this.user = lc(user);
    this.s = {
      block: 112_400_000, walletMon: 5n * 10n ** 18n, walletAusd: 20_000_000n, allowance: 0n, accounts: [], nextId: 5000n, txCount: 0,
      bids: [{ price: 25_250n, lot: 800n }, { price: 25_240n, lot: 5_000n }, { price: 25_200n, lot: 50_000n }],
      asks: [{ price: 25_293n, lot: 800n }, { price: 25_300n, lot: 5_000n }, { price: 25_350n, lot: 50_000n }],
      mark: 25_283n, kuruMon: 0n,
    };
  }

  get acct(): Acct | undefined {
    return this.s.accounts.find((a) => a.address === this.user);
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

  private handle(method: string, params: unknown[]): unknown {
    this.calls.push({ method, params });
    switch (method) {
      case 'eth_chainId':
        return this.chainIdHex;
      case 'eth_blockNumber':
        return '0x' + this.s.block.toString(16);
      case 'eth_gasPrice':
        return '0x' + (100n * 10n ** 9n).toString(16);
      case 'eth_getBalance':
        return '0x' + this.s.walletMon.toString(16);
      case 'eth_getTransactionReceipt':
        return this.receipts.get(params[0] as string) ?? null;
      case 'eth_estimateGas': {
        this.run(params[0] as Tx, false);
        return '0x' + (200_000).toString(16);
      }
      case 'eth_call':
        return this.ethCall(params[0] as Tx);
      case 'debug_traceCall': {
        const r = this.run(params[0] as Tx, false);
        return { type: 'CALL', from: (params[0] as Tx).from, to: (params[0] as Tx).to, calls: [], logs: r.logs };
      }
      default:
        throw new RpcError(`method not supported by the fake chain: ${method}`, -32601);
    }
  }

  // ---- views --------------------------------------------------------------------------------------------------
  private ethCall(tx: Tx): string {
    const to = lc(tx.to);
    const sel = tx.data.slice(0, 10);
    const arg = (i: number): bigint => BigInt('0x' + tx.data.slice(10 + i * 64, 10 + (i + 1) * 64));
    const s = this.s;
    if (to === lc(PERPL.ausd)) {
      if (sel === selector('balanceOf(address)')) return '0x' + w32(s.walletAusd);
      if (sel === selector('allowance(address,address)')) return '0x' + w32(s.allowance);
    }
    if (to === lc(CHAIN.marginAccount) && sel === selector('getBalance(address,address)')) return '0x' + w32(arg(1) === 0n ? s.kuruMon : 0n); // Kuru margin account: MON free at Kuru
    if (to === lc(PERPL.exchange)) {
      const acctOf = (a: bigint): Acct | undefined => s.accounts.find((x) => x.id === a);
      switch (sel) {
        case selector('getAccountByAddr(address)'): {
          const a = s.accounts.find((x) => x.address === '0x' + arg(0).toString(16).padStart(40, '0'));
          if (!a) throw revert('AccountDoesNotExist');
          return this.encodeAccount(a);
        }
        case selector('getPositionV2(uint256,uint256)'): {
          const a = acctOf(arg(1));
          if (!a?.pos) throw revert('PositionDoesNotExist');
          return this.encodePosition(a);
        }
        case selector('getPerpetualInfoV2(uint256)'):
          return this.encodePerp();
        case selector('getPerpOrderLocks(uint256,uint256)'):
          return '0x' + w32(0x20) + w32(0);
        case selector('getMinAccountOpenCNS()'):
          return '0x' + w32(this.opts.minOpen ?? 10_000_000n);
        case selector('getMarginFractions(uint256,uint256)'):
          return '0x' + [1000n, 2000n, 1000n, 1_000_000_000n, 0n, 0n].map(w32).join('');
        case selector('getTakerFee(uint256)'):
          return '0x' + w32(345);
        case selector('getMakerFee(uint256)'):
          return '0x' + w32(45);
        case selector('getContractVersion()'):
          return '0x' + [1n, 7n, 5n].map(w32).join('');
        case selector('isHalted()'):
          return '0x' + w32(this.opts.halted ?? false);
        case selector('getFundingSumAtBlock(uint256,uint256)'):
          return '0x' + w32(arg(1) > BigInt(s.block - 100_000) ? 76_484 : 76_900) + w32(s.block - 400);
      }
    }
    if (sel === SEL.approve || sel === SEL.createAccount || sel === SEL.withdrawCollateral || sel === SEL.execOrders) {
      this.run(tx, false);
      return '0x';
    }
    throw new RpcError(`unsupported eth_call ${sel} to ${to}`, -32601);
  }

  private encodeAccount(a: Acct): string {
    const bank0 = a.pos ? 1n << 10n : 0n;
    return '0x' + [a.id, a.balance, a.locked, BigInt(a.frozen), BigInt(a.address), bank0, 0n, 0n, 0n].map(w32).join('');
  }
  private encodePosition(a: Acct): string {
    const p = a.pos!;
    const pnl = (p.price - this.s.mark) * p.lot;
    return '0x' + [a.id, 0n, 0n, BigInt(p.type), p.deposit, p.price, p.lot, p.entryBlock, pnl, pnl, p.premium, 0n, this.s.mark, 1n].map(w32).join('');
  }
  private encodePerp(): string {
    const s = this.s;
    const slot: Record<string, bigint> = {
      priceDecimals: 6n, lotDecimals: 0n, priceTolPer100K: 1000n, markPNS: s.mark, oraclePNS: s.mark - 3n, fundingStartBlock: 55_077_246n, fundingRatePct100k: this.opts.rate ?? -4n,
      absFundingClampPctPer100K: 10n, status: 1n, basePricePNS: 19_000n, maxBidPriceONS: (s.bids[0]?.price ?? 19_000n) - 19_000n, minBidPriceONS: 850n,
      maxAskPriceONS: 17_980n, minAskPriceONS: (s.asks[0]?.price ?? 19_000n) - 19_000n, numOrders: 1200n, fundingSumScalingExp: 2n,
    };
    const names = ['name', 'symbol', 'priceDecimals', 'lotDecimals', 'linkFeedId', 'priceTolPer100K', 'marginTol', 'marginTolDecimals', 'refPriceMaxAgeSec',
      'positionBalanceCNS', 'insuranceBalanceCNS', 'markPNS', 'markTimestamp', 'lastPNS', 'lastTimestamp', 'oraclePNS', 'oracleTimestampSec',
      'longOpenInterestLNS', 'shortOpenInterestLNS', 'fundingStartBlock', 'fundingRatePct100k', 'absFundingClampPctPer100K', 'status', 'basePricePNS',
      'maxBidPriceONS', 'minBidPriceONS', 'maxAskPriceONS', 'minAskPriceONS', 'numOrders', 'ignOracle', 'fundingSumScalingExp'];
    return '0x' + w32(0x20) + names.map((n) => w32(slot[n] ?? 0n)).join('');
  }

  // ---- execution ----------------------------------------------------------------------------------------------
  private ev(name: keyof typeof EVENT_TOPICS, ...vals: (bigint | number | boolean)[]): RawLog {
    return { address: PERPL.exchange, topics: [EVENT_TOPICS[name]], data: '0x' + vals.map(w32).join('') };
  }
  private transfer(from: string, to: string, amount: bigint): RawLog {
    return { address: PERPL.ausd, topics: [TRANSFER, '0x' + aw(from), '0x' + aw(to)], data: '0x' + w32(amount) };
  }

  // Executes a state-changing call. `commit` = apply it (a mined transaction); otherwise a simulation on a copy.
  private run(tx: Tx, commit: boolean): { logs: RawLog[] } {
    if (this.opts.failWith) throw revert(this.opts.failWith);
    if (!commit) {
      const saved = structuredClone(this.s);
      try {
        return this.apply(tx);
      } finally {
        this.s = saved;
      }
    }
    return this.apply(tx);
  }

  private apply(tx: Tx): { logs: RawLog[] } {
    const s = this.s;
    const from = lc(tx.from);
    if (from !== this.user) throw new RpcError('unknown sender');
    const to = lc(tx.to);
    const logs: RawLog[] = [];
    const sel = tx.data.slice(0, 10);
    if (to === lc(PERPL.ausd) && sel === SEL.approve) {
      s.allowance = decodeApprove(tx.data)!.amount;
      return { logs };
    }
    if (to !== lc(PERPL.exchange)) throw new RpcError('wrong target');
    const acct = this.acct;
    if (sel === SEL.createAccount) {
      const amount = decodeUintCall(tx.data, SEL.createAccount)!;
      if (acct) throw revert('AccountExists');
      if (amount < (this.opts.minOpen ?? 10_000_000n)) throw revert('InsufficentAmountToOpenAccount');
      if (s.allowance < amount) throw revert('ERC20InsufficientAllowance');
      if (s.walletAusd < amount) throw revert('ERC20InsufficientBalance');
      s.allowance -= amount;
      s.walletAusd -= amount;
      const a: Acct = { id: s.nextId++, address: from, balance: amount, locked: 0n, frozen: 0, pos: null };
      s.accounts.push(a);
      logs.push(this.transfer(from, PERPL.exchange, amount), this.ev('AccountCreated', BigInt(from), a.id), this.ev('CollateralDeposit', a.id, amount, amount));
      return { logs };
    }
    if (sel === SEL.withdrawCollateral) {
      const amount = decodeUintCall(tx.data, SEL.withdrawCollateral)!;
      if (!acct) throw revert('AccountDoesNotExist');
      if (amount > acct.balance) throw revert('AmountExceedsAvailableBalance');
      acct.balance -= amount;
      s.walletAusd += amount;
      logs.push(this.transfer(PERPL.exchange, from, amount), this.ev('CollateralWithdrawal', acct.id, amount, acct.balance));
      return { logs };
    }
    if (sel === SEL.execOrders) {
      if (!acct) throw revert('AccountDoesNotExist');
      const c = decodeExecOrders(tx.data)!;
      for (const d of c.orders) logs.push(...this.order(acct, d));
      return { logs };
    }
    throw new RpcError('unsupported');
  }

  private order(acct: Acct, d: NonNullable<ReturnType<typeof decodeExecOrders>>['orders'][number]): RawLog[] {
    const s = this.s;
    const out: RawLog[] = [];
    out.push({
      address: PERPL.exchange, topics: [EVENT_TOPICS.OrderRequestV2],
      data: '0x' + [d.perpId, acct.id, d.orderDescId, d.orderId, BigInt(d.orderType), d.pricePNS, d.lotLNS, d.expiryBlock, d.postOnly, d.fillOrKill, d.immediateOrCancel, d.maxMatches, d.leverageHdths, d.lastExecutionBlock, d.amountCNS, d.maxNegPnlCollatBPS, 7_000_000n, 0x240n, 0n].map(w32).join(''),
    });
    const book = d.orderType === 1 ? s.bids : s.asks;
    const room = this.mining && this.opts.liquidityAfterSim !== undefined ? this.opts.liquidityAfterSim : null;
    if (d.lastExecutionBlock < BigInt(s.block)) {
      out.push(this.ev('OrderBatchCompleted', 7_000_000n));
      return out; // past its deadline: the exchange skips the request
    }
    let left = room !== null && room < d.lotLNS ? room : d.lotLNS;
    let value = 0n;
    let filled = 0n;
    const used: { price: bigint; lot: bigint }[] = [];
    for (const lvl of book) {
      if (left === 0n) break;
      const ok = d.orderType === 1 ? lvl.price >= d.pricePNS : lvl.price <= d.pricePNS;
      if (!ok) break;
      const take = lvl.lot < left ? lvl.lot : left;
      value += take * lvl.price;
      filled += take;
      left -= take;
      used.push({ price: lvl.price, lot: take });
    }
    if (filled === 0n) {
      out.push(this.ev('OrderBatchCompleted', 7_000_000n));
      return out;
    }
    const avg = value / filled;
    const fee = ceilDiv(value * 345n, 1_000_000n);
    if (d.orderType === 1) {
      if (acct.pos) throw revert('PositionExists');
      const initial = ceilDiv(value * 100n, d.leverageHdths);
      let extra = s.mark > avg ? (s.mark - avg) * filled : 0n;
      if (extra * 10_000n > value * d.maxNegPnlCollatBPS) extra = (value * d.maxNegPnlCollatBPS) / 10_000n;
      const deposit = initial + extra;
      if (acct.balance < deposit + fee) throw revert('TakerOrderSettlementFailed');
      acct.balance -= deposit + fee + (this.opts.skewDeposit ?? 0n);
      acct.pos = { type: 1, deposit, price: avg, lot: filled, entryBlock: BigInt(s.block), premium: 0n };
      if (!(this.mining && this.opts.dropFillEvent)) out.push(this.ev('PositionOpenedV2', d.perpId, acct.id, 1n, d.leverageHdths, deposit, extra, avg, filled, 131n, 740n, 0n));
      out.push(this.ev('TakerOrderFilledV2', avg, avg, avg, filled, fee, -(deposit + fee), acct.balance, 0n, 0n));
    } else {
      const p = acct.pos;
      if (!p) throw revert('CloseOrderExceedsPosition');
      if (filled > p.lot) throw revert('CloseOrderExceedsPosition');
      const pnl = (p.price * filled - value);
      const funding = this.opts.fundingOnClose ?? 0n;
      const released = (p.deposit * filled) / p.lot;
      const returned = released + pnl + funding - fee;
      acct.balance += returned;
      if (filled === p.lot) {
        acct.pos = null;
        out.push(this.ev('PositionClosed', d.perpId, acct.id, 1n, avg, pnl, funding));
      } else {
        const before = p.lot;
        p.lot -= filled;
        p.deposit -= released;
        out.push(this.ev('PositionDecreased', d.perpId, acct.id, 1n, p.deposit + released, p.deposit, before, p.lot, pnl, funding));
      }
      out.push(this.ev('TakerOrderFilledV2', avg, avg, avg, filled, fee, returned, acct.balance, 0n, 0n));
    }
    out.push(this.ev('OrderBatchCompleted', 7_000_000n));
    return out;
  }

  // Called by the fake wallet when the (fake) user confirms a transaction.
  mine(tx: { from: string; to: string; data: string; gas?: string }): string {
    const s = this.s;
    s.block += 1;
    const hash = '0x' + w32(++s.txCount);
    let logs: RawLog[] = [];
    let status = '0x1';
    this.mining = true;
    try {
      logs = this.run({ ...tx, value: '0x0' }, true).logs;
    } catch {
      status = '0x0';
    }
    this.mining = false;
    const gas = BigInt(tx.gas ?? '0x30d40');
    s.walletMon -= gas * 100n * 10n ** 9n;
    const full = logs.map((l, i) => ({ ...l, blockNumber: '0x' + s.block.toString(16), transactionHash: hash, logIndex: '0x' + i.toString(16) }));
    this.receipts.set(hash, { status, blockNumber: '0x' + s.block.toString(16), gasUsed: '0x' + gas.toString(16), effectiveGasPrice: '0x' + (100n * 10n ** 9n).toString(16), from: tx.from, logs: full });
    return hash;
  }
}

type Tx = { from: string; to: string; data: string; value?: string };
