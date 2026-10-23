// Send MON, USDC or AUSD from the signed-in account to another wallet the user names (for example their own MetaMask).
// One transaction per send: a plain MON transfer, or an ERC-20 transfer(to, amount) on USDC or AUSD. Guarded like every
// other step: the call is decoded, the asset and the amount are checked against caps, and afterwards both balances are
// re-read from the chain.
import { decodeArgs, encodeArgs, selector } from './abi.ts';
import type { Env, StepResult, Verification } from './flow.ts';
import { CHAIN, USDC_DECIMALS, sameAddress, type PlannedTx } from './plant.ts';
import type { JsonRpc } from './rpc.ts';
import { AUSD, AUSD_DECIMALS } from './swapguard.ts';
import { NATIVE, formatUnits } from './units.ts';

export type SendAsset = 'MON' | 'USDC' | 'AUSD';
export const SEND_ASSETS: Record<SendAsset, { token: string; decimals: number; cap: bigint }> = {
  MON: { token: NATIVE, decimals: 18, cap: 2_000n * 10n ** 18n },
  USDC: { token: CHAIN.usdc, decimals: USDC_DECIMALS, cap: 100n * 10n ** 6n },
  AUSD: { token: AUSD, decimals: AUSD_DECIMALS, cap: 100n * 10n ** 6n },
};
// MON kept back when the user sends "all" MON, so the network fee of this transfer is still covered.
export const MON_FEE_RESERVE = 10n ** 16n; // 0.01 MON

const TRANSFER = selector('transfer(address,uint256)');
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export const isRecipient = (s: string): boolean => ADDRESS.test(s.trim()) && !/^0x0{40}$/i.test(s.trim());

export function planSend(from: string, recipient: string, asset: SendAsset, amount: bigint): PlannedTx {
  const to = recipient.trim();
  if (asset === 'MON') return { kind: 'send', from, to, data: '0x', value: '0x' + amount.toString(16) } as unknown as PlannedTx;
  return { kind: 'send', from, to: SEND_ASSETS[asset].token, data: TRANSFER + encodeArgs(['address', 'uint256'], [to, amount]), value: '0x0' } as unknown as PlannedTx;
}

// What a send transaction does, read back from the call itself. null when it is not a send this page would make.
export function readSend(tx: { to: string; data: string; value: string }): { asset: SendAsset; recipient: string; amount: bigint } | null {
  const value = BigInt(tx.value || '0x0');
  if (tx.data === '0x' || tx.data === '') return { asset: 'MON', recipient: tx.to, amount: value };
  if (value !== 0n || !tx.data.toLowerCase().startsWith(TRANSFER)) return null;
  const asset = (['USDC', 'AUSD'] as const).find((a) => sameAddress(tx.to, SEND_ASSETS[a].token));
  if (!asset) return null;
  try {
    const [recipient, amount] = decodeArgs(['address', 'uint256'], tx.data.slice(10)) as [string, bigint];
    return { asset, recipient, amount };
  } catch {
    return null;
  }
}

export function guardSend(tx: { from: string; to: string; data: string; value: string }): string | null {
  const s = readSend(tx);
  if (!s) return 'Refused: a send moves only MON, USDC or AUSD, as a plain transfer.';
  if (!isRecipient(s.recipient)) return 'Refused: the recipient is not a valid address.';
  if (sameAddress(s.recipient, tx.from)) return 'Refused: the recipient is this same account.';
  if (sameAddress(s.recipient, CHAIN.usdc) || sameAddress(s.recipient, AUSD)) return 'Refused: the recipient is a token contract, not a wallet.';
  if (s.amount <= 0n) return 'Refused: the amount must be above 0.';
  if (s.amount > SEND_ASSETS[s.asset].cap) return `Refused: at most ${formatUnits(SEND_ASSETS[s.asset].cap, SEND_ASSETS[s.asset].decimals)} ${s.asset} per send.`;
  return null;
}

export async function balanceOf(rpc: JsonRpc, user: string, asset: SendAsset): Promise<bigint> {
  return rpc.walletBalance(user, SEND_ASSETS[asset].token);
}

// After the receipt: the recipient gained exactly the amount; the sender lost exactly the amount (plus the fee for MON).
export async function verifySend(env: Env, plan: { asset: SendAsset; recipient: string; amount: bigint }, before: { sender: bigint; recipient: bigint }, r: Extract<StepResult, { status: 'confirmed' }>): Promise<Verification> {
  const at = r.block;
  const [sender, recipient] = await Promise.all([env.rpc.walletBalance(env.account, SEND_ASSETS[plan.asset].token, at), env.rpc.walletBalance(plan.recipient, SEND_ASSETS[plan.asset].token, at)]);
  const problems: string[] = [];
  const fee = plan.asset === 'MON' ? r.gasPaidWei : 0n;
  if (recipient - before.recipient !== plan.amount) problems.push(`Cannot explain: the recipient's ${plan.asset} changed by ${recipient - before.recipient} raw units, expected ${plan.amount}.`);
  if (before.sender - sender !== plan.amount + fee) problems.push(`Cannot explain: this account's ${plan.asset} fell by ${before.sender - sender} raw units, expected ${plan.amount + fee}.`);
  const d = SEND_ASSETS[plan.asset].decimals;
  return problems.length ? { ok: false, problems, facts: [] } : { ok: true, problems: [], facts: [`${formatUnits(plan.amount, d)} ${plan.asset} arrived at ${plan.recipient}; both balances were re-read from the chain.`] };
}
