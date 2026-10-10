# 阶段 C：账本核心（给 Opus 5.5 会话的任务书）

## 一句话目标

写出 Flip Garden 的**账本核心**：给定一个地址在 Kuru 某个市场上的链上数据，输出可信的余额（可用/锁定）、订单（含翻转链）、成交、费用、盈亏（含亏损）与仓位增长，并能证明「算出来的盈亏 ＝ 链上余额变化」。

## 为什么这块最不能错

账本是产品对用户的承诺：它显示的每个数字都会被当作真钱。算错一位就是误导用户。所以：全部用整数（BigInt），不用浮点；每条规则都有测试；不确定的语义明确标「未知」，不要猜。

## 现有资产（先读这些，别重复造轮子）

- `docs/FINDINGS.md`：已验证事实与未验证问题（必读）。
- `lib/units.cjs`、`lib/reconcile.cjs`：金额换算、挂单阶梯、对账算法，已有测试。
- `scripts/gate.cjs`：门槛实测命令行，是事件扫描与状态读取的参考实现。它仍是实测工具，别破坏。
- `test/fixtures/gate-test-2026-10-10.json`：**真实主网数据**（5 笔交易、4 个事件、6 个余额快照）。已验证对账差额为 0；`test/fixture.test.cjs` 是用法示例。你的账本必须能用它复现同样的结果。
- `config/kuru.mainnet.json`：合约地址与硬上限。

## 已验证的事实（摘要，细节看 FINDINGS）

- 价格精度 1e8、数量精度 1e10、tick＝100；USDC 6 位，MON 18 位（原生，零地址）；最小下单 200 MON；maker 与 taker 费率链上读到都是 0 bps。
- `Trade.isBuy` 是**吃单方（taker）的方向**：我方挂买单被卖方吃掉时 isBuy＝false。`Trade.price` 是 1e18 精度，订单里的价格是 1e8 精度。
- 翻转：买单整笔成交后，同一区块内出现 `FlippedOrderCreated`，是**新订单号**，数量等于成交量，它自己的翻转价＝原买价。
- 撤翻转单用 `batchCancelFlipOrders`，事件 `FlipOrdersCanceled`。
- Monad 按 gas 上限收费：收据里 gasUsed 恒等于 gasLimit；钱包 MON 的减少量＝Σ gasLimit × effectiveGasPrice。
- 净值＝钱包＋保证金可用＋挂单锁定。存入、取出、挂单、撤单只在三者之间搬动，不改变净值；净值只因成交、费用、gas 改变。

## 交付物

1. `src/`（TypeScript，纯函数为主，无 I/O；RPC 读取放在薄的适配层）：
   - **单位与精度**：通用，不写死 MON-USDC；明确舍入规则（谁向上、谁向下），写进文档。
   - **事件解码**：`Trade`、`FlipOrderCreated`、`FlippedOrderCreated`、`FlipOrderUpdated`、`FlipOrdersCanceled`（`OrderCreated` 可忽略）。
   - **订单链**：创建 → 成交 → 新编号反向单 → 取消；支持一张单多次部分成交。
   - **账本**：可用/锁定余额、活跃订单、成交列表、费用（gas 按上限；maker/taker 费率来自市场参数）、已实现盈亏（每一圈）、未实现盈亏（给出口径：按中间价与按可立即成交价各算一个）、仓位增长、库存失衡比例。
   - **对账**：不变量检查，输出结构化差额和原因（可直接给界面显示）；在 `lib/reconcile.cjs` 基础上扩展到多笔、部分成交、多张单。
   - **增量扫描**（可放最后）：`eth_getLogs` 每次不超过 90 个区块；可恢复、幂等。
2. 测试（优先用 `node --test`，不引入新依赖）：
   - 用真实数据 fixture 复现对账为 0。
   - **随机差分测试**：写一个极简的参考模拟器，随机生成大量「下单／部分成交／全部成交／翻转／撤单／提现」序列，断言账本与参考一致、对账差额不超过舍入容差（每次成交或锁定最多 1 个最小单位）。
   - **精度测试**：不同精度、非零费率的合成市场。
   - **负面测试**：把 `Trade.isBuy` 按挂单方理解会让对账失败（防止回退到错误理解）。
3. `docs/LEDGER.md`：数据模型、公式、舍入规则、事件语义、未知项清单。
4. 更新 `docs/FINDINGS.md`，并在 `~/.claude/skills/hackathon-idea/SKILL.md` 末尾追加进度。

## 待查的未知（只读查链，别猜）

- 部分成交时，`Trade.updatedSize` 与翻转出的反向单怎么增长；`FlipOrderUpdated(orderId, size)` 何时出现。
- 卖单成交后是否自动回到买单（可由 `flippedPrice` 推断，但没亲眼见过）。
- 其他市场的手续费是否非零。

可以用公共 RPC（`https://rpc.monad.xyz`，`eth_getLogs` 每次不超过 90 块）去扫别人的翻转单样本确认语义。找不到就标「未验证」，并让代码对未知情况保守处理：报告「无法解释」，而不是硬算。

## 红线

- 不发任何交易，不用 `--live`，不碰私钥。
- 不改 `state/`（那是用户的实测记录）。
- 新装依赖（如 typescript、vitest）先问用户；Node 25 可直接运行 `.ts`（类型擦除），测试可用 `node --test`。
- 不删除、不破坏 `scripts/gate.cjs`、`lib/` 和现有测试。

## 做完之后

1. `npm test` 全部通过。
2. 把进度和新发现写进笔记与 `docs/FINDINGS.md`。
3. 告诉用户：阶段 C 完成，请开新会话换回 Sonnet 5.5 做阶段 D（界面、Dynamic 登录、Aurora、Envio、Nansen、CRE、MetaMask 插件）。
