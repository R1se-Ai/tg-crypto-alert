# 合约异动告警（Telegram 推送）

加密货币与 TradFi **永续合约**的价格异动监控，异常时通过 Telegram Bot 推送告警。
部署在 Cloudflare Workers + Cron，**电脑关机也能告警**，免费额度足够。

> ⚠️ 本项目是个人自用的价格监控工具，**只读行情、不会下单**，所有推送都不构成投资建议。
> 使用前请先阅读文末的[免责声明](#免责声明)。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/R1se-Ai/tg-crypto-alert)

> 点上面的按钮可一键部署：Cloudflare 会把仓库复制到你的 GitHub、自动创建 Worker、
> D1 数据库和定时触发器，并在部署页面让你填 Telegram Token，全程不用装 Node.js。
> 想自己控制每一步就看下面的[手动部署](#部署)。

## 设计要点

- **判定口径用 markPrice**：合约标记价格天然抗插针，展示时附带 lastPrice 供参考。
- **判定无状态**：不存历史价格，直接读交易所 K 线开盘价当基准，窗口为 1m/5m/15m/1h 整点对齐。
- **判定引擎是纯函数**：无网络、无存储依赖，本地 CLI 与云端 Worker 复用同一套逻辑，判定规则有完整单测覆盖（174 项）。
- **存储只用于配置与冷却去重**：D1 存币种配置、告警记录与少量状态（冷却 / 跳空静默 / 全局暂停 / 会话绑定）。
- **TradFi 跳空保护**：休市时 markPrice 被平滑机制锁定，开盘一次性释放涨跌；检测到前一根 K 线振幅接近 0 即判为跳空，静默 15 分钟，不误报。
- **多数据源冗余**：OKX / Bybit / Binance 依次尝试，谁通谁上。失败的源进入冷却（限流 2 分钟、其它 10 分钟），冷却期内后续标的跳过它——既保证同一轮不跨所混用价格，又保证某个所被限流时系统能漂到还能用的源，而不是陪它停摆。
- **云端自愈与可观测**：Cron 每次运行时自动注册/修正 Telegram Webhook，并把心跳、巡检结果、数据源错误写进 D1（`state` 表），本机无法直连 Worker 时也能排查。
- **看门狗**：整轮执行被平台掐断时不会抛异常（既不写结果也不写错误），历史上曾因此静默停摆两小时而无人察觉。现在用 `check_start` / `check_done` 两个标记自检，烂尾超时主动推送「监控已中断」，恢复后推送「监控已恢复」。

## 目录结构

```
src/engine.ts    判定引擎（纯函数）
src/market.ts    Binance / OKX / Bybit 数据抓取、多窗口聚合、多源切换
src/monitor.ts   一轮巡检流程
src/store.ts     D1 / 内存存储
src/telegram.ts  Telegram API 与消息格式化
src/bot.ts       命令与按钮回调处理
src/worker.ts    Worker 入口（Cron + Webhook）
src/replay.ts    历史回放（定阈值用）
cli/index.ts     本地命令行
```

## 本地使用

```bash
npm install
npm test              # 174 项单测
npm run typecheck

npm run cli -- check                 # 当前判定结果，含未触发项距阈值差值
npm run cli -- check --symbol BTCUSDT --verbose
npm run cli -- replay --days 7       # 回放 7 天，统计告警次数并给出阈值候选
npm run cli -- symbols               # 校验清单里交易对是否真实存在
```

> 境内网络通常无法直连 Binance / OKX，本地 CLI 会给出明确提示；
> 云端 Worker 运行在海外节点，不受影响。

本地跑 `wrangler dev` 需要密钥时，把 `.dev.vars.example` 复制成 `.dev.vars` 填入即可
（`.dev.vars` 已在 .gitignore 中，不会进代码库）。

> 仓库里的 `wrangler.toml` 用的是占位符（`YOUR_ACCOUNT_ID` / `YOUR_D1_DATABASE_ID`）。
> 已部署的实例做运维时，把真实值写进 `wrangler.local.toml`（同样已 gitignore），
> 再用 `-c wrangler.local.toml` 执行，避免每次改回占位符：
>
> ```bash
> npx wrangler d1 execute crypto-alert-db --remote -c wrangler.local.toml \
>   --command "SELECT key, value FROM state ORDER BY key" --json
> npx wrangler deploy -c wrangler.local.toml
> ```

## 部署

### 方式一：一键部署（推荐）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/R1se-Ai/tg-crypto-alert)

1. 点按钮，按提示连接 GitHub 和 Cloudflare 账号
2. 在设置页填好 `TELEGRAM_BOT_TOKEN`（BotFather 给的）和 `WEBHOOK_SECRET`（随机串），确认创建
3. 等 Cloudflare 自动构建部署完成（会自动建好 D1 数据库和每 2 分钟的定时触发器）
4. 浏览器打开 `https://<你的域名>/setup?key=<WEBHOOK_SECRET>` —— Worker 会从请求里
   认出自己的真实域名并注册好 Telegram Webhook
5. 在 Telegram 给 bot 发 `/start`，再发 `/test` 验证

> **第 4 步不能省**。仓库里的 `WORKER_BASE_URL` 默认是占位域名，Cron 会自动跳过注册
> （不会把你指向错误地址），只有访问一次 `/setup` 才会用真实域名完成注册。

### 方式二：手动部署

### 0. 前置条件

- Node.js 20+ 和一个 **Cloudflare 账号**（免费即可）
- 一个 **Telegram Bot Token**：找 [@BotFather](https://t.me/BotFather) 发 `/newbot`，按提示拿到形如 `123456:AA...` 的 token

### 1. 准备配置

```bash
git clone <你的仓库地址> && cd tg-crypto-alert
npm install
npx wrangler login
```

`wrangler.toml` 里有**三处必须改成你自己的值**：

| 位置 | 改成 |
|---|---|
| `account_id` | 你的 Cloudflare 账号 ID（也可删掉这行，用 `CLOUDFLARE_ACCOUNT_ID` 环境变量指定） |
| `database_id` | 下一步 `d1 create` 返回的 ID |
| `WORKER_BASE_URL` | 你的 Worker 域名，**第一次 deploy 后才拿得到**，所以先随便填，稍后回填 |

### 2. 建库并写入密钥

```bash
npx wrangler d1 create crypto-alert-db   # 把返回的 database_id 填进 wrangler.toml
npx wrangler d1 execute crypto-alert-db --remote --file=./schema.sql   # 建表（也可由 /setup 自动完成）

npx wrangler secret put TELEGRAM_BOT_TOKEN   # BotFather 给你的 token
npx wrangler secret put WEBHOOK_SECRET       # 自定义随机串，用于校验回调来源
```

`WEBHOOK_SECRET` 可以随手生成一个：

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

> 密钥走 Cloudflare Secrets（加密存储、写入后不可读取、不进代码库），免费套餐支持，
> 每个 Worker 上限 64 个变量 / 每个 5 KB，本项目只用 2 个。

### 3. 部署两次

```bash
npx wrangler deploy          # 第一次：拿到域名，例如 https://tg-crypto-alert.xxx.workers.dev
# 把该域名填回 wrangler.toml 的 WORKER_BASE_URL
npx wrangler deploy          # 第二次：让 Cron 能用正确地址注册 Webhook
```

> 为什么要两次：Worker 靠 `WORKER_BASE_URL` 自己向 Telegram 注册回调地址，
> 而这个地址只有在首次部署后才存在。填错或留空会导致 Telegram 收不到你的命令。
> 首次部署若报 `Failed to resolve host` 是子域名 DNS 还没传播，等几分钟即可，
> Worker 会在每次 Cron 运行时自动重试注册。

### 4. 绑定会话并验证

在 Telegram 里给你的 bot 发 `/start`（首个交互的会话自动成为推送目标），再发 `/test`
应收到一条带实时价格的测试告警。

Worker 会在每次 Cron 运行时**自动注册 Webhook**，无需手工调用。
若要立即触发或查看结果（`<key>` 为 WEBHOOK_SECRET）：

```
https://<你的-worker域名>/setup?key=<key>     # 注册 webhook + 交易对自检
https://<你的-worker域名>/diag?key=<key>      # 查看心跳、最近巡检、数据源错误
https://<你的-worker域名>/run?key=<key>       # 手动执行一次巡检
https://<你的-worker域名>/health              # 健康检查
```

## 告警行为

这几条决定了"什么时候会响"，部署后最容易产生误解：

- **多久检测一次**：Cron 每 2 分钟一轮，所以异动到推送平均延迟 1 分钟、最坏 2 分多钟。
- **基准是 K 线开盘价**：窗口（默认 `5m,15m`）整点对齐，**每 5 / 15 分钟重置一次**。
  所以急拉急跌能抓到；超过 15 分钟的缓慢趋势（一小时慢慢涨 3%）全程静默——这是设计取舍，不是故障。
- **同一标的 15 分钟最多一条**：告警后进入冷却，期间再怎么动都不重复推送。
  可用 `/set BTCUSDT cooldown 30` 调整。
- **CRITICAL 只是文案级别**：波动达到阈值 2 倍（`criticalMultiplier`）会标成 `🚨🚨 剧烈异动`，
  但推送时机和冷却跟普通告警完全一样。想让它真正更紧急，得改 `engine.ts` 的冷却判定顺序。

## 排障

看不到告警时，按这个顺序查（`<key>` 为 WEBHOOK_SECRET）：

```bash
# 1. 先看巡检有没有在跑：check_start / check_done 应成对更新
npx wrangler d1 execute crypto-alert-db --remote -c wrangler.local.toml --json \
  --command "SELECT key, value FROM state WHERE key IN ('check_start','check_done','last_error')"

# 2. 再看每个标的的判定明细（含"距离阈值还差多少"）
#    state 表 last_run 的 detail 字段
```

| 现象 | 含义 |
|---|---|
| `check_start` 更新但 `check_done` 不更新 | 整轮被掐断（多因数据源卡住），看门狗会主动推送「监控已中断」 |
| `last_run.detail` 里大量 `no-data` | 数据源被限流，等它自行恢复或换 `MARKET_SOURCES` 顺序 |
| `skipped: below-threshold` | 判定正常，只是没到阈值；看 `gapPct` 即"还差多少百分点" |
| `skipped: cooldown` | 在冷却期内，属预期 |
| Telegram 收不到任何消息 | 用 `/diag` 看 `webhook_info` 的 `pending_update_count`，并检查 `WEBHOOK_SECRET` 是否一致 |

## 数据源选择

三个数据源按优先级依次尝试，前一个不通就用下一个：

```toml
MARKET_SOURCES = "okx,bybit,binance"   # 完整覆盖，顺序即优先级
MARKET_PRIMARY = "okx"                 # 简写：只指定谁排第一，其余按默认顺序
```

| 源 | 说明 |
|---|---|
| OKX | 覆盖最全，TradFi 合约（SNDK / XAU / CL）只有它有 |
| Bybit | 无地域封锁，主流币种齐全，是 OKX 被限流时的主要退路 |
| Binance | 会对部分 Cloudflare 出口节点（如美国 SJC）返回 **HTTP 403**，多数情况下形同虚设，垫底只作兜底 |

**关于限流**：交易所限的是 Cloudflare 数据中心的**共享出口 IP**，不是你的请求量
（本项目每轮只有 3~8 次请求）。所以 OKX 偶发 **HTTP 429** 时，改代码也没用——
只能靠多源冗余扛过去。这也是默认挂三个源的原因。

每 6 小时会主动探测一次各源连通性，结果写进 D1 的 `source_probe`，避免某条备源悄悄死掉没人发现。

## Telegram 命令

| 命令 | 说明 |
|---|---|
| `/list` | 查看监控清单与阈值 |
| `/add SOLUSDT 3%` | 新增标的（也支持 `60u` 绝对值、`tradfi` 资产类别） |
| `/set BTCUSDT 1.5%` | 修改阈值，`%` 为百分比、`u`/`usdt` 为 USDT 绝对值；不写单位沿用当前口径 |
| `/set BTCUSDT windows 5m,15m` | 修改窗口（可选 1m / 5m / 15m / 1h） |
| `/set BTCUSDT cooldown 15` | 修改冷却分钟数 |
| `/remove SOLUSDT` | 删除标的 |
| `/on` `/off` 代码 | 启停单个标的 |
| `/pause 60` `/resume` | 全局静默与恢复 |
| `/mute BTCUSDT 60` `/unmute BTCUSDT` | 单个标的静默 |
| `/status` | 运行状态与最近告警 |
| `/test` | 用真实行情发一条测试告警 |

告警消息自带两个按钮：**此币种静音 1 小时**、**全部暂停 1 小时**。

## 默认监控清单

| 标的 | 阈值 | 类型 |
|---|---|---|
| BTCUSDT | 1% | Crypto |
| ETHUSDT | 1% | Crypto |
| BNBUSDT | 2.5% | Crypto |
| SNDKUSDT | 3% | TradFi（闪迪） |
| CLUSDT | 2% | TradFi（原油） |
| XAUUSDT | 0.5% | TradFi（黄金） |

阈值可在 Telegram 里实时调整，无需改代码重新部署。

## 免责声明

- **不构成投资建议**。本项目只做价格异动监控与信息推送，推送内容是行情数据的机械计算结果
  （当前价相对 K 线开盘价的偏离幅度），不含任何买卖方向、收益预期或风险评估。
  由此产生的交易决策、持仓与盈亏，全部由使用者自行判断并自行承担。

- **只读，不下单**。项目仅调用交易所公开行情接口读取价格，不具备也无法进行下单、撤单、
  持仓调整或资金划转，不会触碰你的账户资产与交易权限。它也不会替你做任何交易动作。

- **数据可能不准确或不完整**。行情来自 OKX / Bybit / Binance 等第三方公开接口，可能延迟、
  缺失、错误，或因限流而中断；告警也可能因冷却去重、TradFi 跳空静默、缓慢趋势不触发等
  设计机制而不推送或延后推送。**没有任何一条告警是"保证送达"的**，
  请勿将其作为唯一的风控或交易依据。

- **合约交易本身风险极高**。永续合约带杠杆，可能在短时间内造成超过本金的损失。
  请先确认你具备相应风险承受能力。

- **合规性由使用者自负**。不同司法辖区对加密资产与合约交易的监管不同，
  部署和使用本工具前请自行确认符合当地法律法规，以及你所用交易所的服务条款。

- **按"原样"提供**。本项目免费开源，按现状提供，不提供任何形式的担保或技术支持承诺。
  作者不对因使用、修改或无法使用本工具造成的任何直接或间接损失承担责任。
