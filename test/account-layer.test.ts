// Mera is the entire account layer: no browser wallet, nothing stored that identity depends on. These checks read the
// source text, so they run without the web dependencies installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const src = (f: string): string => fs.readFileSync(path.join(import.meta.dirname, '..', 'web', 'src', f), 'utf8');
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the planting and hedge pages no longer look for a browser wallet', () => {
  for (const f of ['plant.ts', 'hedge.ts', 'main.ts', 'passkey.ts', 'session.ts']) {
    const code = strip(src(f));
    assert.ok(!/eip6963|window\.ethereum|announceProvider/.test(code), `${f} must not detect browser wallets`);
  }
});

test('both pages sign in with the passkey session and still accept an injected provider for the fake test pages', () => {
  for (const f of ['plant.ts', 'hedge.ts']) {
    const code = strip(src(f));
    assert.match(code, /renderSignIn\(/, `${f} shows the passkey sign-in`);
    assert.match(code, /providers \?\? \[\{ name: 'Passkey \(Mera\)'/, `${f} defaults to the passkey session`);
    assert.ok(!/extraProviders/.test(code), `${f} has no second account path`);
  }
});

test('stateless: the account layer never reads or writes browser storage, cookies or a credential id', () => {
  for (const f of ['mera-provider.ts', 'session.ts', 'passkey.ts']) {
    const code = strip(src(f));
    assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie|credentialId|rawId/.test(code), `${f} must not store anything identity depends on`);
  }
  // Sign-in asks the browser for any passkey of this site, without a stored id: a cleared browser or a new device works.
  assert.match(strip(src('mera-provider.ts')), /getPasskeyPrfOutput\(\{ rpId \}\)/);
});

test('the signed-out lock bar offers sign-in on every page, and the read-only ledger does not require it', () => {
  const session = strip(src('session.ts'));
  assert.match(session, /renderSignIn\(el\.querySelector\('#lockbar-signin'\)/);
  const main = strip(src('main.ts'));
  assert.ok(!/mera\(\)\.unlock|renderSignIn/.test(main.slice(main.indexOf('function initLedger'), main.indexOf('let leavePage'))), 'the ledger page never asks for a sign-in');
});
