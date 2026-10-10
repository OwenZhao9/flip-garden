# 已核实的事实与未核实的假设（2026-10-10）

方法：全部为只读。用 Chrome 打开 npm 包文件（jsDelivr）读 Kuru SDK 的类型与 ABI；用 Monad 公共 RPC 读链上状态与模拟调用（带状态覆盖，用随机地址，不涉及任何真实资金）。读取时的区块约 112,187,000。

## 已核实

| 事实 | 依据 |
|---|---|
| Monad 主网 chainId 143；区块间隔约 0.30 秒（3600 块用 1087 秒） | `eth_chainId`，两块时间戳相减 |
| MON-USDC 市场 `0x065C9d28…C394` 被 MarginAccount 认可 | `MarginAccount.verifiedMarket(market) == true` |
| 基础币是原生 MON（零地址，18 位），计价币是 USDC `0x754704Bc…b603`（6 位） | `getMarketParams()` |
| 价格精度 1e8，数量精度 1e10，最小报价单位 tick = 100（即 0.000001 USDC） | `getMarketParams()` |
| **最小下单量 200 MON（约 4.95 USDC，按卖一 0.024765）**，最大 2 亿 MON | `getMarketParams()`；模拟中 199 MON 被 `SizeError` 拒绝 |
| 链上读到的 taker / maker 费率都是 0 bps | `getMarketParams()` 末两项（实测要再验证） |
| 价格口径：`bestBidAsk()` 与 `Trade.price` 是 1e18 精度；订单里的价格是 1e8 精度 | 对照样本 0.024703 ↔ 2470300 |
| `Trade` 事件含 `makerAddress`、`takerAddress`、`txOrigin`。样本里 taker 常是路由合约，`txOrigin` 才是真人地址 | ABI + 最近 3600 块的真实样本 |
| 翻转单接口 `batchProvisionLiquidity` / `addFlipBuyOrder` 在当前主网合约上可用 | 带状态覆盖的 `eth_call` 模拟成功 |
| 翻转价必须高于买入价（等于或更低 → `PriceError`）；价格必须是 tick 整数倍（否则 `TickSizeError`）；价差只差 1 个 tick 也能下 | 模拟 |
| 买价高于卖一：`provisionOrRevert=true` 报 `ProvisionError`；`=false` 不报错（推断：该单被静默跳过，需用事件确认） | 模拟 |
| 创建时 `FlipOrderCreated.flippedId = 0`，翻转后的订单号要等 `FlippedOrderCreated` 才知道 | `debug_traceCall` 取到的模拟日志 |
| 撤翻转单要用 `batchCancelFlipOrders`（SDK 的 `PositionWithdrawer.withdrawLiquidity`）；合约有 `WrongOrderTypeCancel` 错误，用普通撤单可能被拒 | SDK 源码 + ABI |
| 公共 RPC：`eth_getLogs` 单次最多约 100 个区块；`debug_traceCall` 与状态覆盖可用 | 实测 |
| SDK `@kuru-labs/kuru-sdk` 最新版 0.0.95，发布于 2026-01-27（约 8.5 个月前）；依赖 ethers 5.7.1 | npm registry |
| 最近约 18 分钟（3600 块）该市场：5408 个新挂单事件、15 笔成交、**0 个翻转单相关事件** | `eth_getLogs` 扫描 |

## 脚本自测（2026-10-10 夜，均为只读 / 不涉及真实资金）

- 17 个单元测试通过（金额换算、挂单阶梯、对账算法，含“符号反了”“gas 按上限/按用量”的判别）。
- `preflight` 对主网跑通：市场认可、币种与精度、SDK 与合约参数一致、合法单可下，两个对照（低于最小量、穿盘）如期被拒。
- `plant --sim-funds`（1 张和 3 张）、`deposit`/`plant` 对无资金地址的拒绝路径、`status` / `unwind`（演练）/ `report`（用假状态 + 真实链上订单）都能跑，没有程序错误。
- 没跑过的路径：所有 `--live` 的真实交易（存入、下单、撤单、提现）。这些只能由实测验证。
- SDK 构造交易的方式：`MarginDeposit` / `MarginWithdraw` / `OrderCanceler` 用旧式 gas 价（`eth_gasPrice`）、上限为估算值的 1.2 倍；`PositionProvider.provisionLiquidity` 走 ethers 默认（EIP-1559，Monad 区块基础费 100 gwei，ethers 给 maxFee 201.5 / 小费 1.5 gwei）。用 SDK 同款的 `eth_estimateGas`（gas 价 1 gwei）在假余额下得到的是合约本身的报错（`InsufficientBalance`），不是 gas 价报错，说明这条路径在 Monad 上可用。

## 实测记录（真实交易，2026-10-10 夜）

- **存入 6 USDC 成功。** 授权恰好 6 USDC（授权额度被用完，归零）→ 存入 Kuru 保证金账户；链上读到保证金 USDC = 6.000000，钱包 USDC 7.963306 → 1.963306。脚本 `deposit` 报“保证金增加额与存入额完全一致”，我用独立只读查询复核一致。
- **Monad 按 gas 上限收费（已回答）。** 两笔交易的收据里 `gasUsed` 恰好等于 `gasLimit`（授权 87,643；存入 197,626），钱包 MON 的减少量 0.0290536165 与 Σ(gasLimit × effectiveGasPrice) 逐位相等。所以收据里的 gasUsed 就是上限，没法区分“实际执行用量”。SDK 构造的交易把估算值乘 1.2 当上限（存入这笔多付约 20%，约 0.003 MON，可忽略）。
- 两笔手续费合计 0.0290536 MON（约 0.0007 美元）。

- **下单与成交（订单号 122927284）：** 1 张翻转买单，201 MON，买入价 0.024761（卖一下方 1 个 tick），翻转价 0.024786；gas 281,890（上限＝用量），约 0.0286 MON。
  - 创建后 2 个区块（约 0.6 秒）被吃满：`Trade` 价 0.024761，成交 201 MON，剩余 0；taker 是一个合约（`0x34Ae…3fC5`），`txOrigin` 是个人地址（`0xc88d…2E5A`）。
  - **同一区块内自动翻出新订单，编号是新的**（122927286，不是原编号）：卖 201 MON @ 0.024786，它自己的翻转价＝原买入价 0.024761（所以卖出成交后会自动回到买单，循环下去）。数量与成交量完全一致（maker 费率 0，没有被扣）。`s_orders` 里 `flippedId` 仍为 0。
  - **`Trade.isBuy` 是吃单方（taker）的方向，不是挂单方：** 我方买单被卖方吃掉时事件里 `isBuy=false`。脚本原先按相反方向理解，`report` 的“符号反了”诊断当场发现，已修正并加了测试。
  - **对账通过：** 余额变化与按成交推算的结果，USDC 差 0，MON 差 0（gas 按上限计）。
  - **逆向选择的第一手样本：** 买单挂在最高可挂价，立刻被吃，之后市价下移（卖一 0.024725），账面小亏约 1 美分。激进挂单更容易被“知情的吃单者”打中，这正是账本要如实显示、对手画像有价值的原因。

- **撤单：** 对翻转出来的订单（122927286），SDK 的 `PositionWithdrawer.withdrawLiquidity`（链上方法 `batchCancelFlipOrders`）直接成功，没有触发 `WrongOrderTypeCancel` 回退；事件 `FlipOrdersCanceled([122927286], owner)`；gas 178,169。
- **提现：** `batchWithdrawMaxTokens([USDC, 原生 MON])` 成功，保证金账户 USDC 与 MON 都归零，钱归钱包；gas 190,054。
- **最终对账（5 笔交易全部做完后）：** USDC 余额变化 −4.976961＝按成交推算 −4.976961，差 0；MON 余额变化 +200.90486488，加回 gas 0.09513511 后＝+201，差 0。
- **整次实测的成本：** 5 笔交易 gas 合计 0.095135 MON（约 0.0023 美元）；加上成交后市价下移的账面小亏，合计约 1–2 美分。结束时钱包里是 2.986345 USDC 和 239.957 MON（其中约 201 MON 是买到的）。
- **门槛结论（2026-10-10）：通过。** 创建、整笔成交、翻转出的新编号反向单、取消、提现、对账（差额为 0）都从链上读出来了。没有观察到的：部分成交、卖单成交后自动翻回买单的完整一圈、`FlipOrderUpdated` 何时出现；这些在后续使用里自然会遇到，不阻塞。

## 未核实（实测要回答的）

1. （部分回答）整笔成交时：翻出的是新编号的反向单，数量等于成交量。**部分成交**时反向单怎么增长、`FlipOrderUpdated` 何时出现，还没观察到。
2. （已回答）`Trade.isBuy` 是吃单方的方向，见上面的“实测记录”。
3. （已回答）Monad 按 gas 上限收费，见上面的“实测记录”。
4. 模拟里 `debug_traceCall` 报的 gasUsed 恰好是 8,100,000，很可能只是调用上限，不是真实用量；真实 gas 以实测收据为准。
5. 手续费是否真为 0；`MarginAccount` 里“可用”与“锁定”的口径（脚本用挂单大小自行推算锁定额）。
6. WETH-USDC 备用市场的地址与最小下单量（官方文档页只列了 MON-AUSD、MON-USDC；AUSD 对 24 小时 0 笔成交，不用）。

## 对产品的含义

- 每档至少约 5 美元，预算分配棋盘的“档数”= 预算 ÷ 5 美元左右。50 美元预算最多约 10 档。
- 近 18 分钟样本里没有任何人在这个市场下翻转单：这次实测是对翻转单真实行为的第一手观察，结论以实测为准。
