// USDC -> AUSD through Kuru Flow: quote, the extra safety check, planning and post-conditions.
// The page never trusts the quote blindly: the returned transaction is decoded and guarded (src/swapguard.ts,
// src/plant.ts guardTx), simulated from the user's own address, TRACED to see where every token would go, and after the
// receipt the balances are compared with the quote. Tests drive it with a fake fetch; nothing here signs anything.
import { encodeApprove, encodeCall } from './abi.ts';
import type { Env, StepResult, Verification } from './flow.ts';
import type { JsonRpc } from './rpc.ts';
import { CHAIN, LIMITS, USDC_DECIMALS, sameAddress, type PlannedTx } from './plant.ts';
import { AUSD, AUSD_DECIMALS, FLOW_API, FLOW_ROUTER, decodeFlowSwap } from './swapguard.ts';
import { formatUnits, parseUnits } from './units.ts';

export { AUSD, AUSD_DECIMALS, FLOW_API, FLOW_ROUTER };
export const MAX_SWAP_USDC = LIMITS.maxDepositUsdc;
// AUSD is a dollar stablecoin and so is USDC: a quote that returns much less than 98% of the input is refused as
// "price looks off" rather than shown. This is a sanity bound, not a market claim.
export const MIN_OUT_FLOOR_BPS = 9800n;
export const SLIPPAGE_BPS = 50;
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const lc = (s: string): string => s.toLowerCase();
const hex = (n: bigint | number): string => '0x' + n.toString(16);

export type SwapQuote = { amountIn: bigint; output: bigint; minOut: bigint; to: string; data: string };

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok?: boolean; status?: number; json(): Promise<unknown> }>;

export function parseSwapAmount(text: string): { ok: true; amount: bigint } | { ok: false; message: string } {
  let amount: bigint;
  try {
    amount = parseUnits(text.trim(), USDC_DECIMALS);
  } catch {
    return { ok: false, message: 'Enter an amount like 5 or 5.25.' };
  }
  if (amount <= 0n) return { ok: false, message: 'Enter an amount above zero.' };
  if (amount > MAX_SWAP_USDC) return { ok: false, message: `A swap is capped at ${formatUnits(MAX_SWAP_USDC, USDC_DECIMALS)} USDC.` };
  return { ok: true, amount };
}

// Asks Kuru Flow for a route (two calls: a short-lived token for the user's address, then the quote) and checks the
// answer against everything this page is willing to sign. Returns a message instead of a quote on any doubt.
export async function fetchSwapQuote(fetchImpl: FetchLike, user: string, amountIn: bigint): Promise<{ ok: true; quote: SwapQuote } | { ok: false; message: string }> {
  const post = async (path: string, body: unknown, auth?: string): Promise<Record<string, unknown>> => {
    const r = await fetchImpl(`${FLOW_API}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body) });
    if (r.ok === false) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as Record<string, unknown>;
  };
  try {
    const tok = await post('/api/generate-token', { user_address: user });
    if (typeof tok.token !== 'string') return { ok: false, message: 'Kuru Flow did not give a session token. Try again in a moment.' };
    const q = await post('/api/quote', { userAddress: user, tokenIn: CHAIN.usdc, tokenOut: AUSD, amount: amountIn.toString(), slippageTolerance: SLIPPAGE_BPS, autoSlippage: true }, tok.token);
    return checkQuote(q, amountIn);
  } catch (e) {
    return { ok: false, message: `Kuru Flow could not be reached (${(e as Error)?.message ?? e}). Nothing was sent.` };
  }
}

export function checkQuote(q: Record<string, unknown>, amountIn: bigint): { ok: true; quote: SwapQuote } | { ok: false; message: string } {
  const bad = (m: string): { ok: false; message: string } => ({ ok: false, message: `${m} Nothing was sent.` });
  if (q.status !== 'success') return bad(`Kuru Flow found no route${typeof q.message === 'string' ? ` (${q.message})` : ''}.`);
  const tx = q.transaction as { to?: string; calldata?: string; value?: string } | undefined;
  if (!tx || typeof tx.to !== 'string' || typeof tx.calldata !== 'string') return bad('The quote carried no transaction.');
  if (!sameAddress(tx.to, FLOW_ROUTER)) return bad('The quote points at a contract this page does not know, so it was refused.');
  if (tx.value !== undefined && tx.value !== '0') return bad('The quote asks to send MON, which this page never does.');
  const data = tx.calldata.startsWith('0x') ? tx.calldata : '0x' + tx.calldata;
  const c = decodeFlowSwap(data);
  if (!c) return bad('The quote transaction is not a call this page knows.');
  if (!sameAddress(c.tokenIn, CHAIN.usdc) || !sameAddress(c.tokenOut, AUSD)) return bad('The quote swaps other tokens than USDC to AUSD.');
  if (c.amountIn !== amountIn) return bad('The quote is for another amount than you asked for.');
  let output: bigint;
  try {
    output = BigInt(String(q.output));
  } catch {
    return bad('The quote has no readable output amount.');
  }
  if (c.minOut <= 0n || c.minOut > output) return bad('The quote has an unusable minimum output.');
  if (c.minOut * 10000n < amountIn * MIN_OUT_FLOOR_BPS) return bad('The price looks off for a dollar-to-dollar swap, so the quote was refused.');
  return { ok: true, quote: { amountIn, output, minOut: c.minOut, to: tx.to, data } };
}

export const planSwapApprove = (from: string, amount: bigint): PlannedTx => ({ kind: 'swapApprove', from, to: CHAIN.usdc, data: encodeApprove(FLOW_ROUTER, amount), value: '0x0' });
export const planSwap = (from: string, quote: SwapQuote): PlannedTx => ({ kind: 'swap', from, to: quote.to, data: quote.data, value: '0x0' });

export async function readFlowAllowance(rpc: JsonRpc, owner: string, block: number | 'latest' = 'latest'): Promise<bigint> {
  return BigInt(await rpc.call<string>('eth_call', [{ to: CHAIN.usdc, data: encodeCall('allowance', [owner, FLOW_ROUTER]) }, block === 'latest' ? 'latest' : hex(block)]));
}

export type SwapAction = { type: 'approve'; amount: bigint } | { type: 'swap' } | { type: 'blocked'; reason: string };
export function nextSwapAction(s: { amount: bigint; walletUsdc: bigint; walletMon: bigint; allowance: bigint }): SwapAction {
  if (s.amount <= 0n || s.amount > MAX_SWAP_USDC) return { type: 'blocked', reason: `A swap must be above 0 and at most ${formatUnits(MAX_SWAP_USDC, USDC_DECIMALS)} USDC.` };
  if (s.walletMon < LIMITS.minWalletMon) return { type: 'blocked', reason: `Keep at least ${formatUnits(LIMITS.minWalletMon, 18)} MON in the wallet for network fees.` };
  if (s.walletUsdc < s.amount) return { type: 'blocked', reason: `The wallet has ${formatUnits(s.walletUsdc, USDC_DECIMALS)} USDC, less than the ${formatUnits(s.amount, USDC_DECIMALS)} USDC to swap.` };
  return s.allowance < s.amount ? { type: 'approve', amount: s.amount } : { type: 'swap' };
}

// The extra safety check for the swap step: trace the call from the user's own address and require that the ONLY token
// leaving the user is exactly amountIn of USDC, and that at least minOut AUSD arrives at the user. This is what proves
// "the output goes to msg.sender" for a calldata whose recipient is not visible in plain words.
export function swapTraceCheck(sim: JsonRpc, user: string, quote: SwapQuote): (call: { from: string; to: string; data: string; value: string }) => Promise<string | null> {
  return async (call) => {
    let trace: { error?: string; logs?: unknown[]; calls?: unknown[] };
    try {
      trace = await sim.call('debug_traceCall', [call, 'latest', { tracer: 'callTracer', tracerConfig: { withLog: true } }]);
    } catch (e) {
      return `The safety trace could not be run (${(e as Error)?.message ?? e}), so the swap cannot be checked.`;
    }
    if (trace.error) return `The swap would fail (${trace.error}).`;
    const transfers: { token: string; from: string; to: string; amount: bigint }[] = [];
    const walk = (n: { logs?: unknown[]; calls?: unknown[]; error?: string }): void => {
      if (n.error) return void transfers.push({ token: 'error', from: '', to: '', amount: 0n });
      for (const l of (n.logs ?? []) as { address: string; topics: string[]; data: string }[]) {
        if (l.topics?.[0] === TRANSFER && l.topics.length === 3) transfers.push({ token: lc(l.address), from: '0x' + l.topics[1].slice(26), to: '0x' + l.topics[2].slice(26), amount: BigInt(l.data) });
      }
      for (const c of (n.calls ?? []) as { logs?: unknown[]; calls?: unknown[]; error?: string }[]) walk(c);
    };
    walk(trace);
    if (transfers.some((t) => t.token === 'error')) return 'Part of the swap route fails in simulation.';
    const me = lc(user);
    const out = transfers.filter((t) => lc(t.from) === me);
    const stray = out.filter((t) => !(t.token === lc(CHAIN.usdc) && t.to === lc(FLOW_ROUTER)));
    if (stray.length) return 'The swap would move a token from you to somewhere unexpected, so it was refused.';
    const paid = out.reduce((a, t) => a + t.amount, 0n);
    if (paid !== quote.amountIn) return `The swap would take ${paid} raw USDC units instead of exactly ${quote.amountIn}.`;
    const got = transfers.filter((t) => t.token === lc(AUSD) && t.to === me).reduce((a, t) => a + t.amount, 0n);
    if (got < quote.minOut) return 'The swap would not deliver the promised minimum AUSD to your address.';
    return null;
  };
}

export type SwapBefore = { walletUsdc: bigint; walletAusd: bigint };
export async function readSwapBalances(rpc: JsonRpc, account: string, block: number | 'latest' = 'latest'): Promise<SwapBefore> {
  const [walletUsdc, walletAusd] = await Promise.all([rpc.walletBalance(account, CHAIN.usdc, block), rpc.walletBalance(account, AUSD, block)]);
  return { walletUsdc, walletAusd };
}

export async function verifySwapApprove(env: Env, amount: bigint, r: Extract<StepResult, { status: 'confirmed' }>): Promise<Verification> {
  const now = await readFlowAllowance(env.rpc, env.account, r.block);
  return now === amount ? { ok: true, facts: ['The allowance for the Flow router is exactly the approved amount.'], problems: [] } : { ok: false, facts: [], problems: [`Cannot explain: the allowance reads ${now} raw units, expected exactly ${amount}.`] };
}

export async function verifySwap(env: Env, before: SwapBefore, quote: SwapQuote, r: Extract<StepResult, { status: 'confirmed' }>): Promise<Verification & { received: bigint }> {
  const after = await readSwapBalances(env.rpc, env.account, r.block);
  const problems: string[] = [];
  const spent = before.walletUsdc - after.walletUsdc;
  const received = after.walletAusd - before.walletAusd;
  if (spent !== quote.amountIn) problems.push(`Cannot explain: the wallet USDC fell by ${spent} raw units, expected exactly ${quote.amountIn}.`);
  if (received < quote.minOut) problems.push(`Cannot explain: the wallet AUSD rose by ${received} raw units, less than the promised minimum ${quote.minOut}.`);
  return { ok: problems.length === 0, facts: problems.length ? [] : [`USDC fell by exactly ${formatUnits(spent, USDC_DECIMALS)} and AUSD rose by ${formatUnits(received, AUSD_DECIMALS)}, at least the promised ${formatUnits(quote.minOut, AUSD_DECIMALS)}.`], problems, received };
}
