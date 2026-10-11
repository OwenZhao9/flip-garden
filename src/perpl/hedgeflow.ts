// The hedge flow's logic: live market context, the hedge plan, what to do next (derived from chain state only, so a
// reload resumes correctly), the planners for the five guarded transactions, the pre-pop-up trace check and the
// post-conditions. It reuses sendStep from src/flow.ts for the gate every transaction passes:
//   guard -> network and account check -> simulate from the user's address -> trace check -> gas -> announcement
//   -> ONE wallet pop-up (or passkey signature) -> receipt -> post-conditions read back from the chain.
// Nothing here signs or sends anything by itself; tests drive it with a fake wallet and a fake chain.
import { encodeApprove, encodeCreateAccount, encodeExecOrders, encodeWithdrawCollateral, closeShort, openShort } from './encode.ts';
import { PERPL } from './guard.ts';
import { liquidationPricePNS, marginPlan, shortSize, fundingCostPerDayCNS, FUNDING_INTERVAL_BLOCKS, type HedgeMarket, type MarginPlan } from './hedge.ts';
import { PerplReader, eventsOfAccount, feePpm, perpIdsWithPosition, type Account, type PerpetualInfo, type Position } from './state.ts';
import { decodePerplLog, fieldOf, type PerplEvent, type RawLog as PerplRawLog } from './events.ts';
import type { Env, Receipt, StepResult, Verification } from '../flow.ts';
import { LIMITS, type PlannedTx } from '../plant.ts';
import { BPS, formatUnits } from '../units.ts';

export const HEDGE = {
  slippageBps: 100n, // the price bound of the immediate-or-cancel order: 1% worse than the best price
  deadlineBlocks: 1500n, // lastExecutionBlock = head + this (about 7.5 minutes at 0.3 s). The price bound is the real protection.
  leverageHdths: 200n, // 2x
  bufferBps: 300n, // slack on the initial margin for the extra collateral a worse-than-mark fill locks (docs/PERPL-ONCHAIN.md)
  defaultRatioBps: 5000n,
  depositStepCNS: 10_000n, // account deposits are rounded up to whole cents
} as const;

export const AUSD_DECIMALS = 6;
const lc = (s: string): string => s.toLowerCase();
const hex = (n: bigint | number): string => '0x' + n.toString(16);
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;
const pow10 = (n: number): bigint => 10n ** BigInt(n);
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const CANNOT = 'Cannot explain';

type Rpc = Env['rpc'];

// ---------------------------------------------------------------- market context ---------------------------------

export type HedgeContext = {
  block: number;
  version: [bigint, bigint, bigint];
  halted: boolean;
  minOpenCNS: bigint;
  perp: PerpetualInfo;
  bestBid: bigint; // PNS
  bestAsk: bigint; // PNS
  mark: bigint;
  oracle: bigint;
  takerFeePpm: bigint;
  makerFeePpm: bigint;
  market: HedgeMarket;
};

export async function readHedgeContext(rpc: Rpc, lotForFractions = 1n): Promise<HedgeContext> {
  const r = new PerplReader(rpc, PERPL.exchange);
  const perpId = Number(PERPL.perpId);
  const block = await rpc.blockNumber();
  const [version, halted, minOpenCNS, perp, fractions, takerRaw, makerRaw] = await Promise.all([
    r.contractVersion(), r.isHalted(), r.minAccountOpenCNS(), r.perpetual(perpId), r.marginFractions(perpId, lotForFractions), r.takerFee(perpId), r.makerFee(perpId),
  ]);
  const base = perp.basePricePNS;
  return {
    block, version, halted, minOpenCNS, perp,
    bestBid: perp.maxBidPriceONS + base, bestAsk: perp.minAskPriceONS + base, mark: perp.markPNS, oracle: perp.oraclePNS,
    takerFeePpm: feePpm(takerRaw, version), makerFeePpm: feePpm(makerRaw, version),
    market: {
      lotDecimals: perp.lotDecimals, priceDecimals: perp.priceDecimals, cnsDecimals: AUSD_DECIMALS, baseDecimals: 18, minLotLNS: 1n,
      maintMarginFracHdths: fractions.maintHdths, maxLeverageHdths: fractions.initHdths,
    },
  };
}

export const bookIsUsable = (c: Pick<HedgeContext, 'bestBid' | 'bestAsk'>): boolean => c.bestBid > 0n && c.bestAsk > c.bestBid;

// Price bounds of the immediate-or-cancel orders. A short sells: it must not fill below `openBound`. Closing buys back:
// it must not fill above `closeBound`. Both are clamped into the exchange's accepted price range.
export function openBound(c: HedgeContext): bigint {
  const b = (c.bestBid * (BPS - HEDGE.slippageBps)) / BPS;
  const lowest = c.perp.minBidPriceONS + c.perp.basePricePNS;
  return b > lowest ? b : lowest;
}
export function closeBound(c: HedgeContext): bigint {
  const b = ceilDiv(c.bestAsk * (BPS + HEDGE.slippageBps), BPS);
  const highest = c.perp.maxAskPriceONS + c.perp.basePricePNS;
  return b < highest ? b : highest;
}

// ---------------------------------------------------------------- chain state -------------------------------------

export type PerplState = {
  block: number;
  walletAusd: bigint;
  walletMon: bigint;
  allowance: bigint; // AUSD allowance of the exchange
  account: Account | null;
  position: Position | null; // the MON position, if any
  otherPositions: number[]; // positions on other markets (this page never touches them)
  restingOrders: number; // resting orders on the MON market (this page never places any)
};

export async function readAllowance(rpc: Rpc, owner: string, block: number | 'latest' = 'latest'): Promise<bigint> {
  const data = '0xdd62ed3e' + lc(owner).slice(2).padStart(64, '0') + lc(PERPL.exchange).slice(2).padStart(64, '0');
  return BigInt(await rpc.call<string>('eth_call', [{ to: PERPL.ausd, data }, block === 'latest' ? 'latest' : hex(block)]));
}

export async function readPerplState(rpc: Rpc, user: string, block: number | 'latest' = 'latest'): Promise<PerplState> {
  const r = new PerplReader(rpc, PERPL.exchange);
  const tag = block === 'latest' ? undefined : block;
  const head = block === 'latest' ? await rpc.blockNumber() : block;
  const [walletAusd, walletMon, allowance, account] = await Promise.all([
    rpc.walletBalance(user, PERPL.ausd, block), rpc.walletBalance(user, '0x0000000000000000000000000000000000000000', block), readAllowance(rpc, user, block), r.account(user, tag),
  ]);
  let position: Position | null = null;
  let others: number[] = [];
  let resting = 0;
  if (account) {
    const ids = perpIdsWithPosition(account);
    others = ids.filter((i) => BigInt(i) !== PERPL.perpId);
    if (ids.includes(Number(PERPL.perpId))) position = await r.position(Number(PERPL.perpId), account.accountId, tag);
    resting = (await r.orderLocks(account.accountId, Number(PERPL.perpId), tag)).length;
  }
  return { block: head, walletAusd, walletMon, allowance, account, position: position && position.lotLNS > 0n ? position : null, otherPositions: others, restingOrders: resting };
}

// ---------------------------------------------------------------- the plan ---------------------------------------

export type HedgePlan =
  | {
      ok: true;
      lot: bigint; // whole MON
      requestedLot: bigint; // before the caps
      cappedBy: 'notional' | 'margin' | null;
      hedgedInventoryRaw: bigint;
      ratioBps: bigint;
      refPricePNS: bigint; // best bid, the price the notional and margin are computed at
      boundPNS: bigint;
      notionalCNS: bigint;
      margin: MarginPlan;
      extraCollateralEstCNS: bigint; // (mark - bid) x lot when the bid is under the mark: locked on top of notional / leverage
      depositCNS: bigint; // first deposit when the account has to be created, else 0
      liquidationPNS: bigint;
      fundingPerDayCNS: bigint; // at the current rate, positive = the short pays
      roundTripCostCNS: bigint; // spread + two taker fees at today's book, an estimate
    }
  | { ok: false; reason: string };

const lotsFor = (limit: bigint, price: bigint, m: HedgeMarket): bigint => (limit * pow10(m.lotDecimals + m.priceDecimals)) / (price * pow10(m.cnsDecimals));
const cnsOf = (lot: bigint, pricePNS: bigint, m: HedgeMarket): bigint => (lot * pricePNS * pow10(m.cnsDecimals)) / pow10(m.lotDecimals + m.priceDecimals);

// `freeCNS` = the free collateral of the Perpl account, or null when no account exists yet (then the first deposit
// is part of the plan).
export function planHedge(o: { inventoryRaw: bigint; ratioBps: bigint; ctx: HedgeContext; freeCNS: bigint | null }): HedgePlan {
  const { ctx, ratioBps } = o;
  const m = ctx.market;
  if (ctx.halted) return { ok: false, reason: 'Perpl reports that trading is halted right now.' };
  if (!bookIsUsable(ctx)) return { ok: false, reason: 'The Perpl order book for MON is empty or crossed right now, so nothing can be hedged.' };
  const sz = shortSize(o.inventoryRaw, ratioBps, m);
  if (!sz.meetsMinimum) return { ok: false, reason: 'Your MON inventory times the hedge ratio is below 1 MON, the smallest order Perpl accepts, so there is nothing to hedge.' };
  const requested = sz.lotLNS;
  let lot = requested;
  let cappedBy: 'notional' | 'margin' | null = null;
  const lotCap = lotsFor(PERPL.maxNotionalCNS, ctx.bestBid, m);
  if (lotCap < 1n) return { ok: false, reason: 'One MON is already worth more than the 15 USD notional cap.' };
  if (lot > lotCap) {
    lot = lotCap;
    cappedBy = 'notional';
  }
  const plan = (l: bigint): MarginPlan => marginPlan({ lotLNS: l, pricePNS: ctx.bestBid, leverageHdths: HEDGE.leverageHdths, feePpm: ctx.takerFeePpm, bufferBps: HEDGE.bufferBps }, m);
  const available = o.freeCNS ?? PERPL.maxDepositCNS;
  if (plan(1n).requiredCNS > available) {
    return { ok: false, reason: o.freeCNS === null ? 'Even one MON would need more collateral than the 15 AUSD cap.' : `Your Perpl account has ${formatUnits(available, AUSD_DECIMALS)} AUSD free, which is not enough to hedge even 1 MON.` };
  }
  if (plan(lot).requiredCNS > available) {
    let lo = 1n;
    let hi = lot;
    while (lo < hi) {
      const mid = (lo + hi + 1n) / 2n;
      if (plan(mid).requiredCNS <= available) lo = mid;
      else hi = mid - 1n;
    }
    lot = lo;
    cappedBy = 'margin';
  }
  const margin = plan(lot);
  let depositCNS = 0n;
  if (o.freeCNS === null) {
    const want = margin.requiredCNS > ctx.minOpenCNS ? margin.requiredCNS : ctx.minOpenCNS;
    depositCNS = ceilDiv(want, HEDGE.depositStepCNS) * HEDGE.depositStepCNS;
    if (depositCNS > PERPL.maxDepositCNS) return { ok: false, reason: `Perpl asks for at least ${formatUnits(ctx.minOpenCNS, AUSD_DECIMALS)} AUSD to open an account, above this page's 15 AUSD cap.` };
  }
  const notional = cnsOf(lot, ctx.bestBid, m);
  const extra = ctx.mark > ctx.bestBid ? cnsOf(lot, ctx.mark - ctx.bestBid, m) : 0n;
  const liq = liquidationPricePNS({ side: 'short', entryPricePNS: ctx.bestBid, lotLNS: lot, depositCNS: margin.initialMarginCNS + extra }, m);
  const perLot = pow10(m.baseDecimals - m.lotDecimals);
  const spread = cnsOf(lot, ctx.bestAsk - ctx.bestBid, m);
  const fees = 2n * ceilDiv(notional * ctx.takerFeePpm, 1_000_000n);
  return {
    ok: true, lot, requestedLot: requested, cappedBy, hedgedInventoryRaw: lot * perLot, ratioBps, refPricePNS: ctx.bestBid, boundPNS: openBound(ctx),
    notionalCNS: notional, margin, extraCollateralEstCNS: extra, depositCNS, liquidationPNS: liq,
    fundingPerDayCNS: fundingCostPerDayCNS(notional, ctx.perp.fundingRatePct100k, 'short'), roundTripCostCNS: spread + fees,
  };
}

// ---------------------------------------------------------------- what to do next ----------------------------------

export type HedgeAction =
  | { type: 'approve'; amount: bigint }
  | { type: 'create'; amount: bigint }
  | { type: 'open' }
  | { type: 'opened' }
  | { type: 'blocked'; reason: string };

export function nextOpenAction(s: PerplState, plan: Extract<HedgePlan, { ok: true }>): HedgeAction {
  if (s.position) return s.position.positionType === 1 ? { type: 'opened' } : { type: 'blocked', reason: 'Your account holds a long position on MON. This page only manages shorts; close the long elsewhere first.' };
  if (s.otherPositions.length) return { type: 'blocked', reason: 'Your Perpl account holds positions on other markets. This page only manages the MON short, so it will not touch an account that is used for more.' };
  if (s.restingOrders > 0) return { type: 'blocked', reason: 'Your Perpl account has resting orders on MON. This page never places resting orders; cancel them elsewhere first.' };
  if (s.walletMon < LIMITS.minWalletMon) return { type: 'blocked', reason: `Keep at least ${formatUnits(LIMITS.minWalletMon, 18)} MON in the wallet for network fees.` };
  if (!s.account) {
    if (s.walletAusd < plan.depositCNS) return { type: 'blocked', reason: `The first deposit is ${formatUnits(plan.depositCNS, AUSD_DECIMALS)} AUSD but the wallet holds ${formatUnits(s.walletAusd, AUSD_DECIMALS)} AUSD. Get AUSD with the swap on the Passkey page first.` };
    if (s.allowance < plan.depositCNS) return { type: 'approve', amount: plan.depositCNS };
    return { type: 'create', amount: plan.depositCNS };
  }
  if (s.account.frozen !== 0) return { type: 'blocked', reason: 'Perpl reports this account as frozen.' };
  if (s.account.balanceCNS < plan.margin.requiredCNS) return { type: 'blocked', reason: `The Perpl account has ${formatUnits(s.account.balanceCNS, AUSD_DECIMALS)} AUSD free; this hedge needs ${formatUnits(plan.margin.requiredCNS, AUSD_DECIMALS)}. Lower the hedge ratio.` };
  return { type: 'open' };
}

export type CloseAction = { type: 'close' } | { type: 'withdraw'; amount: bigint } | { type: 'done' } | { type: 'blocked'; reason: string };

export function nextCloseAction(s: PerplState): CloseAction {
  if (s.position) return s.position.positionType === 1 ? { type: 'close' } : { type: 'blocked', reason: 'The position is a long, not a short from this page. Close it where it was opened.' };
  if (s.account && s.account.balanceCNS > 0n) return { type: 'withdraw', amount: s.account.balanceCNS };
  return { type: 'done' };
}

// ---------------------------------------------------------------- planners ---------------------------------------

const exec = (d: ReturnType<typeof openShort>): string => encodeExecOrders([d], true);

export const planPerplApprove = (from: string, amount: bigint): PlannedTx => ({ kind: 'perplApprove', from, to: PERPL.ausd, data: encodeApprove(PERPL.exchange, amount), value: '0x0' });
export const planPerplCreate = (from: string, amount: bigint, minDepositCNS?: bigint): PlannedTx => ({ kind: 'perplCreate', from, to: PERPL.exchange, data: encodeCreateAccount(amount), value: '0x0', minDepositCNS });
export const planPerplWithdraw = (from: string, amount: bigint): PlannedTx => ({ kind: 'perplWithdraw', from, to: PERPL.exchange, data: encodeWithdrawCollateral(amount), value: '0x0' });
export const planPerplOpen = (from: string, o: { lot: bigint; boundPNS: bigint; lastExecutionBlock: bigint }): PlannedTx => ({
  kind: 'perplOpen', from, to: PERPL.exchange, value: '0x0',
  data: exec(openShort({ perpId: PERPL.perpId, pricePNS: o.boundPNS, lotLNS: o.lot, leverageHdths: HEDGE.leverageHdths, immediateOrCancel: true, lastExecutionBlock: o.lastExecutionBlock })),
});
export const planPerplClose = (from: string, o: { lot: bigint; boundPNS: bigint; lastExecutionBlock: bigint }): PlannedTx => ({
  kind: 'perplClose', from, to: PERPL.exchange, value: '0x0',
  data: exec(closeShort({ perpId: PERPL.perpId, pricePNS: o.boundPNS, lotLNS: o.lot, leverageHdths: HEDGE.leverageHdths, immediateOrCancel: true, lastExecutionBlock: o.lastExecutionBlock })),
});

// ---------------------------------------------------------------- trace check (before the pop-up) -----------------

type Frame = { error?: string; logs?: { address: string; topics: string[]; data: string }[]; calls?: Frame[] };
type Expect =
  | { kind: 'create'; amount: bigint }
  | { kind: 'open'; accountId: bigint; lot: bigint }
  | { kind: 'close'; accountId: bigint; lot: bigint; positionLot: bigint }
  | { kind: 'withdraw'; accountId: bigint; amount: bigint };

// The simulation (eth_call) only says "did not revert". An immediate-or-cancel order that finds nothing to fill does not
// revert either, so this traces the call from the user's address and reads the events it would emit.
export function perplTraceCheck(sim: Rpc, user: string, want: Expect): (call: { from: string; to: string; data: string; value: string }) => Promise<string | null> {
  return async (call) => {
    let trace: Frame;
    try {
      trace = await sim.call('debug_traceCall', [call, 'latest', { tracer: 'callTracer', tracerConfig: { withLog: true } }]);
    } catch (e) {
      return `The safety trace could not be run (${(e as Error)?.message ?? e}), so this step cannot be checked.`;
    }
    if (trace.error) return `The transaction would fail (${trace.error}).`;
    const events: PerplEvent[] = [];
    const transfers: { token: string; from: string; to: string; amount: bigint }[] = [];
    let failed = false;
    const walk = (f: Frame): void => {
      if (f.error) failed = true;
      for (const l of f.logs ?? []) {
        if (l.topics?.[0] === TRANSFER && l.topics.length === 3) transfers.push({ token: lc(l.address), from: '0x' + l.topics[1].slice(26), to: '0x' + l.topics[2].slice(26), amount: BigInt(l.data) });
        else if (lc(l.address) === lc(PERPL.exchange)) {
          const ev = decodePerplLog({ ...l, blockNumber: '0x0', transactionHash: '0x', logIndex: '0x' + events.length.toString(16) });
          if (ev) events.push(ev);
        }
      }
      (f.calls ?? []).forEach(walk);
    };
    walk(trace);
    if (failed) return 'Part of the call fails in simulation.';
    const me = lc(user);
    const mine = (e: PerplEvent): boolean => e.fields.accountId === (want as { accountId?: bigint }).accountId;
    const out = transfers.filter((t) => lc(t.from) === me);
    switch (want.kind) {
      case 'create': {
        const created = events.find((e) => e.name === 'AccountCreated');
        if (!created || lc(String(created.fields.account)) !== me) return 'The simulation does not create an account for your address.';
        const wrong = out.filter((t) => !(t.token === lc(PERPL.ausd) && lc(t.to) === lc(PERPL.exchange)));
        const paid = out.reduce((a, t) => a + t.amount, 0n);
        if (wrong.length || paid !== want.amount) return `The simulation would take ${paid} raw AUSD units to the exchange (and ${wrong.length} other transfer(s)) instead of exactly ${want.amount}.`;
        return null;
      }
      case 'open': {
        if (out.length) return 'The order would move tokens out of your wallet, which an order must never do.';
        const opened = events.filter((e) => e.name === 'PositionOpenedV2' && mine(e));
        const lots = opened.reduce((a, e) => a + fieldOf(e, 'lotLNS'), 0n);
        if (opened.some((e) => fieldOf(e, 'positionType') !== 1n)) return 'The simulation opens something other than a short.';
        if (lots === 0n) return 'The simulation shows nothing would fill at the price bound: the market moved or the bid side is empty.';
        if (lots !== want.lot) return `The simulation would fill only ${lots} of ${want.lot} MON at the price bound (the bid side is too thin at this size).`;
        return null;
      }
      case 'close': {
        if (out.length) return 'The order would move tokens out of your wallet, which an order must never do.';
        const closed = events.some((e) => e.name === 'PositionClosed' && mine(e));
        const dec = events.filter((e) => e.name === 'PositionDecreased' && mine(e)).reduce((a, e) => a + (fieldOf(e, 'startLotLNS') - fieldOf(e, 'endLotLNS')), 0n);
        const got = closed ? want.positionLot : dec;
        if (got === 0n) return 'The simulation shows nothing would fill at the price bound: the ask side is empty or the market moved up.';
        if (got < want.lot) return `The simulation would buy back only ${got} of ${want.lot} MON at the price bound.`;
        return null;
      }
      case 'withdraw': {
        const w = events.find((e) => e.name === 'CollateralWithdrawal' && mine(e));
        if (!w || fieldOf(w, 'amountCNS') !== want.amount) return 'The simulation does not withdraw exactly the expected amount from your account.';
        const got = transfers.filter((t) => t.token === lc(PERPL.ausd) && lc(t.to) === me).reduce((a, t) => a + t.amount, 0n);
        if (got !== want.amount) return `The simulation would send ${got} raw AUSD units to your address instead of exactly ${want.amount}.`;
        if (out.length) return 'The withdrawal would also move tokens out of your wallet.';
        return null;
      }
    }
  };
}

// ---------------------------------------------------------------- post-conditions ---------------------------------

type Confirmed = Extract<StepResult, { status: 'confirmed' }>;
const exLogs = (r: Receipt): PerplRawLog[] => (r.logs as unknown as PerplRawLog[]).filter((l) => lc(l.address) === lc(PERPL.exchange));
const decoded = (logs: PerplRawLog[]): PerplEvent[] => logs.map((l) => decodePerplLog(l)).filter((e): e is PerplEvent => e !== null);
const fail = (...problems: string[]): Verification => ({ ok: false, facts: [], problems });
const ausd = (v: bigint): string => formatUnits(v, AUSD_DECIMALS);

export async function verifyPerplApprove(env: Env, amount: bigint, r: Confirmed): Promise<Verification> {
  const now = await readAllowance(env.rpc, env.account, r.block);
  return now === amount ? { ok: true, facts: ['The AUSD allowance for the Perpl exchange is exactly the approved amount.'], problems: [] } : fail(`${CANNOT}: the allowance reads ${now} raw units, expected exactly ${amount}.`);
}

export async function verifyPerplCreate(env: Env, before: PerplState, amount: bigint, r: Confirmed): Promise<Verification & { accountId?: bigint }> {
  const after = await readPerplState(env.rpc, env.account, r.block);
  const evs = decoded(exLogs(r.receipt));
  const created = evs.filter((e) => e.name === 'AccountCreated' && lc(String(e.fields.account)) === lc(env.account));
  const problems: string[] = [];
  if (created.length !== 1) problems.push(`${CANNOT}: the AccountCreated event for your address is missing or appears ${created.length} times.`);
  if (!after.account) problems.push(`${CANNOT}: the exchange has no account for your address at block ${r.block}.`);
  else {
    if (created[0] && fieldOf(created[0], 'id') !== after.account.accountId) problems.push(`${CANNOT}: the event names another account id than the exchange reports.`);
    if (after.account.balanceCNS !== amount) problems.push(`${CANNOT}: the account balance is ${after.account.balanceCNS} raw units, expected exactly ${amount}.`);
  }
  if (before.walletAusd - after.walletAusd !== amount) problems.push(`${CANNOT}: the wallet AUSD fell by ${before.walletAusd - after.walletAusd} raw units, expected exactly ${amount}.`);
  const dep = evs.filter((e) => e.name === 'CollateralDeposit');
  if (dep.length !== 1 || fieldOf(dep[0], 'amountCNS') !== amount) problems.push(`${CANNOT}: the CollateralDeposit event is missing or has another amount.`);
  return problems.length ? { ok: false, facts: [], problems } : { ok: true, facts: [`Account ${after.account!.accountId} created with exactly ${ausd(amount)} AUSD; the wallet AUSD fell by the same amount.`], problems: [], accountId: after.account!.accountId };
}

export type OpenOutcome = Verification & { filledLot: bigint; entryPricePNS: bigint; feeCNS: bigint; depositCNS: bigint; extraCollateralCNS: bigint };

export async function verifyPerplOpen(env: Env, before: PerplState, plan: { lot: bigint; boundPNS: bigint }, r: Confirmed): Promise<OpenOutcome> {
  const none = (v: Verification): OpenOutcome => ({ ...v, filledLot: 0n, entryPricePNS: 0n, feeCNS: 0n, depositCNS: 0n, extraCollateralCNS: 0n });
  if (!before.account) return none(fail(`${CANNOT}: no account existed before the order.`));
  const acct = before.account.accountId;
  const after = await readPerplState(env.rpc, env.account, r.block);
  if (!after.account) return none(fail(`${CANNOT}: the account is gone after the order.`));
  const mine = eventsOfAccount(exLogs(r.receipt) as unknown as Parameters<typeof eventsOfAccount>[0], acct);
  const opened = mine.filter((e) => e.name === 'PositionOpenedV2');
  const takers = mine.filter((e) => e.name === 'TakerOrderFilledV2');
  const problems: string[] = [];
  if (!opened.length) {
    // An immediate-or-cancel order that finds no liquidity within its bound succeeds and does nothing.
    if (after.position) problems.push(`${CANNOT}: a position exists but the receipt shows no position opening.`);
    if (after.account.balanceCNS !== before.account.balanceCNS) problems.push(`${CANNOT}: the account balance changed (${before.account.balanceCNS} to ${after.account.balanceCNS}) although nothing was filled.`);
    return problems.length ? none(fail(...problems)) : none({ ok: true, facts: ['Nothing was filled: the price moved beyond the 1% bound before the order executed, so no position was opened and no collateral moved. Your AUSD is still in the Perpl account.'], problems: [] });
  }
  const filled = opened.reduce((a, e) => a + fieldOf(e, 'lotLNS'), 0n);
  const deposit = opened.reduce((a, e) => a + fieldOf(e, 'depositCNS'), 0n);
  const extra = opened.reduce((a, e) => a + fieldOf(e, 'pnlCollateralizedCNS'), 0n);
  const fee = takers.reduce((a, e) => a + fieldOf(e, 'feeCNS'), 0n);
  const spent = takers.reduce((a, e) => a - fieldOf(e, 'amountCNS'), 0n);
  const entry = opened.length === 1 ? fieldOf(opened[0], 'pricePNS') : opened.reduce((a, e) => a + fieldOf(e, 'pricePNS') * fieldOf(e, 'lotLNS'), 0n) / filled;
  if (opened.some((e) => fieldOf(e, 'positionType') !== 1n)) problems.push(`${CANNOT}: the position opened is not a short.`);
  if (filled > plan.lot) problems.push(`${CANNOT}: ${filled} MON were filled, more than the ${plan.lot} MON ordered.`);
  if (opened.some((e) => fieldOf(e, 'pricePNS') < plan.boundPNS)) problems.push(`${CANNOT}: a fill happened below the price bound.`);
  const p = after.position;
  if (!p) problems.push(`${CANNOT}: no position is open on chain after the fill.`);
  else {
    if (p.positionType !== 1) problems.push(`${CANNOT}: the on-chain position is not a short.`);
    if (p.lotLNS !== filled) problems.push(`${CANNOT}: the on-chain position is ${p.lotLNS} MON, the receipt says ${filled}.`);
    if (p.depositCNS !== deposit) problems.push(`${CANNOT}: the position holds ${p.depositCNS} raw AUSD units of collateral, the receipt says ${deposit}.`);
  }
  // Collateral rule (docs/PERPL-ONCHAIN.md): deposit = notional / leverage + max(0, (mark - fill) x lot), the second part capped at 10% of notional.
  const notional = opened.reduce((a, e) => a + fieldOf(e, 'pricePNS') * fieldOf(e, 'lotLNS'), 0n);
  const initial = ceilDiv(notional * 100n, HEDGE.leverageHdths);
  if (deposit - extra < initial - 2n || deposit - extra > initial + 2n) problems.push(`${CANNOT}: the collateral ${deposit} is not the notional over 2x (${initial}) plus the extra ${extra}.`);
  if (extra < 0n || extra * BPS > notional * PERPL.maxNegPnlCollatBPS) problems.push(`${CANNOT}: the extra collateral ${extra} is outside the 0 to 10% of notional the rules allow.`);
  const feeExpected = ceilDiv(notional * 345n, 1_000_000n); // tier 1 taker fee; the live value is shown by the plan, this only bounds the check
  if (fee > feeExpected * 4n) problems.push(`${CANNOT}: the fee ${fee} is far above the tier 1 fee of about ${feeExpected}.`);
  if (before.account.balanceCNS - after.account.balanceCNS !== spent) problems.push(`${CANNOT}: the free collateral fell by ${before.account.balanceCNS - after.account.balanceCNS} raw units, the receipt says ${spent} (collateral plus fee).`);
  if (spent !== deposit + fee) problems.push(`${CANNOT}: collateral ${deposit} plus fee ${fee} is not the ${spent} taken from the account.`);
  if (problems.length) return none(fail(...problems));
  const partial = filled < plan.lot;
  const facts = [
    `${partial ? `Partly filled: ${filled} of ${plan.lot} MON were sold short (the rest found no liquidity inside the 1% bound and was cancelled; nothing else was ordered). ` : `Filled completely: ${filled} MON sold short. `}Average price ${formatUnits(entry, 6)} AUSD, collateral ${ausd(deposit)} AUSD (of which ${ausd(extra)} is the extra the exchange locks when the fill is below the mark price), trading fee ${ausd(fee)} AUSD.`,
  ];
  return { ok: true, facts, problems: [], filledLot: filled, entryPricePNS: entry, feeCNS: fee, depositCNS: deposit, extraCollateralCNS: extra };
}

export type CloseOutcome = Verification & { closedLot: bigint; remainingLot: bigint; pnlCNS: bigint; fundingCNS: bigint; feeCNS: bigint; returnedCNS: bigint };

export async function verifyPerplClose(env: Env, before: PerplState, plan: { lot: bigint; boundPNS: bigint }, r: Confirmed): Promise<CloseOutcome> {
  const none = (v: Verification, remaining = 0n): CloseOutcome => ({ ...v, closedLot: 0n, remainingLot: remaining, pnlCNS: 0n, fundingCNS: 0n, feeCNS: 0n, returnedCNS: 0n });
  if (!before.account || !before.position) return none(fail(`${CANNOT}: there was no position to close before the order.`));
  const acct = before.account.accountId;
  const after = await readPerplState(env.rpc, env.account, r.block);
  if (!after.account) return none(fail(`${CANNOT}: the account is gone after the order.`));
  const mine = eventsOfAccount(exLogs(r.receipt) as unknown as Parameters<typeof eventsOfAccount>[0], acct);
  const closed = mine.filter((e) => e.name === 'PositionClosed');
  const dec = mine.filter((e) => e.name === 'PositionDecreased');
  const takers = mine.filter((e) => e.name === 'TakerOrderFilledV2');
  const remaining = after.position?.lotLNS ?? 0n;
  const problems: string[] = [];
  if (!closed.length && !dec.length) {
    if (remaining !== before.position.lotLNS) problems.push(`${CANNOT}: the position changed from ${before.position.lotLNS} to ${remaining} MON without a closing event.`);
    return problems.length ? none(fail(...problems), remaining) : none({ ok: true, facts: ['Nothing was bought back: the price moved above the 1% bound before the order executed. The short is still open; press Close hedge again.'], problems: [] }, remaining);
  }
  const closedLot = closed.length ? before.position.lotLNS - 0n : dec.reduce((a, e) => a + (fieldOf(e, 'startLotLNS') - fieldOf(e, 'endLotLNS')), 0n);
  const pnl = [...closed, ...dec].reduce((a, e) => a + fieldOf(e, 'deltaPnlCNS'), 0n);
  const funding = [...closed, ...dec].reduce((a, e) => a + fieldOf(e, 'fundingCNS'), 0n);
  const fee = takers.reduce((a, e) => a + fieldOf(e, 'feeCNS'), 0n);
  const returned = takers.reduce((a, e) => a + fieldOf(e, 'amountCNS'), 0n);
  if (closed.length && remaining !== 0n) problems.push(`${CANNOT}: the receipt says the position closed but ${remaining} MON remain on chain.`);
  if (!closed.length && remaining !== before.position.lotLNS - closedLot) problems.push(`${CANNOT}: ${remaining} MON remain on chain, expected ${before.position.lotLNS - closedLot}.`);
  if (closedLot > plan.lot) problems.push(`${CANNOT}: ${closedLot} MON were bought back, more than the ${plan.lot} ordered.`);
  if (after.account.balanceCNS - before.account.balanceCNS !== returned) problems.push(`${CANNOT}: the free collateral grew by ${after.account.balanceCNS - before.account.balanceCNS} raw units, the receipt says ${returned}.`);
  if (problems.length) return none(fail(...problems), remaining);
  const partial = remaining > 0n;
  return {
    ok: true, closedLot, remainingLot: remaining, pnlCNS: pnl, fundingCNS: funding, feeCNS: fee, returnedCNS: returned, problems: [],
    facts: [`${partial ? `Partly closed: ${closedLot} MON bought back, ${remaining} MON still short (press Close hedge again). ` : `Closed: ${closedLot} MON bought back. `}Price result ${ausd(pnl)} AUSD, funding ${ausd(funding)} AUSD (negative = paid), trading fee ${ausd(fee)} AUSD; ${ausd(returned)} AUSD came back to your Perpl account.`],
  };
}

export async function verifyPerplWithdraw(env: Env, before: PerplState, amount: bigint, r: Confirmed): Promise<Verification> {
  if (!before.account) return fail(`${CANNOT}: there was no account to withdraw from.`);
  const after = await readPerplState(env.rpc, env.account, r.block);
  const problems: string[] = [];
  const w = decoded(exLogs(r.receipt)).filter((e) => e.name === 'CollateralWithdrawal' && e.fields.accountId === before.account!.accountId);
  if (w.length !== 1 || fieldOf(w[0], 'amountCNS') !== amount) problems.push(`${CANNOT}: the CollateralWithdrawal event is missing or has another amount.`);
  if (after.walletAusd - before.walletAusd !== amount) problems.push(`${CANNOT}: the wallet AUSD grew by ${after.walletAusd - before.walletAusd} raw units, expected exactly ${amount}.`);
  if (!after.account || before.account.balanceCNS - after.account.balanceCNS !== amount) problems.push(`${CANNOT}: the account balance did not fall by exactly ${amount}.`);
  return problems.length ? { ok: false, facts: [], problems } : { ok: true, facts: [`${ausd(amount)} AUSD came back to your wallet.`], problems: [] };
}

// ---------------------------------------------------------------- measured funding (read-only) --------------------

export type FundingFacts = { ratePct100k: bigint; intervalBlocks: bigint; sumNow: bigint; sumThen: bigint; windowBlocks: number; priceNowPNS: bigint };

// The cumulative funding sum now and `windowBlocks` ago, for the "what did funding cost lately" line.
export async function readFundingFacts(rpc: Rpc, ctx: HedgeContext, windowBlocks = 7 * 286_197): Promise<FundingFacts> {
  const r = new PerplReader(rpc, PERPL.exchange);
  const head = ctx.block;
  const [now, then] = await Promise.all([r.fundingSum(Number(PERPL.perpId), head), r.fundingSum(Number(PERPL.perpId), Math.max(1, head - windowBlocks))]);
  return { ratePct100k: ctx.perp.fundingRatePct100k, intervalBlocks: FUNDING_INTERVAL_BLOCKS, sumNow: now.sum, sumThen: then.sum, windowBlocks, priceNowPNS: ctx.mark };
}
