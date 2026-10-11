// The planting flow's engine: wallet access (EIP-1193), chain reads, and the one-transaction-at-a-time executor.
// It never holds a key. Every transaction goes through the same gate:
//   guard -> network and account check -> (book check) -> simulate from the user's address -> gas estimate
//   -> plain announcement the user must accept -> ONE wallet pop-up -> wait for the receipt -> verify on chain.
// Tests drive it with a fake wallet and a fake chain (test/helpers/fakechain.ts); no test signs anything.
import { encodeCall, encodeProvision, revertReason } from './abi.ts';
import { keccak256 } from './keccak.ts';
import { decodeLog, type RawLog } from './events.ts';
import type { JsonRpc } from './rpc.ts';
import { CHAIN, PROVISION_OR_REVERT, crossingBids, guardTx, sameAddress, type PlannedTx } from './plant.ts';
import { NATIVE, quoteForSize, type Market } from './units.ts';
import type { ProvisionBid } from './abi.ts';

export interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export type Env = {
  rpc: JsonRpc; // reads (retries on transient errors)
  sim: JsonRpc; // simulations (no retries: a revert is an answer, not a failure to retry)
  wallet: Eip1193;
  account: string;
  sleep?: (ms: number) => Promise<void>;
  maxReceiptPolls?: number;
};

const hex = (n: bigint | number): string => '0x' + n.toString(16);
const lc = (s: string): string => s.toLowerCase();

// --- wallet ----------------------------------------------------------------------------------------

export type WalletError = { code?: number; message?: string };
const isRejection = (e: unknown): boolean => {
  const x = e as WalletError;
  return x?.code === 4001 || /reject|denied|declined|cancel/i.test(String(x?.message ?? ''));
};

export async function connectWallet(wallet: Eip1193): Promise<{ ok: true; account: string } | { ok: false; message: string }> {
  try {
    const accounts = (await wallet.request({ method: 'eth_requestAccounts' })) as string[];
    if (!accounts?.length) return { ok: false, message: 'The wallet returned no account. Unlock it and try again.' };
    return { ok: true, account: accounts[0] };
  } catch (e) {
    return { ok: false, message: isRejection(e) ? 'You declined the connection in the wallet. Nothing was shared or sent.' : `The wallet could not connect: ${(e as WalletError)?.message ?? e}` };
  }
}

export async function walletChainId(wallet: Eip1193): Promise<number> {
  return Number(BigInt((await wallet.request({ method: 'eth_chainId' })) as string));
}

// Asks the wallet to switch to Monad mainnet (adding it if unknown). Called only after a click.
export async function switchToMonad(wallet: Eip1193): Promise<{ ok: boolean; message: string }> {
  try {
    await wallet.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN.chainIdHex }] });
  } catch (e) {
    if (isRejection(e)) return { ok: false, message: 'You declined the network switch. Switch to Monad mainnet (chain id 143) in the wallet to continue.' };
    if ((e as WalletError)?.code === 4902) {
      try {
        await wallet.request({
          method: 'wallet_addEthereumChain',
          params: [{ chainId: CHAIN.chainIdHex, chainName: CHAIN.chainName, nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 }, rpcUrls: [CHAIN.rpcUrl], blockExplorerUrls: [CHAIN.explorer] }],
        });
      } catch (e2) {
        return { ok: false, message: isRejection(e2) ? 'You declined adding the Monad network.' : `The wallet could not add Monad: ${(e2 as WalletError)?.message ?? e2}` };
      }
    } else return { ok: false, message: `The wallet could not switch networks: ${(e as WalletError)?.message ?? e}` };
  }
  return (await walletChainId(wallet)) === CHAIN.chainId ? { ok: true, message: 'Connected to Monad mainnet.' } : { ok: false, message: 'The wallet is still on another network.' };
}

// --- chain reads ----------------------------------------------------------------------------------------

export type Snapshot = {
  block: number;
  market: Market;
  book: { bestBid: bigint; bestAsk: bigint };
  walletMon: bigint;
  walletUsdc: bigint;
  allowance: bigint;
  marginUsdc: bigint;
  marginMon: bigint;
};

export async function readAllowance(rpc: JsonRpc, owner: string, block: number | 'latest' = 'latest'): Promise<bigint> {
  const data = encodeCall('allowance', [owner, CHAIN.marginAccount]);
  return BigInt(await rpc.call<string>('eth_call', [{ to: CHAIN.usdc, data }, block === 'latest' ? 'latest' : hex(block)]));
}

export async function readSnapshot(rpc: JsonRpc, account: string, block: number | 'latest' = 'latest'): Promise<Snapshot> {
  const head = block === 'latest' ? await rpc.blockNumber() : block;
  const market = await rpc.marketParams(CHAIN.market, block);
  const [book, walletMon, walletUsdc, allowance, marginUsdc, marginMon] = await Promise.all([
    rpc.bestBidAsk(market, block).catch(() => ({ bestBid: 0n, bestAsk: 0n })),
    rpc.walletBalance(account, NATIVE, block),
    rpc.walletBalance(account, CHAIN.usdc, block),
    readAllowance(rpc, account, block),
    rpc.marginBalance(CHAIN.marginAccount, account, CHAIN.usdc, block),
    rpc.marginBalance(CHAIN.marginAccount, account, NATIVE, block),
  ]);
  return { block: head, market, book, walletMon, walletUsdc, allowance, marginUsdc, marginMon };
}

// Orders that are really on the book for this account (the chain is the judge, not our records).
export async function liveOrderIds(rpc: JsonRpc, account: string, candidates: bigint[]): Promise<bigint[]> {
  const live: bigint[] = [];
  for (const id of [...new Set(candidates)]) {
    const o = await rpc.order(CHAIN.market, id);
    if (sameAddress(o.owner, account) && o.size > 0n) live.push(id);
  }
  return live;
}

// --- one transaction ------------------------------------------------------------------------------------

export type Announcement = {
  kind: PlannedTx['kind'];
  to: string;
  gasLimit: bigint;
  gasPriceWei: bigint;
  gasMonWei: bigint; // gasLimit x gasPrice: Monad charges the limit
};

export type Hooks = {
  // Resolve true only when the user has read the statement and pressed the button that opens the wallet pop-up.
  announce(a: Announcement): Promise<boolean>;
  status?(msg: string): void;
};

export type Receipt = { status: string; blockNumber: string; gasUsed: string; effectiveGasPrice: string; logs: RawLog[] };

export type StepResult =
  | { status: 'confirmed'; hash: string; receipt: Receipt; block: number; gasPaidWei: bigint }
  | { status: 'refused' | 'wrong-network' | 'wrong-account' | 'simulation-failed' | 'book-moved' | 'declined' | 'rejected' | 'error'; message: string }
  | { status: 'failed' | 'pending'; message: string; hash: string };

export async function sendStep(env: Env, tx: PlannedTx, hooks: Hooks, opts: { bids?: ProvisionBid[] } = {}): Promise<StepResult> {
  const refusal = guardTx(tx);
  if (refusal) return { status: 'refused', message: refusal };
  if (!sameAddress(tx.from, env.account)) return { status: 'refused', message: 'Refused: the transaction is not from the connected account.' };

  try {
    if ((await walletChainId(env.wallet)) !== CHAIN.chainId) return { status: 'wrong-network', message: 'The wallet is not on Monad mainnet (chain id 143). Switch the network first; nothing was sent.' };
    const accounts = (await env.wallet.request({ method: 'eth_accounts' })) as string[];
    if (!accounts?.length || !sameAddress(accounts[0], env.account)) return { status: 'wrong-account', message: 'The wallet account changed. Reconnect so the page and the wallet use the same account; nothing was sent.' };
  } catch (e) {
    return { status: 'error', message: `Could not check the wallet: ${(e as WalletError)?.message ?? e}` };
  }

  // The book re-quotes several times a second: check it before simulating AND again right before the pop-up.
  const bookCheck = async (): Promise<StepResult | null> => {
    if (tx.kind !== 'plant' || !opts.bids) return null;
    hooks.status?.('Re-reading the order book…');
    const book = await env.rpc.bestBidAsk(await env.rpc.marketParams(CHAIN.market)).catch(() => null);
    if (!book || book.bestAsk <= 0n) return { status: 'book-moved', message: 'The order book could not be read. Nothing was sent; try again.' };
    if (crossingBids(opts.bids, book.bestAsk).length) return { status: 'book-moved', message: 'The market moved: at least one bid is now at or above the best ask and would be rejected. Nothing was sent. Build a fresh preview.' };
    return null;
  };
  const moved = await bookCheck();
  if (moved) return moved;

  const call = { from: tx.from, to: tx.to, data: tx.data, value: tx.value };
  hooks.status?.('Simulating the transaction from your address…');
  try {
    await env.sim.call<string>('eth_call', [call, 'latest']);
  } catch (e) {
    return { status: 'simulation-failed', message: `The simulation failed (${revertReason(e)}), so the wallet pop-up was not opened and nothing was sent.` };
  }
  let gasLimit: bigint;
  let gasPrice: bigint;
  try {
    const est = BigInt(await env.sim.call<string>('eth_estimateGas', [call]));
    gasLimit = (est * 12n) / 10n; // the same 20% margin the Kuru SDK uses
    gasPrice = BigInt(await env.rpc.call<string>('eth_gasPrice', []));
  } catch (e) {
    return { status: 'simulation-failed', message: `The gas estimate failed (${revertReason(e)}), so the wallet pop-up was not opened and nothing was sent.` };
  }

  const go = await hooks.announce({ kind: tx.kind, to: tx.to, gasLimit, gasPriceWei: gasPrice, gasMonWei: gasLimit * gasPrice });
  if (!go) return { status: 'declined', message: 'Cancelled before the wallet pop-up. Nothing was sent.' };
  const movedAgain = await bookCheck(); // the user may have read the statement for a while
  if (movedAgain) return movedAgain;

  let hash: string;
  try {
    hooks.status?.('Waiting for you in the wallet pop-up…');
    hash = (await env.wallet.request({ method: 'eth_sendTransaction', params: [{ ...call, gas: hex(gasLimit) }] })) as string;
  } catch (e) {
    return isRejection(e) ? { status: 'rejected', message: 'You rejected the transaction in the wallet. Nothing was sent.' } : { status: 'error', message: `The wallet could not send the transaction: ${(e as WalletError)?.message ?? e}` };
  }

  hooks.status?.('Sent. Waiting for the block…');
  const sleep = env.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const polls = env.maxReceiptPolls ?? 300;
  for (let i = 0; i < polls; i++) {
    const rc = await env.rpc.call<Receipt | null>('eth_getTransactionReceipt', [hash]).catch(() => null);
    if (rc) {
      const gasPaidWei = BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice);
      if (rc.status !== '0x1') return { status: 'failed', hash, message: 'The transaction was included but failed on chain. Check the explorer; funds did not move for this step.' };
      return { status: 'confirmed', hash, receipt: rc, block: Number(BigInt(rc.blockNumber)), gasPaidWei };
    }
    await sleep(400);
  }
  return { status: 'pending', hash, message: 'No receipt yet. The transaction may still be processing; check the explorer before doing anything else.' };
}

// --- post-conditions ---------------------------------------------------------------------------------------

export type Verification = { ok: boolean; facts: string[]; problems: string[] };
const CANNOT = 'Cannot explain';

function eventsOf(receipt: Receipt) {
  return receipt.logs.map((l) => decodeLog(l)).filter((e): e is NonNullable<ReturnType<typeof decodeLog>> => e !== null);
}

export async function verifyApprove(env: Env, amount: bigint, r: Extract<StepResult, { status: 'confirmed' }>): Promise<Verification> {
  const now = await readAllowance(env.rpc, env.account, r.block);
  return now === amount ? { ok: true, facts: ['The allowance is exactly the approved amount.'], problems: [] } : { ok: false, facts: [], problems: [`${CANNOT}: the allowance reads ${now} raw units, expected exactly ${amount}.`] };
}

export async function verifyDeposit(env: Env, before: Snapshot, amount: bigint, r: Extract<StepResult, { status: 'confirmed' }>): Promise<Verification> {
  const after = await readSnapshot(env.rpc, env.account, r.block);
  const problems: string[] = [];
  if (after.marginUsdc - before.marginUsdc !== amount) problems.push(`${CANNOT}: the margin balance grew by ${after.marginUsdc - before.marginUsdc} raw USDC units, expected exactly ${amount}.`);
  if (before.walletUsdc - after.walletUsdc !== amount) problems.push(`${CANNOT}: the wallet USDC fell by ${before.walletUsdc - after.walletUsdc} raw units, expected exactly ${amount}.`);
  const dep = eventsOf(r.receipt).filter((e) => e.name === 'Deposit' && lc(e.address) === lc(CHAIN.marginAccount) && e.owner === lc(env.account));
  if (dep.length !== 1 || (dep[0].name === 'Deposit' && dep[0].amount !== amount)) problems.push(`${CANNOT}: the expected Deposit event is missing or has another amount.`);
  return { ok: problems.length === 0, facts: problems.length ? [] : ['The margin balance grew by exactly the deposit and the Deposit event matches.'], problems };
}

export async function verifyPlant(env: Env, before: Snapshot, bids: ProvisionBid[], r: Extract<StepResult, { status: 'confirmed' }>): Promise<Verification & { orderIds: bigint[] }> {
  const problems: string[] = [];
  const created = eventsOf(r.receipt).filter((e) => e.name === 'FlipOrderCreated' && lc(e.address) === lc(CHAIN.market) && e.owner === lc(env.account));
  const orderIds = created.map((e) => (e.name === 'FlipOrderCreated' ? e.orderId : 0n));
  if (created.length !== bids.length) problems.push(`${CANNOT}: ${created.length} of ${bids.length} orders were created. Do not plant again; open the ledger and unwind if needed.`);
  const key = (p: bigint, f: bigint, s: bigint): string => `${p}:${f}:${s}`;
  const want = bids.map((b) => key(b.price, b.flipPrice, b.size)).sort();
  const got = created.map((e) => (e.name === 'FlipOrderCreated' ? key(e.price, e.flippedPrice, e.size) : '')).sort();
  if (want.join() !== got.join() || !created.every((e) => e.name === 'FlipOrderCreated' && e.isBuy)) problems.push(`${CANNOT}: the created orders differ from the confirmed preview.`);
  const after = await readSnapshot(env.rpc, env.account, r.block);
  const locked = bids.reduce((a, b) => a + quoteForSize(b.size, b.price, after.market, 'up').value, 0n);
  if (before.marginUsdc - after.marginUsdc !== locked) problems.push(`${CANNOT}: the free margin fell by ${before.marginUsdc - after.marginUsdc} raw USDC units, expected exactly ${locked}.`);
  for (const id of orderIds) {
    const o = await env.rpc.order(CHAIN.market, id, r.block);
    if (!sameAddress(o.owner, env.account) || o.size <= 0n) problems.push(`${CANNOT}: order #${id} is not resting on the book at block ${r.block}.`);
  }
  return { ok: problems.length === 0, facts: problems.length ? [] : [`${created.length} flip bid(s) created, the locked USDC equals the preview to the last unit.`], problems, orderIds };
}

export async function verifyCancel(env: Env, ids: bigint[], r: Extract<StepResult, { status: 'confirmed' }>): Promise<Verification> {
  const problems: string[] = [];
  const cancelled = new Set<bigint>();
  for (const e of eventsOf(r.receipt)) if (e.name === 'FlipOrdersCanceled' && e.owner === lc(env.account)) e.orderIds.forEach((x) => cancelled.add(x));
  for (const id of ids) {
    if (!cancelled.has(id)) problems.push(`${CANNOT}: no cancel event for order #${id}.`);
    const o = await env.rpc.order(CHAIN.market, id, r.block);
    if (o.size > 0n) problems.push(`${CANNOT}: order #${id} still has size on the book.`);
  }
  return { ok: problems.length === 0, facts: problems.length ? [] : [`${ids.length} order(s) cancelled and gone from the book.`], problems };
}

export async function verifyWithdraw(env: Env, before: Snapshot, tokens: string[], r: Extract<StepResult, { status: 'confirmed' }>): Promise<Verification> {
  const problems: string[] = [];
  const after = await readSnapshot(env.rpc, env.account, r.block);
  const w = eventsOf(r.receipt).filter((e) => e.name === 'Withdrawal' && lc(e.address) === lc(CHAIN.marginAccount) && e.owner === lc(env.account));
  for (const t of tokens) {
    const ev = w.find((e) => e.name === 'Withdrawal' && lc(e.token) === lc(t));
    if (!ev) problems.push(`${CANNOT}: no Withdrawal event for ${sameAddress(t, NATIVE) ? 'MON' : 'USDC'}.`);
    const left = sameAddress(t, NATIVE) ? after.marginMon : after.marginUsdc;
    if (left !== 0n) problems.push(`${CANNOT}: ${sameAddress(t, NATIVE) ? 'MON' : 'USDC'} is still in the margin account.`);
    if (ev && ev.name === 'Withdrawal' && !sameAddress(t, NATIVE) && after.walletUsdc - before.walletUsdc !== ev.amount) problems.push(`${CANNOT}: the wallet USDC grew by ${after.walletUsdc - before.walletUsdc}, the event says ${ev.amount}.`);
  }
  return { ok: problems.length === 0, facts: problems.length ? [] : ['Everything came back to the wallet; the margin account is empty.'], problems };
}

// --- preview simulation -----------------------------------------------------------------------------------

const bytesOf = (hexStr: string): Uint8Array => Uint8Array.from((hexStr.replace(/^0x/, '').match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)));

// Storage slot of MarginAccount's balance for (owner, token): keccak(keccak(owner . token) . 1). Same formula as
// scripts/gate.cjs and the Kuru SDK (storageSlots.ts); a test compares it with ethers.
export function marginSlot(owner: string, token: string): string {
  const key = keccak256(bytesOf(owner.slice(2).padStart(40, '0') + token.slice(2).padStart(40, '0')));
  return keccak256(bytesOf(key.slice(2) + '1'.padStart(64, '0')));
}

const randomAddress = (): string => {
  const b = new Uint8Array(20);
  globalThis.crypto.getRandomValues(b);
  return '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
};

// PREVIEW ONLY: simulates the ladder from a throwaway address that is given a pretend margin balance, so the
// visitor can see whether the contract would accept these orders before depositing anything. It proves nothing about
// the visitor's own funds; before each real pop-up the engine simulates again from the visitor's own address.
export async function simulatePreview(sim: JsonRpc, bids: ProvisionBid[]): Promise<{ ok: true } | { ok: false; reason: string }> {
  const from = randomAddress();
  const overrides = {
    [CHAIN.marginAccount]: { stateDiff: { [marginSlot(from, CHAIN.usdc)]: '0x' + 'f'.repeat(64) } },
    [from]: { balance: '0x56bc75e2d63100000' },
  };
  try {
    await sim.call<string>('eth_call', [{ from, to: CHAIN.market, data: encodeProvision(bids, PROVISION_OR_REVERT) }, 'latest', overrides]);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: revertReason(e) };
  }
}
