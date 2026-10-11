// The allow-list for the Perpl hedge: the only five transactions this page will offer to a wallet for Perpl, each
// checked by decoding its own calldata. Pure functions, no I/O. src/plant.ts guardTx delegates here for these kinds, so
// the same guard sits in front of every sendStep. A planner bug therefore cannot slip a different call through.
//
// What is allowed (docs/STAGE-D3-PHASE2-BRIEF.md):
//   perplApprove   AUSD.approve(exchange, amount), 0 < amount <= 15 AUSD (never unlimited)
//   perplCreate    exchange.createAccount(amount), 0 < amount <= 15 AUSD (and >= the minimum read live, see below)
//   perplOpen      exchange.execOrders([one OpenShort on market 10, immediate-or-cancel], revertOnFail = true),
//                  notional at the order's price bound <= 15 AUSD, leverage <= 2x, a deadline block set
//   perplClose     exchange.execOrders([one CloseShort on market 10, immediate-or-cancel], revertOnFail = true)
//   perplWithdraw  exchange.withdrawCollateral(amount); the exchange pays only the caller's own address
// Everything else is refused: other targets, other markets, longs, resting or post-only orders, cancel/change,
// deposits, order forwarding, builder entry points, value.
import { selector, splitWords, wordToAddress, wordToBool, wordToUint } from './abi.ts';
import { AUSD } from '../swapguard.ts';

export const PERPL = {
  exchange: '0x34B6552d57a35a1D042CcAe1951BD1C370112a6F',
  ausd: AUSD,
  perpId: 10n, // the MON perpetual
  maxApproveCNS: 15_000_000n, // 15 AUSD (6 decimals)
  maxDepositCNS: 15_000_000n,
  maxNotionalCNS: 15_000_000n, // a hedge never exceeds 15 USD of notional
  maxLeverageHdths: 200n, // 2x
  maxNegPnlCollatBPS: 1000n, // the SDK default: extra collateral for a worse-than-mark fill is capped at 10% of notional
  maxWithdrawCNS: 45_000_000n, // deposit cap plus room for profit; the exchange pays only the caller
  maxCloseNotionalCNS: 30_000_000n, // a close may be priced higher than the open: twice the opening cap
  maxMatches: 1000n,
} as const;

export type PerplKind = 'perplApprove' | 'perplCreate' | 'perplOpen' | 'perplClose' | 'perplWithdraw';
export const PERPL_KINDS: readonly PerplKind[] = ['perplApprove', 'perplCreate', 'perplOpen', 'perplClose', 'perplWithdraw'];
export const isPerplKind = (k: string): k is PerplKind => (PERPL_KINDS as readonly string[]).includes(k);

export type PerplTx = { kind: PerplKind; from: string; to: string; data: string; value: string; minDepositCNS?: bigint };

const lc = (s: string): string => s.toLowerCase();
const same = (a: string, b: string): boolean => lc(a) === lc(b);

const ORDER_DESC_TYPE = '(uint256,uint256,uint8,uint256,uint256,uint256,uint256,bool,bool,bool,uint256,uint256,uint256,uint256,uint256)';
export const SEL = {
  approve: selector('approve(address,uint256)'),
  createAccount: selector('createAccount(uint256)'),
  withdrawCollateral: selector('withdrawCollateral(uint256)'),
  execOrders: selector(`execOrders(${ORDER_DESC_TYPE}[],bool)`),
} as const;

export type DecodedDesc = {
  orderDescId: bigint; perpId: bigint; orderType: number; orderId: bigint; pricePNS: bigint; lotLNS: bigint; expiryBlock: bigint;
  postOnly: boolean; fillOrKill: boolean; immediateOrCancel: boolean; maxMatches: bigint; leverageHdths: bigint;
  lastExecutionBlock: bigint; amountCNS: bigint; maxNegPnlCollatBPS: bigint;
};

const words = (data: string, from: number): string[] | null => {
  try {
    return splitWords('0x' + data.slice(from));
  } catch {
    return null;
  }
};

export function decodeApprove(data: string): { spender: string; amount: bigint } | null {
  if (lc(data.slice(0, 10)) !== SEL.approve) return null;
  const w = words(data, 10);
  if (!w || w.length !== 2 || BigInt('0x' + w[0]) >> 160n !== 0n) return null;
  return { spender: wordToAddress(w[0]), amount: wordToUint(w[1]) };
}

export function decodeUintCall(data: string, sel: string): bigint | null {
  if (lc(data.slice(0, 10)) !== sel) return null;
  const w = words(data, 10);
  return w && w.length === 1 ? wordToUint(w[0]) : null;
}

// execOrders(OrderDesc[] orders, bool revertOnFail): head = offset(0x40) + bool, tail = length + 15 words per order.
export function decodeExecOrders(data: string): { revertOnFail: boolean; orders: DecodedDesc[] } | null {
  if (lc(data.slice(0, 10)) !== SEL.execOrders) return null;
  const w = words(data, 10);
  if (!w || w.length < 3 || wordToUint(w[0]) !== 0x40n) return null;
  const flag = wordToUint(w[1]);
  if (flag > 1n) return null;
  const n = Number(wordToUint(w[2]));
  if (!Number.isSafeInteger(n) || n > 32 || w.length !== 3 + 15 * n) return null;
  const orders: DecodedDesc[] = [];
  for (let i = 0; i < n; i++) {
    const t = w.slice(3 + 15 * i, 18 + 15 * i);
    const u = (k: number): bigint => wordToUint(t[k]);
    if (u(7) > 1n || u(8) > 1n || u(9) > 1n || u(2) > 255n) return null; // not canonical booleans / uint8
    orders.push({
      orderDescId: u(0), perpId: u(1), orderType: Number(u(2)), orderId: u(3), pricePNS: u(4), lotLNS: u(5), expiryBlock: u(6),
      postOnly: wordToBool(t[7]), fillOrKill: wordToBool(t[8]), immediateOrCancel: wordToBool(t[9]), maxMatches: u(10), leverageHdths: u(11),
      lastExecutionBlock: u(12), amountCNS: u(13), maxNegPnlCollatBPS: u(14),
    });
  }
  return { revertOnFail: flag === 1n, orders };
}

const ORDER_TYPE_OPEN_SHORT = 1;
const ORDER_TYPE_CLOSE_SHORT = 3;

function guardOrder(tx: PerplTx): string | null {
  const c = decodeExecOrders(tx.data);
  if (!c) return 'Refused: the order call is not the Perpl order call this page knows.';
  if (!same(tx.to, PERPL.exchange)) return 'Refused: orders may only go to the Perpl exchange.';
  if (!c.revertOnFail) return 'Refused: the order must revert as a whole if it fails (so the simulation and the real call agree).';
  if (c.orders.length !== 1) return 'Refused: exactly one order per transaction.';
  const d = c.orders[0];
  const open = tx.kind === 'perplOpen';
  if (d.orderType !== (open ? ORDER_TYPE_OPEN_SHORT : ORDER_TYPE_CLOSE_SHORT)) return open ? 'Refused: only a short can be opened (no longs, cancels or changes).' : 'Refused: only a short can be closed, and only reduce-only.';
  if (d.perpId !== PERPL.perpId) return 'Refused: orders may only be placed on the MON perpetual (market 10).';
  if (!d.immediateOrCancel || d.postOnly || d.fillOrKill) return 'Refused: orders must be immediate-or-cancel (never resting, post-only or fill-or-kill).';
  if (d.orderId !== 0n || d.expiryBlock !== 0n || d.amountCNS !== 0n) return 'Refused: the order carries fields this page never sets.';
  if (d.lotLNS < 1n) return 'Refused: the order size must be at least 1 MON.';
  if (d.pricePNS < 1n) return 'Refused: the order needs a price bound.';
  if (d.leverageHdths < 1n || d.leverageHdths > PERPL.maxLeverageHdths) return 'Refused: leverage must be between 1x hundredth and 2x.';
  if (d.lastExecutionBlock < 1n) return 'Refused: the order needs a deadline block.';
  if (d.maxMatches > PERPL.maxMatches) return 'Refused: too many matches.';
  if (d.maxNegPnlCollatBPS > PERPL.maxNegPnlCollatBPS) return 'Refused: the extra-collateral cap is above 10% of notional.';
  const notional = d.lotLNS * d.pricePNS; // MON x (AUSD x 10^6 per MON) = AUSD x 10^6 = CNS
  if (open && notional > PERPL.maxNotionalCNS) return 'Refused: the hedge notional is above the 15 USD cap.';
  if (!open && notional > PERPL.maxCloseNotionalCNS) return 'Refused: the close order is larger than any hedge this page can open.';
  return null;
}

// Returns a refusal reason or null. `minDepositCNS` (read live from the exchange by the planner) is a floor for account
// creation when the plan carries it; the simulation before the pop-up enforces the contract's own rule regardless.
export function guardPerplTx(tx: PerplTx): string | null {
  if (tx.value !== '0x0') return 'Refused: this page never sends MON along with a call.';
  switch (tx.kind) {
    case 'perplApprove': {
      const a = decodeApprove(tx.data);
      if (!a) return 'Refused: the call is not an approve.';
      if (!same(tx.to, PERPL.ausd)) return 'Refused: Perpl approvals are only allowed on AUSD.';
      if (!same(a.spender, PERPL.exchange)) return 'Refused: AUSD may only be approved to the Perpl exchange.';
      if (a.amount <= 0n || a.amount > PERPL.maxApproveCNS) return 'Refused: the approval must be above 0 and within 15 AUSD (never unlimited).';
      return null;
    }
    case 'perplCreate': {
      const amount = decodeUintCall(tx.data, SEL.createAccount);
      if (amount === null) return 'Refused: the call is not an account creation.';
      if (!same(tx.to, PERPL.exchange)) return 'Refused: accounts are only created on the Perpl exchange.';
      if (amount <= 0n || amount > PERPL.maxDepositCNS) return 'Refused: the first deposit must be above 0 and within 15 AUSD.';
      if (tx.minDepositCNS !== undefined && amount < tx.minDepositCNS) return 'Refused: the first deposit is below the exchange minimum.';
      return null;
    }
    case 'perplOpen':
    case 'perplClose':
      return guardOrder(tx);
    case 'perplWithdraw': {
      const amount = decodeUintCall(tx.data, SEL.withdrawCollateral);
      if (amount === null) return 'Refused: the call is not a withdrawal.';
      if (!same(tx.to, PERPL.exchange)) return 'Refused: withdrawals only come from the Perpl exchange.';
      if (amount <= 0n || amount > PERPL.maxWithdrawCNS) return 'Refused: the withdrawal must be above 0 and within the cap.';
      return null;
    }
  }
}
