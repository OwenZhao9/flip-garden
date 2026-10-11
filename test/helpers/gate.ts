// Loads the real 2026-10-10 gate-test data (Monad mainnet) into ledger inputs.
import fs from 'node:fs';
import path from 'node:path';
import { decodeLog, type KuruEvent } from '../../src/events.ts';
import { marketFromJson, NATIVE, type Market } from '../../src/units.ts';
import type { OwnTx } from '../../src/ledger.ts';
import type { ChainState } from '../../src/reconcile.ts';

const dir = path.join(import.meta.dirname, '..', 'fixtures');
export const fx = JSON.parse(fs.readFileSync(path.join(dir, 'gate-test-2026-10-10.json'), 'utf8'));
export const raw = JSON.parse(fs.readFileSync(path.join(dir, 'gate-test-2026-10-10.raw.json'), 'utf8'));

export const WALLET: string = raw.wallet;
export const USDC: string = raw.quoteToken;
export const MON = NATIVE;

export const market: Market = marketFromJson({ ...fx.market, quoteAsset: USDC }, raw.market);

export const events: KuruEvent[] = raw.logs.map((l: never) => {
  const e = decodeLog(l);
  if (!e) throw new Error('fixture log did not decode');
  return e;
});

export const txs: OwnTx[] = raw.txs.map((t: Record<string, string>) => ({
  hash: t.hash,
  block: Number(t.blockNumber),
  from: t.from,
  gasLimit: BigInt(t.gas),
  gasUsed: BigInt(t.gasUsed),
  effectiveGasPrice: BigInt(t.effectiveGasPrice),
  status: Number(t.status),
}));

export const snap = (name: string): Record<string, string | number> => fx.snapshots.find((s: { name: string }) => s.name === name);

// A fixture snapshot as the chain state the reconciler expects.
export function chainAt(name: string): ChainState {
  const s = snap(name);
  return {
    block: Number(s.block),
    margin: { [USDC]: BigInt(s.marginUsdc), [MON]: BigInt(s.marginMon) },
    locked: { [USDC]: BigInt(s.lockedQuote), [MON]: BigInt(s.lockedBase) },
    wallet: { [USDC]: BigInt(s.walletUsdc), [MON]: BigInt(s.walletMon) },
  };
}
