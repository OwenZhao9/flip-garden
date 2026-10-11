// A Mera passkey wallet that speaks EIP-1193, so the planting engine (src/flow.ts) works unchanged.
//
// KEY RULE (approved by the owner for this path only): the passkey's secret bytes and the derived key exist ONLY in
// memory, for ONE signing session. They are never written to localStorage, sessionStorage, IndexedDB, the console or
// the network, and the session ends on an explicit lock, after idle time, when the page is hidden and on reload.
// The only network traffic is JSON-RPC to the Monad RPC (reads and the raw signed transaction).
//
// Limits we cannot fix from JavaScript: the BIP-39 phrase that Mera's published mapping builds from the passkey bytes
// is a string, and strings cannot be wiped; it waits for garbage collection like any string. Every byte array we own
// is zeroed as soon as it has been handed on.
import { createSecp256k1SigningSession, isMeraError, createPasskeyWithPrfOutput, getPasskeyPrfOutput, type Secp256k1SigningSession } from '@category-labs/mera';
import { toViemAccount } from '@category-labs/mera/viem';
import { HDKey } from '@scure/bip32';
import { entropyToMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import type { LocalAccount } from 'viem';
import type { Eip1193 } from '../../src/flow.ts';

export const CHAIN_ID = 143;
export const CHAIN_ID_HEX = '0x8f';
export const ACCOUNT_PATH = "m/44'/60'/0'/0/0"; // the first Ethereum account, as in Mera's own recipe
export const PRODUCTION_HOST = 'owenzhao9.github.io'; // a passkey account is bound to its host: never change it once accounts exist
export const DEFAULT_IDLE_MS = 5 * 60 * 1000;

export type LockReason = 'button' | 'idle' | 'page-hide' | 'error';
export type RpcError = Error & { code: number };
const rpcError = (code: number, message: string): RpcError => Object.assign(new Error(message), { code });
const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

// The two passkey ceremonies, behind an interface so tests can use a stub that returns fixed bytes.
export interface PasskeyCeremony {
  create(): Promise<Uint8Array>; // first time: creates a passkey (one or two prompts) and returns 32 secret bytes
  signIn(): Promise<Uint8Array>; // later: asks for the passkey (one prompt) and returns the same 32 secret bytes
}

export function browserCeremony(rpId: string): PasskeyCeremony {
  return {
    create: async () => (await createPasskeyWithPrfOutput({ rp: { id: rpId, name: 'Flip Garden' }, user: { name: 'flip-garden', displayName: 'Flip Garden' } })).prfOutput,
    signIn: async () => (await getPasskeyPrfOutput({ rpId })).prfOutput,
  };
}

// Plain-words messages for the failures a visitor can actually meet.
export function describePasskeyError(e: unknown): string {
  if (isMeraError(e)) {
    switch (e.code) {
      case 'PRF_UNAVAILABLE':
        return 'This browser or passkey provider cannot derive a secret from a passkey (the WebAuthn PRF feature). Nothing was created and nothing is stored. Try Safari or Chrome on iOS 18 or later with iCloud Keychain, Chrome on Android, or desktop Chrome with Google Password Manager.';
      case 'PASSKEY_OPERATION_FAILED':
        return 'The passkey prompt was cancelled or failed. Nothing was created and nothing was sent.';
      case 'CRYPTO_UNAVAILABLE':
        return 'This browser lacks a cryptography feature the passkey login needs. Use a current browser over HTTPS.';
      default:
        return `The passkey login failed (${e.code}). Nothing was sent.`;
    }
  }
  return `The passkey login failed: ${(e as Error)?.message ?? e}`;
}

export type MeraProviderOptions = {
  ceremony: PasskeyCeremony;
  rpcUrl: string;
  fetch?: typeof fetch;
  idleMs?: number;
  // injectable for tests
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  // the object that fires 'pagehide' (window in the browser)
  lifecycle?: EventTarget;
  onChange?: (s: { unlocked: boolean; address?: string; reason?: LockReason }) => void;
};

// Derives the first Ethereum key from the passkey bytes exactly as Mera's "Send a transaction with viem" recipe does,
// so the same passkey gives the same address in every Mera app on this host. Zeroes what it can.
function sessionFromPrf(prf: Uint8Array): Secp256k1SigningSession {
  const seed = mnemonicToSeedSync(entropyToMnemonic(prf, wordlist));
  const node = HDKey.fromMasterSeed(seed).derive(ACCOUNT_PATH);
  const key = node.privateKey;
  if (!key) throw new Error('derivation produced no key');
  try {
    return createSecp256k1SigningSession({ privateKey: key }); // the session keeps its own copy
  } finally {
    key.fill(0);
    seed.fill(0);
    prf.fill(0);
  }
}

export class MeraProvider implements Eip1193 {
  readonly isMera = true; // lets the planting page word its confirmation for an in-page signer
  private session: Secp256k1SigningSession | null = null;
  private account: LocalAccount<'mera'> | null = null;
  private timer: unknown = null;
  private pending: Promise<string> | null = null;
  private readonly o: Required<Pick<MeraProviderOptions, 'idleMs'>> & MeraProviderOptions;
  private readonly onHide = (): void => this.lock('page-hide');
  private rpcId = 1;

  constructor(opts: MeraProviderOptions) {
    this.o = { idleMs: DEFAULT_IDLE_MS, ...opts };
    opts.lifecycle?.addEventListener('pagehide', this.onHide);
  }

  get address(): string | null {
    return this.account?.address ?? null;
  }
  get unlocked(): boolean {
    return this.session !== null;
  }

  dispose(): void {
    this.lock('button');
    this.o.lifecycle?.removeEventListener('pagehide', this.onHide);
  }

  // Runs the passkey ceremony and opens a signing session. `mode` is chosen by the visitor's button.
  unlock(mode: 'create' | 'signin'): Promise<string> {
    if (this.account) return Promise.resolve(this.account.address);
    if (this.pending) return this.pending;
    this.pending = (async () => {
      try {
        const prf = await (mode === 'create' ? this.o.ceremony.create() : this.o.ceremony.signIn());
        const session = sessionFromPrf(prf);
        this.session = session;
        this.account = toViemAccount(session);
        this.arm();
        this.o.onChange?.({ unlocked: true, address: this.account.address });
        return this.account.address;
      } finally {
        this.pending = null;
      }
    })();
    return this.pending;
  }

  lock(reason: LockReason): void {
    const had = this.session !== null;
    this.session?.end(); // zeroes the key inside the session; every later signing call throws SESSION_ENDED
    this.session = null;
    this.account = null;
    if (this.timer !== null) (this.o.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
    if (had) this.o.onChange?.({ unlocked: false, reason });
  }

  private arm(): void {
    if (this.timer !== null) (this.o.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = (this.o.setTimer ?? ((fn, ms) => setTimeout(fn, ms)))(() => this.lock('idle'), this.o.idleMs);
    (this.timer as { unref?: () => void } | null)?.unref?.(); // Node only: a pending idle timer must not keep a process alive
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const f = this.o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    const res = await f(this.o.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: this.rpcId++, method, params }) });
    const j = (await res.json()) as { result?: T; error?: { code?: number; message?: string } };
    if (j.error) throw rpcError(j.error.code ?? -32000, j.error.message ?? 'RPC error');
    return j.result as T;
  }

  async request({ method, params = [] }: { method: string; params?: unknown[] }): Promise<unknown> {
    switch (method) {
      case 'eth_chainId':
        return CHAIN_ID_HEX;
      case 'net_version':
        return String(CHAIN_ID);
      case 'eth_accounts':
        return this.account ? [this.account.address] : [];
      case 'eth_requestAccounts':
        try {
          return [await this.unlock('signin')];
        } catch (e) {
          throw rpcError(isMeraError(e) && e.code === 'PASSKEY_OPERATION_FAILED' ? 4001 : 4100, describePasskeyError(e));
        }
      case 'wallet_switchEthereumChain': {
        const id = (params[0] as { chainId?: string } | undefined)?.chainId;
        if (id && id.toLowerCase() === CHAIN_ID_HEX) return null;
        throw rpcError(4902, 'The passkey wallet works on Monad mainnet (chain id 143) only.');
      }
      case 'eth_sendTransaction':
        return this.send((params[0] ?? {}) as Record<string, string | undefined>);
      default:
        throw rpcError(4200, `The passkey wallet does not support ${method}.`);
    }
  }

  private async send(tx: Record<string, string | undefined>): Promise<string> {
    const account = this.account;
    if (!account || !this.session) throw rpcError(4100, 'The passkey session is locked. Sign in again; nothing was sent.');
    this.arm(); // activity restarts the idle clock
    if (!tx.from || !sameAddress(tx.from, account.address)) throw rpcError(4100, 'The transaction is not from the signed-in account.');
    if (!tx.to || !/^0x[0-9a-fA-F]{40}$/.test(tx.to)) throw rpcError(-32602, 'The transaction needs a destination address.');
    const data = (tx.data ?? '0x') as `0x${string}`;
    if (!/^0x([0-9a-fA-F]{2})*$/.test(data)) throw rpcError(-32602, 'The transaction data is not valid hex.');
    const value = tx.value ? BigInt(tx.value) : 0n;
    const [nonce, gasPrice] = await Promise.all([this.rpc<string>('eth_getTransactionCount', [account.address, 'pending']), this.rpc<string>('eth_gasPrice', [])]);
    const gas = tx.gas ? BigInt(tx.gas) : BigInt(await this.rpc<string>('eth_estimateGas', [{ from: account.address, to: tx.to, data, value: '0x' + value.toString(16) }]));
    if (!this.session) throw rpcError(4100, 'The passkey session was locked before signing; nothing was sent.');
    let raw: `0x${string}`;
    try {
      // A legacy transaction with the node's own gas price, like the Kuru SDK's deposit and cancel calls.
      raw = await account.signTransaction({ type: 'legacy', chainId: CHAIN_ID, nonce: Number(BigInt(nonce)), gasPrice: BigInt(gasPrice), gas, to: tx.to as `0x${string}`, value, data });
    } catch (e) {
      if (isMeraError(e) && e.code === 'SESSION_ENDED') throw rpcError(4100, 'The passkey session ended before signing; nothing was sent.');
      throw e;
    }
    return this.rpc<string>('eth_sendRawTransaction', [raw]);
  }
}
