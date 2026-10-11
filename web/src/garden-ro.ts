// The read-only garden card on the ledger page: growth stages, level and achievements for any wallet, no actions.
import { gardenSpan } from '../../src/garden.ts';
import { JsonRpc } from '../../src/rpc.ts';
import { ageSecondsBetween } from './blocktimes.ts';
import { mountGardenPanel } from './garden-ui.ts';
import { buildGardenView, ledgerOfBundle } from './garden-view.ts';
import type { Bundle } from './model.ts';

export async function mountGardenReadOnly(result: HTMLElement, b: Bundle, rpcUrl: string, fetchImpl?: typeof fetch): Promise<void> {
  const ledger = ledgerOfBundle(b);
  if (ledger.orders.size === 0) return;
  const host = document.createElement('section');
  host.className = 'card full';
  host.id = 'garden-growth';
  const anchor = result.querySelector('ul.garden')?.closest('section');
  if (anchor) anchor.after(host);
  else result.append(host);
  const panel = mountGardenPanel(host, undefined, { address: b.account });
  const span = gardenSpan(ledger, b.market.address);
  panel.update(buildGardenView(ledger, b.market, b.symbols, null), { lastRead: `Read at block ${b.endBlock.toLocaleString('en-US')}. The ledger page reads once; the planting page refreshes by itself.` });
  const age = await ageSecondsBetween(new JsonRpc(rpcUrl, { fetch: fetchImpl ?? ((...a) => fetch(...a)) }), span.firstBlock, span.lastBlock);
  if (age !== null) panel.update(buildGardenView(ledger, b.market, b.symbols, age));
}
