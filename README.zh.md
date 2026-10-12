# dsh-session-cost

[English](README.md) | [中文](README.zh.md)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 加一颗**会话费用**胶囊：它坐在输入框正下方那条统计栏里，和内置的统计胶囊同一行，一眼回答两个问题——**这段对话花了多少钱**、**最近一轮花了多少钱**，并且把费用拆成「命中缓存」与「未命中」两笔。

```
     12 turns · 84 tok/s      Token 24.1K · 缓存命中 96%      ◎ ¥3.42 · ¥0.19
                                                              ↑ dsh-session-cost
```

点一下，面板**向上展开**——定位方式、间距、视口夹取与内置那两颗统计弹层完全一致：

```
        ┌──────────────────────────────────────────┐
        │ ◎ 本对话费用                     [ 刷新 ] │
        │ 价目：官方页 · 10/13 02:06                │
        │ ─────────────────────────────────────────│
        │ 命中缓存                          ¥1.195 │
        │ 未命中                            ¥1.084 │
        │ ─────────────────────────────────────────│
        │ 第 5 轮                           ¥0.0710│
        │   命中缓存                        ¥0.0509│
        │   未命中                          ¥0.0201│
        │ 第 6 轮                           ¥0.1949│
        │   命中缓存                        ¥0.1490│
        │   未命中                          ¥0.0459│
        └──────────────────────────────────────────┘
              ↑ 滚动区高度恰好是两块轮次
```

## 它做什么

| 你的操作 | 你得到什么 |
| --- | --- |
| 扫一眼胶囊 | 本对话累计费用，后面是最近一轮的费用 |
| 点击胶囊 | 面板贴着输入框上方向上展开 |
| 看顶部固定区 | 整段对话的**命中缓存费用**与**未命中费用** |
| 滚列表 | 每一轮的总费用 / 命中 / 未命中，默认停在最新一轮 |
| 对话很长时 | 向上滚即可依次回看更早的轮次 |
| 点「刷新」 | 抓取官方价目页，列出差异，**你确认后**才生效 |
| 对话还没有计费轮次 | 胶囊不显示，与内置统计胶囊「无内容即不渲染」的行为一致 |

每轮三行：**总费用 / 命中 / 未命中**。顶部固定区那两个数字加起来永远等于胶囊上的总额——`总 = 命中 + 未命中` 是构造上成立的，不是四舍五入碰巧对上的。

## 数字是怎么来的

只有 **DeepSeek 官方路由**有公开价目表，所以只有它们会产生金额：

| | |
| --- | --- |
| **命中费用** | 缓存读 tokens × 命中价 |
| **未命中费用** | （未命中输入 + 缓存写）× 未命中输入价 **+** 输出 tokens × 输出价 |
| **峰谷** | 北京时间周一至周五 09:00-12:00、14:00-18:00 为高峰（双倍价）；周末与中国法定节假日全天空闲 |
| **按什么时刻计价** | 每次调用**发生那一刻**——取会话事件自带的时间戳，所以回放几个月前的历史也按**当时**的档位算，不会拿今天的价套旧账 |
| **其他 provider** | 绝不猜成 ¥0：显示为**未计价**，面板底部给出未计价的调用次数 |

统计范围是**当前会话自身的轮次**。子 agent 是另一个会话，刻意不并入，所以胶囊上的数字与你看到的轮次严格一一对应。

### 是估算，不是账单

金额由 token 数与公开价目推算。插件不读你的余额、不碰凭据，也无法得知 DeepSeek 实际扣了多少。

### `deepseek-v4-pro` 的档位存在争议

价目规则里有一条时间栅栏（继承自 [`@linxin666/dsh-usage`](https://github.com/zhu1090093659/dsh-web)）：**2026-09-14 12:00（北京）之后，`deepseek-v4-pro` 的请求按 Flash 档计价。**

而官方价目页至今仍把 `deepseek-v4-pro` 列在**它自己那一行、贵 3〜7.5 倍**（未命中 4.5/9.0，输出 13.5/27.0）。文档无法证明运行时到底按哪档扣费。与其猜，插件保留栅栏并把受影响的轮次标上 `按Flash档估`，同时在面板里给汇总提醒。要改成按官方 pro 档算，把 `lib/pricing.js` 里的 `V4_PRO_FOLDED_INTO_FLASH_AT_MS` 置为 `0` 即可。

## 刷新价目表

点面板里的 **刷新**：

1. 宿主抓取**官方中文价目页**（`api-docs.deepseek.com/zh-cn/quick_start/pricing`，给人民币；英文页给美元，不用）；
2. 解析那张表并校验全部 12 个单价——任何一个缺失或不合理，整份解析直接作废；
3. **把差异列给你看**（哪一项从多少变成多少），点 **采用** 才生效。

多这一道确认是刻意的：DeepSeek **没有机读价目 API**，只有人读文档页，解析天生脆。一次静默的错误解析会污染你看到的每一个金额。

**金额在哪里算**值得单独说一句：投影状态里只有 *token 事实*——哪个模型、哪一行价目、高峰还是空闲、多少 token——**钱由浏览器按当前生效的价目表现算**。所以采用新价目后整段对话立刻重算，不改写任何历史，也不会出现两代价格混在一本账里。价目表本身不进会话检查点，只存在 `<DSH_HOME>/dsh-session-cost/pricebook.json`（原子写）。

抓取失败（断网、超时、官网改版）会明确报出来并**保留当前价目**；首次启动的兜底始终是内置表。

### 能力边界

- **只有一次出网请求**：抓上面那个公开文档页，**且只在你点「刷新」时发生**。除此之外它不把任何东西发出去。
- **只写一个文件**：`<DSH_HOME>/dsh-session-cost/pricebook.json`。
- 三条价目路由都是**仅回环 + 同源**校验（与本工作区既有 DSH 插件同一套围栏）。
- 宿主半区不读凭据、不写会话数据、不装定时器。

## 安装

### 从插件市场安装（上架后）

DSH 插件以包的形式分发；在 [dshmarket](https://github.com/dsh-market/dsh-market) 里搜索 **dsh-session-cost**。上架之前请用下面的手动方式。

### 从本仓库手动安装

```sh
git clone https://github.com/LanFeng97/dsh-session-cost
cd dsh-session-cost
node tools/install.mjs
```

它会把包复制进你 DSH profile 的 `node_modules`，并在该 profile 的 `cordis.patch.yml` 追加一行 loader 行。DSH 家目录的解析方式与 harness 本身一致——先 `$DSH_HOME`，再 `~/.dsh`；脚本是幂等的，`git pull` 之后再跑一次即可同步更新。

**然后重启 DeepSeek Harness。** 宿主半区是 Node 模块，只重载配置不会导入它。之后改 `lib/client.js` 只需刷新页面；改 `lib/index.js` 仍需重启。

```sh
node tools/install.mjs --dry-run        # 只打印要做什么，不写任何文件
node tools/install.mjs web              # 指定别的 profile（默认 desktop）
```

用**复制**而不是目录联结是有原因的：Windows 上联结会被 Node realpath 回克隆目录，插件的 `zod` 导入就会从克隆目录往上找——那里没有 `node_modules`，插件在装载阶段就会失败。

## 实现要点

### 用官方扩展点，不做 DOM 注入

- 胶囊注册进内置 slot **`conversation.composer.dock`**（`order: 1`；随包发布的 `stats` 两颗胶囊是 `order: 0`）。该 slot *就是* 输入框下方那条统计栏，容器是 `display:flex; gap:12px` 的横向行，因此胶囊是内置胶囊的同级兄弟——不用 DOM 插桩，也不怕官方重渲染。
- 面板复用 `@deepseek-ai/dsh-client-ui-primitives` 的 `useAnchoredPosition` 与 `useDismissOnOutsidePointer`，与内置统计弹层同一套，所以定位、夹取、点击外部关闭、Esc 的行为完全一致。
- 样式只走主题 CSS 变量（`--dsw-*`），跟随你的主题而不是写死颜色。

### token 事实通过会话投影传输

宿主注册一个**会话投影单元**（`sessionCost`），浏览器用 `useProjection('sessionCost')` 读。这白拿三件事：

- **历史回填**：投影注册表会在首次触碰时把后注册的单元在内存日志上回放一遍，所以装上插件或重启 DSH 之后，当前对话里**已经发生**的轮次也被折进来——胶囊不会从 ¥0 开始。
- **持久化**：状态搭 harness 的投影检查点缓存，插件自己不写数据文件。
- **推送而非轮询**：值走会话控制流下发，没有定时器，也没有拉取循环。

### 分层，便于脱离 DSH 自测

| 文件 | 职责 |
| --- | --- |
| `lib/fold.js` | 纯折叠：会话事件 → 按轮 token 事实。零依赖。 |
| `lib/pricing.js` | 纯计价：峰谷时钟、模型→价目行判定、tokens→金额。零依赖。 |
| `lib/pricebook.js` | 纯价目书：内置表、严格校验、官方页解析器。零依赖。 |
| `lib/projection.js` | 薄适配：zod schema + 客户端视图。 |
| `lib/pricebook-store.js` | 抓取、暂存候选、采用、落盘。 |
| `lib/routes.js`、`lib/guard.js` | 仅回环的 HTTP 翻译层。 |
| `lib/client.js` | 胶囊与面板；按「事实 × 当前价目书」算钱。 |

## 自测

```sh
npm test              # node tools/selftest.mjs —— 66 项，不联网
npm run test:live     # node tools/live-check.mjs —— 抓真页面、解析、落盘、读回
npm run test:schema   # node tools/schema-check.mjs —— schema ↔ 状态 ↔ 视图 一致性（从已安装副本导入）
```

`selftest` 覆盖峰谷与节假日例外、解析器（对着随仓库附带的官方页快照）、价目书校验、换一本价目书重算、按桶聚合、重放幂等、状态 JSON 安全、明细裁剪、以及客户端文案键集合。

`test:schema` 的存在有具体原因：`selftest` 刻意不做三方依赖导入（必须能在没有 `node_modules` 的环境跑），因此**看不见 zod schema**——而 `viewOf()` 与视图 schema 一旦不一致，每次投影读写都会在运行时抛错，这条缝真的挂过一次。现在它有专门的守卫。

## 兼容性

- DSH **≥ 0.2.0-rc.2**（开发与验证均在 0.2.0-rc.2 上完成）。
- Node **≥ 20**。
- 一个运行时依赖：`zod` ^4，用于投影 schema。

## 许可

[MIT](LICENSE) © 2026 LanFeng97。

有两处不是本插件原创，保留其上游署名：

- `lib/holidays.js` —— 中国法定节假日日期，来自 [bastengao/chinese-holidays-node](https://github.com/bastengao/chinese-holidays-node)（MIT）。
- `lib/pricing.js` 的峰谷规则与价目行判定、`lib/pricebook.js` 的内置表 —— 与 [@linxin666/dsh-usage](https://github.com/zhu1090093659/dsh-web)（Apache-2.0）同一套口径。

## 相关

- [dsh-workspace-create-dialog](https://github.com/LanFeng97/dsh-workspace-create-dialog) —— 同一作者的姊妹插件，做「创建工作区」对话框。
