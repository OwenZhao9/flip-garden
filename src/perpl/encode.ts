// Calldata encoders for the Perpl exchange and its collateral token. Pure functions: they build
// hex strings and never sign, send or read anything. Verified against ethers in
// test/perpl-encode.test.ts (selectors included), and by eth_call simulation in docs/PERPL-ONCHAIN.md.
//
// Source of the interface: PerplFoundation/dex-sdk, crates/sdk/abi/dex/Exchange.json and
// crates/sdk/src/types/request.rs at commit 78ce8a06e39e2f9288792eba41aca5f3c08c1195.
//
// Units (read them live, see state.ts): price is an integer in 10^priceDecimals of AUSD per
// 1 whole MON (PNS), size is an integer in 10^lotDecimals MON (LNS; lotDecimals is 0 for MON, so
// the size is whole MON), collateral is an integer in 10^6 AUSD (CNS), leverage is in hundredths
// (500 = 5x).
import { addressWord, boolWord, call, uintWord } from './abi.ts';

// Order descriptor `type` field. 0..3 are order primitives, 4..6 operate on a resting order or
// a position (crates/sdk/src/types/request.rs, `RequestType`).
export const ORDER_TYPE = {
  OpenLong: 0,
  OpenShort: 1,
  CloseLong: 2,
  CloseShort: 3,
  Cancel: 4,
  IncreasePositionCollateral: 5,
  Change: 6,
} as const;
export type OrderTypeName = keyof typeof ORDER_TYPE;

export type OrderDesc = {
  orderDescId: bigint; // client request id; the exchange echoes it in OrderRequest
  perpId: bigint;
  orderType: number; // ORDER_TYPE value
  orderId: bigint; // resting order to cancel/change; 0 otherwise
  pricePNS: bigint;
  lotLNS: bigint;
  expiryBlock: bigint; // 0 = never (a non-zero value makes the issuer pay the recycle fee, 0 on mainnet today)
  postOnly: boolean;
  fillOrKill: boolean;
  immediateOrCancel: boolean;
  maxMatches: bigint; // 0 = the contract's own maximum
  leverageHdths: bigint; // 0 = the perpetual's maximum; builders below require an explicit value
  lastExecutionBlock: bigint; // 0 = no deadline; otherwise the order is skipped after this block
  amountCNS: bigint; // collateral amount, only for IncreasePositionCollateral
  maxNegPnlCollatBPS: bigint; // cap on extra collateral drawn to cover negative PnL, in bps of notional
};

// The default the SDK uses (crates/sdk/src/types/request.rs `DEFAULT_MAX_NEG_PNL_COLLAT_BPS`).
export const DEFAULT_MAX_NEG_PNL_COLLAT_BPS = 1000n;

const ORDER_DESC_TYPE =
  '(uint256,uint256,uint8,uint256,uint256,uint256,uint256,bool,bool,bool,uint256,uint256,uint256,uint256,uint256)';

export const SIGNATURES = {
  approve: 'approve(address,uint256)',
  createAccount: 'createAccount(uint256)',
  depositCollateral: 'depositCollateral(uint256)',
  withdrawCollateral: 'withdrawCollateral(uint256)',
  allowOrderForwarding: 'allowOrderForwarding(bool)',
  execOrder: `execOrder(${ORDER_DESC_TYPE})`,
  execOrders: `execOrders(${ORDER_DESC_TYPE}[],bool)`,
} as const;

const big = (x: bigint | number): bigint => BigInt(x);

export function orderDesc(o: Partial<OrderDesc> & Pick<OrderDesc, 'perpId' | 'orderType'>): OrderDesc {
  return {
    orderDescId: 0n,
    orderId: 0n,
    pricePNS: 0n,
    lotLNS: 0n,
    expiryBlock: 0n,
    postOnly: false,
    fillOrKill: false,
    immediateOrCancel: false,
    maxMatches: 0n,
    leverageHdths: 0n,
    lastExecutionBlock: 0n,
    amountCNS: 0n,
    maxNegPnlCollatBPS: DEFAULT_MAX_NEG_PNL_COLLAT_BPS,
    ...o,
  };
}

function checkDesc(d: OrderDesc): void {
  if (!Object.values(ORDER_TYPE).includes(d.orderType as never)) throw new Error(`unknown order type ${d.orderType}`);
  if (d.postOnly && (d.fillOrKill || d.immediateOrCancel)) {
    // The SDK rejects this too: a post-only order never fills on entry, so there is nothing to fill or kill.
    throw new Error('post-only cannot be combined with fill-or-kill or immediate-or-cancel');
  }
  if (d.fillOrKill && d.immediateOrCancel) throw new Error('fill-or-kill cannot be combined with immediate-or-cancel');
  if (d.maxMatches > 1000n) throw new Error('maxMatches above 1000 would be silently capped by the contract');
}

// The 15 words of an order descriptor, in ABI order.
function descWords(d: OrderDesc): string[] {
  checkDesc(d);
  return [
    uintWord(d.orderDescId, 'orderDescId'),
    uintWord(d.perpId, 'perpId'),
    uintWord(d.orderType, 'orderType'),
    uintWord(d.orderId, 'orderId'),
    uintWord(d.pricePNS, 'pricePNS'),
    uintWord(d.lotLNS, 'lotLNS'),
    uintWord(d.expiryBlock, 'expiryBlock'),
    boolWord(d.postOnly),
    boolWord(d.fillOrKill),
    boolWord(d.immediateOrCancel),
    uintWord(d.maxMatches, 'maxMatches'),
    uintWord(d.leverageHdths, 'leverageHdths'),
    uintWord(d.lastExecutionBlock, 'lastExecutionBlock'),
    uintWord(d.amountCNS, 'amountCNS'),
    uintWord(d.maxNegPnlCollatBPS, 'maxNegPnlCollatBPS'),
  ];
}

// ---- collateral token and account management ----

export const encodeApprove = (spender: string, amount: bigint | number): string =>
  call(SIGNATURES.approve, addressWord(spender, 'spender'), uintWord(amount, 'amount'));

// Creates the caller's exchange account and deposits `amountCNS` (>= getMinAccountOpenCNS(), 10 AUSD on
// 2026-10-11). The caller must have approved the exchange for at least that amount first.
export const encodeCreateAccount = (amountCNS: bigint | number): string =>
  call(SIGNATURES.createAccount, uintWord(amountCNS, 'amountCNS'));

export const encodeDepositCollateral = (amountCNS: bigint | number): string =>
  call(SIGNATURES.depositCollateral, uintWord(amountCNS, 'amountCNS'));

export const encodeWithdrawCollateral = (amountCNS: bigint | number): string =>
  call(SIGNATURES.withdrawCollateral, uintWord(amountCNS, 'amountCNS'));

// Order forwarding lets the exchange's operator execute signed requests for the account (what the
// REST/WebSocket path uses). Direct on-chain ordering does not need it; it is encoded only so the
// page can show a "forwarding is off" check, never to enable it silently.
export const encodeAllowOrderForwarding = (allow: boolean): string =>
  call(SIGNATURES.allowOrderForwarding, boolWord(allow));

// ---- orders ----

export const encodeExecOrder = (d: OrderDesc): string => call(SIGNATURES.execOrder, ...descWords(d));

// A batch. `revertOnFail` = true reverts the whole transaction when one request fails, instead of
// letting the exchange skip it and emit an error event; the page should always use true so that a
// simulation and the real call agree.
export function encodeExecOrders(ds: OrderDesc[], revertOnFail: boolean): string {
  // head: offset of the array (2 words), the bool; tail: length, then the static tuples inline
  const tail = [uintWord(ds.length), ...ds.flatMap(descWords)];
  return call(SIGNATURES.execOrders, uintWord(0x40), boolWord(revertOnFail), ...tail);
}

type Base = { perpId: bigint | number; orderDescId?: bigint | number; lastExecutionBlock?: bigint | number };
type Open = Base & {
  pricePNS: bigint | number;
  lotLNS: bigint | number;
  leverageHdths: bigint | number; // required for opens: 0 would mean "the perpetual's maximum"
  postOnly?: boolean;
  fillOrKill?: boolean;
  immediateOrCancel?: boolean;
  expiryBlock?: bigint | number;
  maxMatches?: bigint | number;
  maxNegPnlCollatBPS?: bigint | number;
};

function placed(type: OrderTypeName, o: Open): OrderDesc {
  if (big(o.lotLNS) <= 0n) throw new Error('lotLNS must be positive');
  if (big(o.pricePNS) <= 0n) throw new Error('pricePNS must be positive');
  if (type.startsWith('Open') && big(o.leverageHdths) <= 0n) throw new Error('leverageHdths must be set for an open order');
  return orderDesc({
    perpId: big(o.perpId),
    orderType: ORDER_TYPE[type],
    orderDescId: big(o.orderDescId ?? 0),
    pricePNS: big(o.pricePNS),
    lotLNS: big(o.lotLNS),
    leverageHdths: big(o.leverageHdths),
    postOnly: o.postOnly ?? false,
    fillOrKill: o.fillOrKill ?? false,
    immediateOrCancel: o.immediateOrCancel ?? false,
    expiryBlock: big(o.expiryBlock ?? 0),
    maxMatches: big(o.maxMatches ?? 0),
    lastExecutionBlock: big(o.lastExecutionBlock ?? 0),
    maxNegPnlCollatBPS: big(o.maxNegPnlCollatBPS ?? DEFAULT_MAX_NEG_PNL_COLLAT_BPS),
  });
}

export const openLong = (o: Open): OrderDesc => placed('OpenLong', o);
export const openShort = (o: Open): OrderDesc => placed('OpenShort', o);
// A close is reduce-only: it can only shrink an existing position of the named side.
export const closeLong = (o: Open): OrderDesc => placed('CloseLong', o);
export const closeShort = (o: Open): OrderDesc => placed('CloseShort', o);

// Cancel and change address a resting order by its id; the SDK also fills in the order's current
// price and size from the book (the contract wants them), so the caller passes the values it read.
export function cancelOrder(o: Base & { orderId: bigint | number; pricePNS: bigint | number; lotLNS: bigint | number }): OrderDesc {
  return orderDesc({
    perpId: big(o.perpId),
    orderType: ORDER_TYPE.Cancel,
    orderDescId: big(o.orderDescId ?? 0),
    orderId: big(o.orderId),
    pricePNS: big(o.pricePNS),
    lotLNS: big(o.lotLNS),
    lastExecutionBlock: big(o.lastExecutionBlock ?? 0),
  });
}

export function changeOrder(
  o: Base & {
    orderId: bigint | number;
    pricePNS: bigint | number; // the level the order moves to
    lotLNS: bigint | number;
    leverageHdths: bigint | number;
    expiryBlock?: bigint | number;
    postOnly?: boolean;
  },
): OrderDesc {
  return orderDesc({
    perpId: big(o.perpId),
    orderType: ORDER_TYPE.Change,
    orderDescId: big(o.orderDescId ?? 0),
    orderId: big(o.orderId),
    pricePNS: big(o.pricePNS),
    lotLNS: big(o.lotLNS),
    leverageHdths: big(o.leverageHdths),
    expiryBlock: big(o.expiryBlock ?? 0),
    postOnly: o.postOnly ?? false,
    lastExecutionBlock: big(o.lastExecutionBlock ?? 0),
  });
}

export function increasePositionCollateral(o: Base & { amountCNS: bigint | number }): OrderDesc {
  if (big(o.amountCNS) <= 0n) throw new Error('amountCNS must be positive');
  return orderDesc({
    perpId: big(o.perpId),
    orderType: ORDER_TYPE.IncreasePositionCollateral,
    orderDescId: big(o.orderDescId ?? 0),
    amountCNS: big(o.amountCNS),
    lastExecutionBlock: big(o.lastExecutionBlock ?? 0),
  });
}
