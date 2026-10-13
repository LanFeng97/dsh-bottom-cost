# Changelog

本插件的所有显著变更。版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)；
投影状态的形状变化会体现为 `stateVersion` 递增（旧检查点会自动作废并重放，不需要你手工清理）。

## [0.5.0] - 2026-10-13

### 新增

- **每轮显示所用模型**（`v4-pro` / `v4-flash` …）：跟在轮次号右侧，正好用掉标签与金额之间空出来的那截宽度。
  - 只削掉 `deepseek-` 前缀，不做别的改写；一轮里混用了多个模型就并列（`+`），太长交给标签的省略号。
  - 悬停显示完整模型 id（`title`）。
  - 数据本来就带 `model`（每个计价桶都有），这次只是把它显示出来——**没有改投影状态、schema 或 `stateVersion`**，旧检查点照样有效。

## [0.4.0] - 2026-10-13

### 新增

- **点面板里的「第 N 轮」跳到对话中的那一轮**。做法是**只读地驱动官方自己的轮次导航轨道**：轨道刻度是带 `aria-label`（含轮号）的 `button`，点它即调用官方的 `onNavigate`——已加载的轮次直接落位，**未加载的轮次由官方先取回更早的分页再落位**（官方文案键 `chat.turnNavigation.jumpLoad` 就是为这条路径存在的）。这两条我们都不重新实现。
  - 刻度不在已挂载窗口时（轨道自身也是虚拟挂载），先按官方文档的固定间距（每个已开始轮次一颗刻度、相隔 10px）把轨道滚过去，等一帧再重查，最多三次。
  - 轨道不可用时回落到 transcript 行上的 `data-chat-turn`，并按官方自用的阅读线（视口高度的 20%、上限 96px）对齐。
  - 两处都定位不到时，面板底部给出说明——不静默失败。
  - **不写死任何构建哈希类名**（形如 `xpvNua_mark` 会随版本变），只用语义属性：标签里的轮号、`aria-current`、`data-chat-turn`。不注入节点、不改官方布局。
- **标题行上的明暗开关（小太阳 / 月亮）**：点击把**本插件自己的内容**切到另一套配色，应用全局主题不受影响。
  - 做法是把官方的主题变量在插件作用域内按另一套重声明（CSS 变量可继承），所以现有规则一行都不用改。
  - 取值**不是自己挑的颜色**，而是从 `@deepseek-ai/dsh-client-ui-theme` 的两套定义里解析出的最终值（含 `var()` 链条：`--dsw-specific-menu` → `--dsw-menu-surface-fill`），因此两种模式下都与官方同一套配色，只是与外部相反。
  - 当前模式直接读官方的 `body[data-ds-dark-theme]` 属性判断（官方切主题靠的就是它），不是猜的；应用主题中途变化也能跟上。
  - **面板与费用胶囊都参与**切换。胶囊平时是透明文字、靠应用那一侧的行背景，切成相反主题后会给它一层主题底色，否则近白的字落在浅色统计栏上会看不清。
  - 状态只存在内存里：重新加载页面后回到「跟随应用」。
- 顺手修掉一处**一直空转的样式**：`.dshsc_sep` 用了 `--dsw-alias-separator-primary`，而该变量在整个 asar 里都不存在（0 处定义），补上后备值。

## [0.3.0] - 2026-10-13

### 变更

- **插件与仓库改名为 `dsh-bottom-cost`**（原 `dsh-session-cost`）。原因是插件市场里已有一个
  同名条目 [`KIDLi1412/dsh-session-cost`](https://github.com/KIDLi1412/dsh-session-cost)，
  两者位置（统计栏同一行）、计价思路与展开交互都相近；同名会让收录评审直接读成"重复"，
  而新名字把**位置**（输入框下方那条统计栏）说清楚，与本插件的差异（逐轮明细、
  命中/未命中两项总额、可刷新的官方价目表）一起构成条目描述。
  - GitHub 仓库改名后旧地址会自动 301 跳转，旧链接不会断。
  - **安装路径随之变化**：`node_modules/dsh-session-cost` → `node_modules/dsh-bottom-cost`，
    profile 里 `cordis.patch.yml` 的 loader 行也要换成新名。装过旧版的请重跑一次
    `node tools/install.mjs <profile>`（它会写入新名；旧目录与旧行请删掉，否则宿主会找不到包）。
  - 插件对外标识同步更新：注册名 `dsh-bottom-cost`、HTTP 路由前缀 `/api/dsh-bottom-cost/`、
    数据目录 `<DSH_HOME>/dsh-bottom-cost/`。投影 key `sessionCost` 与 entry id `ui-session-cost`
    **不变**（它们不冲突，也没有对外契约上的必要）。
  - 版本号进到 `0.3.0`：包名变了，对已安装者是实打实的破坏性变更，不宜当作修订版。

## [0.2.1] - 2026-10-13

### 变更

- **去掉唯一的运行时依赖 `zod`，改为自带的 `lib/shape.js`**（约 90 行，零依赖）。
  投影注册表只对 schema 调用 `.parse`，所以契约是鸭子类型的，手写完全够用；
  而 README 首推的复制式安装不带依赖，缺了 zod 插件会在装载阶段静默失败。
  现在 `git clone` + `node tools/install.mjs` **开箱即用**，不需要联网、不需要补装任何包。
  - 形状与 `stateVersion` 均未变化，旧检查点继续有效。
  - 一处**刻意比 zod 更严**：`NaN` / `Infinity` 一律拒绝（会静默污染累计值）。
  - 代价：将来给状态加字段要同步改 `lib/shape.js`（两者同文件、且由 `selftest` / `schema-check` 守着）。
- `tools/install.mjs`：移除 zod 依赖探测（已无依赖可探测）；修掉 `--dry-run` 仍会 `mkdir` 的问题——现在真的不写任何文件。

## [0.2.0] - 2026-10-13

### 文档

- README 改为「安装」置顶，并新增**让你的 AI 帮你安装**（可直接复制给 agent 的一段指令）。
- 用真实界面截图 `docs/session-cost-panel.png` 替换 ASCII 示意，并补上界面读法
  （统计栏胶囊左右两个数字各是什么、点开后看到什么）与「刷新」按钮的作用说明。
- 中英双语 README 互切，与同作者的姊妹插件保持一致。

### 新增

- **刷新价目**：面板里一键抓取官方中文价目页，解析 12 个单价并逐项校验，
  **先把差异列出来给你确认**再采用；落盘 `<DSH_HOME>/dsh-bottom-cost/pricebook.json`，
  重启后仍生效。抓取失败保留当前价目。
- `deepseek-v4-pro` 的档位标注：落在 2026-09-14 12:00 栅栏之后的轮次会标 `按Flash档估`
  并给出汇总提醒（官方页把 v4-pro 按独立价目列出，与插件逻辑冲突，详见 README）。

### 变更

- **金额改为浏览器侧按当前价目表现算**，投影状态里只保留 token 事实
  （`stateVersion` 1 → 2）。因此采用新价目后整段对话立刻重算，不会出现两代价格混在一本账里。
- 面板标题行与价目来源行分行显示；面板固定宽度，任何长文案都不会再撑开它。

## 0.1.0 - 2026-10-13（仓库建立前，仅存档）

### 新增

- 统计栏（`conversation.composer.dock`）里的费用胶囊：本对话累计费用 · 最近一轮费用。
- 点击向上展开：顶部固定「总命中缓存费用 / 总未命中费用」，下面按轮滚动，每轮三行
  （总费用 / 命中 / 未命中），默认停在最新一轮。
- 宿主侧 `sessionCost` 会话投影：按轮次折叠 token 事实，自带历史回填与跨重启检查点复用。
- 峰谷计价：北京时间工作日 09:00-12:00、14:00-18:00 为高峰，法定节假日与周末全天空闲；
  每次调用按**发生时刻**的档位计费。
- 非 DeepSeek 官方路由一律「未计价」并统计次数，不假装是 0 元。

[0.5.0]: https://github.com/LanFeng97/dsh-bottom-cost/releases/tag/v0.5.0
[0.4.0]: https://github.com/LanFeng97/dsh-bottom-cost/releases/tag/v0.4.0
[0.3.0]: https://github.com/LanFeng97/dsh-bottom-cost/releases/tag/v0.3.0
[0.2.1]: https://github.com/LanFeng97/dsh-bottom-cost/releases/tag/v0.2.1
[0.2.0]: https://github.com/LanFeng97/dsh-bottom-cost/releases/tag/v0.2.0
