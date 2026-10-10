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
    '\n❌ 请在你自己的终端窗口里直接运行（推荐 macOS 自带的“终端”App）。\n' +
      '   不要通过别的程序、管道或重定向运行：私钥不能被任何工具或日志捕获。\n',
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
    '\n❌ 这个窗口不安全：这里的输出可能会被带进 Claude 对话，私钥会泄露。\n' +
      '   请打开 macOS 自带的“终端”App（按 Cmd+空格，输入“终端”），把命令复制进去再运行。\n' +
      '   不要点聊天里的“运行”按钮，也不要用 Claude 窗口里的终端面板。\n',
  );
  process.exit(1);
}

const w = ethers.Wallet.createRandom();

console.log(`
==== 新的测试钱包（只用于这次实测）====

钱包地址（公开信息，可以发给 Claude，也是别人给你转账用的地址）:
  ${w.address}

私钥（等于这个钱包的全部权限；只在这里显示这一次）:
  ${w.privateKey}

请现在就做三件事：
  1. 把私钥存进密码管理器（或加密备忘录）。丢了就取不回里面的钱。
  2. 不要发给任何人，也不要贴到聊天里，包括 Claude。
  3. 存好之后按回车，屏幕上的私钥会被清除。
`);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('私钥已经存好了吗？按回车清除屏幕上的私钥: ', () => {
  rl.close();
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
  console.log(`✅ 私钥已从屏幕清除。

你的测试钱包地址（公开）:
  ${w.address}

下一步：把这个地址发给 Claude，并告诉他你的钱现在在哪（交易所 / 钱包）。
之后跑预检时用：
  export ADDRESS=${w.address}
`);
});
