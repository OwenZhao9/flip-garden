# Flip Garden（翻转花园）

在 Monad 上，用 Kuru 的“翻转单”（限价单成交后自动挂出反向单，每走完一轮赚一次价差，不用机器人）做的游戏化散户做市工具。

当前阶段：**第 0 步门槛实测**。用几美元真钱在 Monad 主网跑通一整圈：下翻转买单 → 成交 → 自动翻出卖单 → 账本读数 → 撤单提现，并确认“按成交推算的盈亏”和“链上余额变化”对得上。通过才继续做产品；不通过就换方案。

## 实测前要知道的三件事

- 这个市场（MON-USDC）**最小下单量 200 MON，约 4.95 美元**（2026-10-10 链上读数）。所以预算要准备约 **6–7 USDC + 约 5 MON（付 gas）**，不是 1–2 美元。
- 脚本**默认只演练**。只有命令带 `--live` 并且你在终端里输入 `YES`，才会发真实交易。
- 私钥只放在当次终端的环境变量里，不写进任何文件，不贴到聊天里。

## 准备（你做）

1. 新建一个**只用于测试**的钱包。请把下面这条**复制到** macOS 自带的“终端”App 里运行（Cmd+空格，输入“终端”）。不要点聊天里的“运行”按钮，也不要用 Claude 窗口里的终端面板：那里的输出会进入对话，私钥就泄露了（脚本检测到会拒绝运行）。私钥只显示在你的屏幕上，不写进任何文件，按回车后会从屏幕清除：

```bash
cd ~/Projects/flip-garden && node scripts/new-wallet.cjs
```

   然后往这个地址转入：约 7 USDC（Monad 主网）+ 约 5 MON。转账时**网络一定要选 Monad 主网**，选错网络钱会丢。
2. 依赖已经装好（需要重装时：`npm install`）。进入项目目录：

```bash
cd ~/Projects/flip-garden
```

3. 先只填**钱包地址**（公开信息，不是私钥），所有“演练”命令都只需要它：

```bash
export ADDRESS=0x你的测试钱包地址
```

4. 只有带 `--live` 的真实交易才需要私钥。到那一步再设置（输入时不显示，也不会进命令历史；关掉终端窗口即失效）。**设置私钥和所有带 `--live` 的命令，都只在 macOS“终端”App 里做**。设置私钥时要先清掉上面的 ADDRESS：

```bash
unset ADDRESS; read -rs "PRIVATE_KEY?粘贴测试钱包私钥（输入时不显示）: " && export PRIVATE_KEY && echo
```

## 按顺序运行

```bash
node scripts/gate.cjs preflight
```

只读预检：链、市场、模拟下单、钱包余额。全是 ✅ 才往下。

```bash
node scripts/gate.cjs plant --sim-funds
```

可选演练：不需要有钱，也不需要私钥，直接看“会下什么单、合约认不认”。

```bash
node scripts/gate.cjs deposit --usdc 6 --live
```

授权恰好 6 USDC 并存入 Kuru 保证金账户。

```bash
node scripts/gate.cjs plant --orders 1 --live
```

先模拟，再真下 1 张翻转买单（默认 201 MON；挂在卖一下方 1 个最小报价单位，这是买单能挂的最高价，做市机器人加不了价，只能排在我们后面；成交后在约 +0.1% 处自动挂卖）。想更保守、挂得离盘口远一点：加 `--offset-ticks 1`。

```bash
node scripts/gate.cjs status --watch
```

盯盘等一次成交。可以随时 Ctrl+C 退出，状态存在 `state/`，重新运行接着看。

```bash
node scripts/gate.cjs report
```

对账报告，整段贴给 Claude（不含私钥）。

```bash
node scripts/gate.cjs unwind --live
```

撤掉所有活跃订单，把保证金账户里的 USDC 和 MON 全部提回钱包；之后再跑一次 `report`。

## 通过标准

能从链上分别读出：创建、（部分）成交、自动翻出的反向订单、取消；并且 `report` 里 USDC 和 MON 两项都显示“对得上”（只差舍入尘埃）。顺带确认成交事件里有对手地址（`takerAddress` 和 `txOrigin`），后面做对手画像要用。

## 目录

- `scripts/gate.cjs` 实测命令行
- `lib/units.cjs` 金额与价格换算（纯 BigInt，有单元测试：`npm test`）
- `config/kuru.mainnet.json` 合约地址与硬性上限（存入、单数、占用金额）
- `docs/FINDINGS.md` 已核实的事实与未核实的假设
- `state/` 运行记录（已被 git 忽略）
