// The leaderboard page: reads the public ranking from the leaderboard service and lets a wallet opt in.
// The page sends only a public address and a start block, never a signature or a key, and it believes nothing the service
// says without checking its shape. Ranking is by completed round trips, then garden age; never by profit.
export const BOARD_URL = 'https://flip-garden-leaderboard.photogif.workers.dev';

export type Row = { rank: number; address: string; completedRoundTrips: number; gardenAgeDays: number | null; level: string; updatedAt: string };
export type Board = { verifiedOnRealData: boolean; updatedAt: string | null; rows: Row[] };
export type Garden = { address: string; catchingUp: boolean; scannedTo: number; figures: { completedRoundTrips: number; gardenAgeDays: number | null; level: string; updatedAt: string } | null };
export type Joined = { ok: true; alreadyRegistered: boolean } | { ok: false; error: string };

type Fetch = typeof fetch;

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const int = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
const str = (x: unknown, max = 64): x is string => typeof x === 'string' && x.length <= max;

export const isAddress = (s: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(s.trim());

// Keep only well-formed rows; a bad answer shows an empty board instead of breaking the page.
export function parseBoard(j: unknown): Board | null {
  if (!isObj(j) || !Array.isArray(j.rows)) return null;
  const rows: Row[] = [];
  for (const r of j.rows) {
    if (!isObj(r) || !int(r.rank) || !str(r.address) || !int(r.completedRoundTrips) || !str(r.level, 32) || !str(r.updatedAt)) continue;
    rows.push({ rank: r.rank, address: r.address, completedRoundTrips: r.completedRoundTrips, gardenAgeDays: int(r.gardenAgeDays) ? r.gardenAgeDays : null, level: r.level, updatedAt: r.updatedAt });
  }
  return { verifiedOnRealData: j.verifiedOnRealData === true, updatedAt: str(j.updatedAt) ? j.updatedAt : null, rows };
}

export function parseGarden(j: unknown): Garden | null {
  if (!isObj(j) || !str(j.address) || typeof j.catchingUp !== 'boolean' || !int(j.scannedTo)) return null;
  let figures: Garden['figures'] = null;
  const f = j.figures;
  if (isObj(f) && int(f.completedRoundTrips) && str(f.level, 32) && str(f.updatedAt)) figures = { completedRoundTrips: f.completedRoundTrips, gardenAgeDays: int(f.gardenAgeDays) ? f.gardenAgeDays : null, level: f.level, updatedAt: f.updatedAt };
  return { address: j.address, catchingUp: j.catchingUp, scannedTo: j.scannedTo, figures };
}

async function getJson(url: string, f: Fetch): Promise<{ status: number; body: unknown }> {
  const res = await f(url, { method: 'GET', headers: { accept: 'application/json' } });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // not JSON: the caller treats it as an unusable answer
  }
  return { status: res.status, body };
}

export async function fetchBoard(base: string, f: Fetch): Promise<Board | null> {
  const r = await getJson(`${base}/leaderboard`, f);
  return r.status === 200 ? parseBoard(r.body) : null;
}

// null when the wallet is not registered (or the answer is unusable).
export async function fetchGarden(base: string, address: string, f: Fetch): Promise<Garden | null> {
  const r = await getJson(`${base}/garden/${address.trim().toLowerCase()}`, f);
  return r.status === 200 ? parseGarden(r.body) : null;
}

export async function register(base: string, address: string, startBlock: number, f: Fetch): Promise<Joined> {
  if (!isAddress(address)) return { ok: false, error: 'That does not look like a wallet address: 0x followed by 40 hex characters.' };
  if (!Number.isSafeInteger(startBlock) || startBlock < 0) return { ok: false, error: 'The start block must be a whole number.' };
  try {
    const res = await f(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: address.trim(), startBlock }) });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // handled below
    }
    if (res.status === 200 || res.status === 201) return { ok: true, alreadyRegistered: isObj(body) && body.alreadyRegistered === true };
    const msg = isObj(body) && str(body.error, 200) ? body.error : `The leaderboard answered with status ${res.status}.`;
    return { ok: false, error: msg };
  } catch {
    return { ok: false, error: 'The leaderboard could not be reached. Try again later.' };
  }
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const ageText = (d: number | null): string => (d === null ? 'not started' : d === 1 ? '1 day' : `${d} days`);

export function boardHtml(b: Board): string {
  const rows = b.rows
    .map((r) => `<tr><td data-l="Rank">${r.rank}</td><td data-l="Garden">${esc(r.address)}</td><td data-l="Round trips">${r.completedRoundTrips}</td><td data-l="Age">${esc(ageText(r.gardenAgeDays))}</td><td data-l="Level"><span class="pill">${esc(r.level)}</span></td></tr>`)
    .join('');
  const table = b.rows.length
    ? `<table class="grid"><thead><tr><th>Rank</th><th>Garden</th><th>Round trips</th><th>Age</th><th>Level</th></tr></thead><tbody>${rows}</tbody></table>`
    : '<p>No garden is ranked yet. Join below, and yours will appear after the next scan.</p>';
  const note = b.verifiedOnRealData ? '' : '<p class="help">Not yet verified on real data: no completed round trip has been seen on the chain in our own tests, so the counts may change when one is.</p>';
  return `${table}${note}<p class="help">${b.updatedAt ? `Last scan: ${esc(b.updatedAt.replace('T', ' ').slice(0, 16))} UTC.` : 'No scan has finished yet.'}</p>`;
}

export function statusHtml(g: Garden): string {
  if (!g.figures) return `<p>This wallet is registered. ${g.catchingUp ? 'The service is still reading the chain from your start block; this can take a while for an old start block.' : 'Its first figures are being computed.'}</p>`;
  const f = g.figures;
  return `<p>This wallet is registered: <strong>${f.completedRoundTrips}</strong> completed round trip${f.completedRoundTrips === 1 ? '' : 's'}, garden age ${esc(ageText(f.gardenAgeDays))}, level <strong>${esc(f.level)}</strong>.${g.catchingUp ? ' The service is still catching up with the chain, so these figures can still grow.' : ''}</p>`;
}

export type BoardDeps = { base?: string; fetchImpl?: Fetch; prefill?: { address?: string; startBlock?: string } };

export function mountBoard(root: HTMLElement, deps: BoardDeps = {}): void {
  const base = deps.base ?? BOARD_URL;
  const f: Fetch = deps.fetchImpl ?? ((...a) => fetch(...a));
  root.innerHTML = `
  <section class="card"><h2>Leaderboard</h2>
    <p class="help">Gardens are ranked by completed round trips (a flipped sell that filled and flipped back into a buy), then by garden age. Never by profit. Every figure is recomputed from public chain data by a read-only service; nothing you type can change a number.</p>
    <div id="board-table"><p>Loading…</p></div></section>
  <section class="card"><h2>Join the leaderboard</h2>
    <p class="help">Joining shares only your public wallet address and the block where your garden started. No signature, no key, no personal data.</p>
    <form id="board-form" autocomplete="off" novalidate>
      <label for="b-addr">Wallet address</label>
      <input id="b-addr" inputmode="text" spellcheck="false" placeholder="0x…" />
      <label for="b-start">Start block</label>
      <input id="b-start" inputmode="numeric" placeholder="e.g. 112209462" />
      <p class="help">The block just before your first planting. The planting page shows it and the ledger link carries it. An older start block makes the first scan slower.</p>
      <div class="actions"><button type="submit" id="b-join" class="primary">Join</button><button type="button" id="b-check" class="secondary">Check my status</button></div>
    </form>
    <div id="board-msg" aria-live="polite"></div></section>`;
  const $ = <T extends HTMLElement>(id: string): T => root.querySelector('#' + id) as T;
  const addr = $<HTMLInputElement>('b-addr');
  const start = $<HTMLInputElement>('b-start');
  const msg = $('board-msg');
  if (deps.prefill?.address && isAddress(deps.prefill.address)) addr.value = deps.prefill.address;
  if (deps.prefill?.startBlock && /^\d+$/.test(deps.prefill.startBlock)) start.value = deps.prefill.startBlock;

  const say = (html: string, kind = ''): void => {
    msg.innerHTML = `<div class="card ${kind}" role="${kind === 'error' ? 'alert' : 'status'}">${html}</div>`;
  };
  const load = async (): Promise<void> => {
    let b: Board | null = null;
    try {
      b = await fetchBoard(base, f);
    } catch {
      b = null;
    }
    $('board-table').innerHTML = b ? boardHtml(b) : '<p>The leaderboard could not be reached right now. The rest of the page works without it.</p>';
  };
  void load();

  $('board-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (!/^\d[\d,\s_]*$/.test(start.value.trim())) return say('<p>Enter the start block first: the block just before your first planting (the planting page shows it).</p>', 'error');
    const n = Number(start.value.replace(/[,\s_]/g, ''));
    $<HTMLButtonElement>('b-join').disabled = true;
    void register(base, addr.value, n, f)
      .then(async (r) => {
        if (!r.ok) return say(`<p>${esc(r.error)}</p>`, 'error');
        say(`<p>${r.alreadyRegistered ? 'This wallet was already registered.' : 'Registered.'} The service reads your garden from the chain every few minutes; check your status below.</p>`);
        await load();
      })
      .finally(() => {
        $<HTMLButtonElement>('b-join').disabled = false;
      });
  });
  $('b-check').addEventListener('click', () => {
    if (!isAddress(addr.value)) return say('<p>Enter your wallet address first.</p>', 'error');
    void fetchGarden(base, addr.value, f)
      .then((g) => say(g ? statusHtml(g) : '<p>This wallet is not on the leaderboard yet.</p>'))
      .catch(() => say('<p>The leaderboard could not be reached. Try again later.</p>', 'error'));
  });
}
