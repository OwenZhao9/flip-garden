// The Gardener timeline: what it did and why, stored in this browser per wallet and shown on the planting page and in
// the ledger. Pure rendering and validated storage; every dynamic string is escaped. Nothing here is sent anywhere.
import type { TimelineEntry } from '../../src/gardener/runner.ts';
import { formatUnits } from '../../src/units.ts';
import { short, txUrl } from './model.ts';

export type Store = { get(k: string): string | null; set(k: string, v: string): void };
export const MAX_ENTRIES = 200;
export const timelineKey = (address: string): string => `flipgarden:gardener:v1:${address.toLowerCase()}`;

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const isStr = (x: unknown): x is string => typeof x === 'string';
const HASH = /^0x[0-9a-fA-F]{64}$/;

// A stored entry is re-checked field by field: a corrupt or foreign value is dropped, never trusted.
function clean(x: unknown): TimelineEntry | null {
  if (!x || typeof x !== 'object') return null;
  const e = x as Record<string, unknown>;
  if (typeof e.atMs !== 'number' || typeof e.block !== 'number' || !isStr(e.question) || !isStr(e.reason) || !isStr(e.outcome) || !Array.isArray(e.txs)) return null;
  const txs = e.txs.filter((t): t is Record<string, unknown> => !!t && typeof t === 'object').map((t) => ({
    kind: isStr(t.kind) ? t.kind : '?', status: isStr(t.status) ? t.status : '?', hash: isStr(t.hash) && HASH.test(t.hash) ? t.hash : undefined,
    feeWei: isStr(t.feeWei) && /^\d{1,30}$/.test(t.feeWei) ? t.feeWei : '0',
    facts: Array.isArray(t.facts) ? t.facts.filter(isStr) : [], problems: Array.isArray(t.problems) ? t.problems.filter(isStr) : [],
  }));
  return {
    atMs: e.atMs, block: e.block, question: e.question as TimelineEntry['question'], reason: e.reason, outcome: e.outcome, txs,
    choice: isStr(e.choice) ? e.choice : undefined, confidence: typeof e.confidence === 'number' && Number.isFinite(e.confidence) ? e.confidence : undefined,
    source: e.source === 'rules' || e.source === 'jev' ? e.source : undefined, route: e.route === 'act' || e.route === 'ask' || e.route === 'skip' ? e.route : undefined,
    action: isStr(e.action) ? e.action : undefined, ok: typeof e.ok === 'boolean' ? e.ok : undefined,
  };
}

export function loadTimeline(store: Store, address: string): TimelineEntry[] {
  try {
    const raw = JSON.parse(store.get(timelineKey(address)) ?? '[]');
    return Array.isArray(raw) ? raw.map(clean).filter((e): e is TimelineEntry => e !== null).slice(0, MAX_ENTRIES) : [];
  } catch {
    return [];
  }
}

export function saveEntry(store: Store, address: string, e: TimelineEntry): void {
  store.set(timelineKey(address), JSON.stringify([e, ...loadTimeline(store, address)].slice(0, MAX_ENTRIES)));
}

const QUESTION: Record<string, string> = { tend: 'Tend a bid', recover: 'Recover', hedge: 'Hedge ratio', harvest: 'Harvest', refuel: 'Network-fee MON', stop: 'Stopped' };
const ROUTE: Record<string, string> = { act: 'acted alone', ask: 'asked you', skip: 'did nothing' };

export function entryHtml(e: TimelineEntry): string {
  const when = new Date(e.atMs).toLocaleTimeString('en-GB');
  const who = e.source === 'jev' ? 'Jev' : e.source === 'rules' ? 'rules' : '';
  const choice = e.choice ? `<strong>${esc(e.choice)}</strong>${e.confidence !== undefined ? ` · confidence ${e.confidence.toFixed(2)}` : ''}${who ? ` · ${esc(who)}` : ''}${e.route ? ` · ${esc(ROUTE[e.route])}` : ''}` : '';
  const txs = e.txs.map((t) => {
    const link = t.hash ? `<a class="tap" href="${esc(txUrl(t.hash))}" target="_blank" rel="noopener">${esc(short(t.hash))}</a>` : 'not sent';
    const fee = t.feeWei !== '0' ? ` · fee ${esc(formatUnits(BigInt(t.feeWei), 18, 6))} MON` : '';
    const check = t.problems.length ? `<span class="bad">${esc(t.problems.join(' '))}</span>` : t.facts.length ? `<span class="ok">${esc(t.facts.join(' '))}</span>` : '';
    return `<li>${esc(t.kind)}: ${link}${fee}${check ? ` · ${check}` : ''}</li>`;
  }).join('');
  const cls = e.ok === false ? 'bad' : e.ok === true ? 'ok' : '';
  return `<li class="${cls}"><p><span class="help">${esc(when)} · block ${e.block.toLocaleString('en-US')}</span> · ${esc(QUESTION[e.question] ?? e.question)}${choice ? ` · ${choice}` : ''}</p>
    <p>${e.action ? `${esc(e.action)} ` : ''}<span class="help">Why: ${esc(e.reason)}</span></p><p>${esc(e.outcome)}</p>${txs ? `<ul class="events">${txs}</ul>` : ''}</li>`;
}

export function timelineHtml(entries: TimelineEntry[], o: { limit?: number; title?: string } = {}): string {
  if (!entries.length) return '';
  const shown = entries.slice(0, o.limit ?? 30);
  return `<section class="card" id="g-timeline"><h2>${esc(o.title ?? 'Gardener timeline')}</h2>
    <p class="help">Every decision the Gardener carried out or asked about, newest first: the question, the option chosen, its confidence, the exact transaction and the check against the chain. Stored in this browser only.</p>
    <ul class="events gardener-log">${shown.map(entryHtml).join('')}</ul>${entries.length > shown.length ? `<p class="help">${entries.length - shown.length} older entries are not shown.</p>` : ''}</section>`;
}
