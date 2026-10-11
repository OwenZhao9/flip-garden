#!/usr/bin/env node
'use strict';
/**
 * Generates a brand-new throwaway test wallet.
 *
 * - The private key is shown ONLY on an interactive terminal, once, and is never written to disk or logs.
 * - The script refuses to run when stdin/stdout are not a terminal, so no tool, pipe, redirect or log
 *   (including an AI assistant running commands for you) can capture the key.
 * - After you press Enter the key is wiped from the screen and scrollback; only the public address stays.
 */
const readline = require('readline');
const { ethers } = require('ethers');

if (!process.stdout.isTTY || !process.stdin.isTTY) {
  console.error(
    '\n❌ Run this directly in your own terminal window (the macOS Terminal app is recommended).\n' +
      '   Do not run it through another program, a pipe or a redirect: no tool or log may capture the private key.\n',
  );
  process.exit(1);
}

// A terminal pane that belongs to the Claude app (or any Claude session) echoes its output into the chat,
// which would leak the key. Only well-known standalone terminals are accepted; checked BEFORE a key exists.
const SAFE_TERMINALS = new Set(['Apple_Terminal', 'iTerm.app', 'ghostty', 'WarpTerminal', 'WezTerm']);
const inClaude = Object.keys(process.env).some((k) => k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_'));
const override = process.argv.includes('--i-know-this-terminal-is-private');
if (inClaude || (!SAFE_TERMINALS.has(process.env.TERM_PROGRAM || '') && !override)) {
  console.error(
    '\n❌ This window is not safe: its output may be copied into a Claude conversation, which would leak the private key.\n' +
      '   Open the macOS Terminal app (press Cmd+Space and type Terminal), paste the command there and run it.\n' +
      '   Do not click a Run button in a chat, and do not use the terminal panel inside the Claude window.\n',
  );
  process.exit(1);
}

const w = ethers.Wallet.createRandom();

console.log(`
==== New throwaway test wallet (for the real-funds test only) ====

Wallet address (public information; also the address others use to send you funds):
  ${w.address}

Private key (full control of this wallet; shown only this once):
  ${w.privateKey}

Please do three things now:
  1. Store the private key in a password manager (or an encrypted note). If you lose it, the funds in this wallet are gone.
  2. Do not send it to anyone and do not paste it into any chat, including one with an AI assistant.
  3. Press Enter once it is stored; the private key is then wiped from the screen.
`);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Is the private key stored? Press Enter to wipe it from the screen: ', () => {
  rl.close();
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
  console.log(`✅ The private key has been wiped from the screen.

Your test wallet address (public):
  ${w.address}

Next: share this address, and say where your funds are now (an exchange or a wallet).
Then use it for the preflight:
  export ADDRESS=${w.address}
`);
});
