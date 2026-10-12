/**
 * dsh-session-cost 的浏览器半区。
 *
 * 一个条目：注册进 `conversation.composer.dock`——**输入框正下方那条统计栏所在的
 * 同一个 slot**（官方 `@deepseek-ai/dsh-client-ui-chat` 用 `id: 'stats'`、order 0
 * 把会话统计/Token 用量两个胶囊注册在这里，本插件用 order 1 排在它们右边；该 slot
 * 的容器是 `display:flex; gap:12px` 的横向行）。
 *
 * 数据分两路，都是刻意的：
 * 1. **token 事实**走宿主投影 `sessionCost`（`useProjection`）——实时、按会话、自带历史回填；
 * 2. **价目表**走三条仅回环路由——启动时取一次，点"刷新价目"时重新抓官方页。
 *
 * 金额**在浏览器算**：`钱 = 事实 × 当前价目书`。所以采用新价目后整段对话立刻重算，
 * 不需要宿主重发任何东西，也不会出现"旧轮次留着旧价"的两代价格。
 * 这里的计费公式是 pricing.js 的镜像（浏览器 bundle 不能 import 宿主模块），改动要同步。
 *
 * 展开面板照抄官方统计胶囊的几何：portal 到 body + `useAnchoredPosition`（side: top）
 * 视口夹取 + 外部点击/Esc 关闭；该 hook 用 ResizeObserver 观察面板，所以"抓取结果确认区"
 * 让面板变高时会自动重新定位。
 *
 * 样式只用主题 CSS 变量（`--dsw-*` / `--dsh-content-font-*`），不依赖官方组件库内部类名。
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-cost',
  factory: (require) => {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    /** createElement 简写。 */
    const h = React.createElement
    /** 本地化命名空间。 */
    const NS = 'dsh-session-cost'
    /** 落座的内置 slot：输入框正下方的统计栏。 */
    const SLOT = 'conversation.composer.dock'
    /** 本条目在统计栏里的 cell key（官方那两颗胶囊的 id 是 'stats'）。 */
    const ENTRY_ID = 'session-cost'
    /** 宿主投影 key，必须与 ../projection.js 的 SESSION_COST_KEY 一致。 */
    const PROJECTION_KEY = 'sessionCost'
    /** 价目路由（无前导斜杠：GUI 用 <base href="./"> 提供）。 */
    const API = {
      book: 'api/dsh-session-cost/pricebook',
      refresh: 'api/dsh-session-cost/pricebook/refresh',
      apply: 'api/dsh-session-cost/pricebook/apply',
    }
    /** 价目请求超时：抓官方页在宿主侧另有 10s 超时，这里只兜住整条链路。 */
    const FETCH_TIMEOUT_MS = 20_000
    /** 与官方 stat-dialog 一致的锚定常量。 */
    const PANEL_GAP = 8
    const PANEL_MARGIN = 12
    /** 未定位时的量测样式：占位但不显示，让夹取逻辑量到真实尺寸。 */
    const MEASURE_STYLE = { visibility: 'hidden', left: 0, top: 0 }
    /** 样式表的去重标记。 */
    const CSS_TAG_ID = NS + '/chip.css'

    /**
     * 组件样式。
     *
     * `.dshsc_pill` / `.dshsc_anchor` 与官方 `StatsPills.module.css` 对齐（同一行里字号、
     * 圆角、内边距、悬停底色必须一致）；`.dshsc_panel` 与官方 `stat-dialog.module.css` 对齐。
     */
    const CSS = [
      '.dshsc_anchor{min-width:0;display:inline-flex}',
      '.dshsc_pill{box-sizing:border-box;corner-shape:round;max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;border-radius:999px;align-items:center;gap:6px;padding:1px 8px;display:inline-flex;cursor:pointer}',
      '.dshsc_pill svg{flex:none;width:14px;height:14px}',
      '.dshsc_pill:hover,.dshsc_pill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '.dshsc_label{text-overflow:ellipsis;min-width:0;overflow:hidden}',
      '.dshsc_sep{color:var(--dsw-alias-separator-primary);margin:0 6px}',
      // 面板给定宽，而不是 width:max-content。max-content 的宽度由**最宽的那一行**决定，
      // 于是抓取时间/错误信息/变更清单都会把整个框撑宽（实测：一次刷新就把面板拉长）。
      // 固定宽度下文案只会换行或省略，任何一行都不能再改变布局。
      '.dshsc_panel{z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);width:min(300px,100vw - 24px);backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;border:0;padding:12px 14px;font-size:12px;line-height:18px;position:fixed}',
      '.dshsc_title{color:var(--dsw-alias-label-primary);justify-content:space-between;align-items:center;gap:16px;margin-bottom:4px;font-weight:500;display:flex}',
      '.dshsc_titleLabel{align-items:center;gap:6px;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:inline-flex}',
      '.dshsc_titleLabel svg{flex:none;width:14px;height:14px}',
      '.dshsc_rule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px}',
      '.dshsc_summary{grid-template-columns:minmax(0,1fr) auto;gap:4px 16px;margin-bottom:10px;display:grid}',
      '.dshsc_summaryLabel{color:var(--dsw-alias-label-tertiary);min-width:0}',
      '.dshsc_summaryValue{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;text-align:right}',
      // 滚动区高度 = 正好两块轮次（用户要求「刚好显示固定总费用和两次会话的费用」）。
      // 用 max-height 而不是 height：只有一轮时不留一大块空白。
      '.dshsc_scroll{--dshsc-block-h:66px;height:auto;max-height:calc(2 * var(--dshsc-block-h));overflow-y:auto;overscroll-behavior:contain}',
      '.dshsc_block{box-sizing:border-box;height:var(--dshsc-block-h);padding:5px 0 4px;border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.dshsc_block:first-child{border-top:0}',
      '.dshsc_line{justify-content:space-between;gap:16px;display:flex}',
      '.dshsc_lineLabel{color:var(--dsw-alias-label-tertiary);min-width:0;text-overflow:ellipsis;overflow:hidden;white-space:nowrap}',
      '.dshsc_lineValue{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;flex:none}',
      '.dshsc_total .dshsc_lineValue{color:var(--dsw-alias-label-primary)}',
      '.dshsc_sub .dshsc_lineValue{color:var(--dsw-alias-label-tertiary)}',
      '.dshsc_mark{color:var(--dsw-alias-label-tertiary);border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;margin-left:6px;padding:0 5px;font-size:11px}',
      // overflow-wrap: 抓取失败时的错误信息可能是一长串没有空格的英文，别让它溢出面板。
      '.dshsc_note{color:var(--dsw-alias-label-tertiary);border-top:.5px solid var(--dsw-alias-border-l2);margin-top:8px;padding-top:6px;overflow-wrap:anywhere}',
      '.dshsc_note+.dshsc_note{margin-top:4px;border-top:0;padding-top:0}',
      // 第二行的价目来源：强制单行，过长截断（换行会留下"只剩三个字"的孤儿行）。
      // 完整抓取时刻在 title 里。
      '.dshsc_source{color:var(--dsw-alias-label-tertiary);margin:0 0 10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      // 价目相关的临时状态（抓取失败、解析提醒）落在第二行下方。
      '.dshsc_alert{color:var(--dsw-alias-label-tertiary);margin:0 0 8px;overflow-wrap:anywhere}',
      // 按钮标签永不换行：它在标题行里会被挤，"刷新价目"曾经折成"刷新价"/"目"。
      '.dshsc_action{color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;white-space:nowrap;flex:none;background:0 0;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);padding:2px 8px;cursor:pointer}',
      '.dshsc_action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '.dshsc_action:disabled{opacity:.55;cursor:default}',
      '.dshsc_actions{justify-content:flex-end;gap:8px;margin-top:8px;display:flex}',
      '.dshsc_confirm{border-top:.5px solid var(--dsw-alias-border-l2);margin:0 0 10px;padding-top:8px}',
      '.dshsc_confirmTitle{color:var(--dsw-alias-label-primary);margin-bottom:4px}',
      '.dshsc_changes{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;max-height:96px;overflow-y:auto;margin:0;padding:0;list-style:none}',
      '.dshsc_changes li{overflow-wrap:anywhere}',
      '.dshsc_bad{color:var(--dsw-alias-label-warning,var(--dsw-alias-label-secondary))}',
    ].join('')

    /** 中文文案（key 集合的基准）。 */
    const zh = {
      'cost.title': '本对话费用',
      'cost.pill.aria': '本对话总费用 {total}，最近一轮 {last}',
      'cost.hit': '命中缓存',
      'cost.miss': '未命中',
      'cost.turn': '第 {n} 轮',
      'cost.unpriced': '未计价',
      'cost.unpricedNote': '{n} 次调用未计价（非 DeepSeek 官方路由，无公开价目表）',
      'cost.empty': '尚无计费轮次',
      'cost.refresh': '刷新',
      'cost.refreshTitle': '刷新价目（抓取官方页）',
      'cost.refreshing': '抓取中…',
      'cost.refreshFailed': '抓取失败：{error}',
      'cost.candidate': '官方页解析结果',
      'cost.noChanges': '与当前价目一致，无需改动',
      'cost.warnings': '{n} 条提醒',
      'cost.apply': '采用',
      'cost.discard': '放弃',
      'cost.bookBuiltin': '价目：内置表',
      'cost.bookOfficial': '价目：官方页 · {time}',
      'cost.bookUnknown': '价目表不可用：{error}',
      'cost.approxNote': '{n} 轮按 Flash 档估算（deepseek-v4-pro 的档位存在争议，见 README）',
      'cost.approxMark': '按Flash档估',
      'cost.retry': '重试',
    }

    /** 英文文案，键集合与中文一致。 */
    const en = {
      'cost.title': 'Conversation cost',
      'cost.pill.aria': 'Conversation total {total}, latest turn {last}',
      'cost.hit': 'Cache hit',
      'cost.miss': 'Miss',
      'cost.turn': 'Turn {n}',
      'cost.unpriced': 'unpriced',
      'cost.unpricedNote': '{n} calls unpriced (non-DeepSeek route, no public price list)',
      'cost.empty': 'No billed turn yet',
      'cost.refresh': 'Refresh',
      'cost.refreshTitle': 'Refresh prices (fetch the official page)',
      'cost.refreshing': 'Fetching…',
      'cost.refreshFailed': 'Fetch failed: {error}',
      'cost.candidate': 'Parsed from the official page',
      'cost.noChanges': 'Identical to the current prices',
      'cost.warnings': '{n} warnings',
      'cost.apply': 'Apply',
      'cost.discard': 'Discard',
      'cost.bookBuiltin': 'Prices: built-in',
      'cost.bookOfficial': 'Prices: official · {time}',
      'cost.bookUnknown': 'Price table unavailable: {error}',
      'cost.approxNote': '{n} turns estimated at the Flash row (deepseek-v4-pro tiering is disputed, see README)',
      'cost.approxMark': 'Flash-rate est.',
      'cost.retry': 'Retry',
    }

    /** 注入样式表一次（按 data-plugin-css 去重，与官方插件的写法一致）。 */
    function installStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG_ID) + ']') !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = NS
      tag.dataset.pluginCss = CSS_TAG_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /**
     * 金额显示。
     *
     * 费用是「未取整的浮点和」，显示时才定位小数：单轮常常在 0.001 元量级，
     * 所以小额给 4 位；金额变大后位数自然收窄，避免读一长串没意义的末位。
     * @param {number} value - CNY 金额。
     * @returns {string} 形如 `¥0.0123` 的文本。
     */
    function formatCny(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      const abs = Math.abs(value)
      const digits = abs >= 100 ? 2 : abs >= 1 ? 3 : 4
      return '¥' + value.toFixed(digits)
    }

    /**
     * 抓取时刻的紧凑显示（`10/13 02:06`）。
     *
     * 刻意不用 `toLocaleString()` 的默认格式：带年份与秒会多出 8 个字符，
     * 而面板里这只是一行来源备注，不值得为它占宽（完整时刻放在 `title` 里悬停可见）。
     * @param {number|null|undefined} ms - 抓取时刻。
     * @returns {string} 紧凑时间；无效值返回空串。
     */
    function formatFetchedAt(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
      try {
        return new Date(ms).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      } catch {
        return new Date(ms).toLocaleString()
      }
    }

    /** 钱币图标（官方 primitives 没有货币图标，自绘一个 14px 的）。 */
    function CoinIcon() {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: 14,
        height: 14,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
      h('circle', { key: 'c', cx: 8, cy: 8, r: 5.5 }),
      h('path', { key: 'y', d: 'M9.6 6.2 8 8.4 6.4 6.2' }),
      h('path', { key: 's', d: 'M8 8.4V10.8' }),
      h('path', { key: 'b', d: 'M6.4 9.2h3.2' }))
    }

    // ---------------------------------------------------------------- 价目书仓库

    /**
     * 价目书：全局一份，浏览器侧只读缓存。
     *
     * 用 `useSyncExternalStore` 订阅，所以采用新价目后所有读它的组件（胶囊 + 面板）
     * 同一次渲染里就用新数字，整段对话瞬时重算。
     */
    const bookStore = (() => {
      let state = { status: 'loading', book: undefined, error: undefined }
      const listeners = new Set()
      const emit = () => { for (const listener of listeners) listener() }
      const set = (next) => { state = next; emit() }

      /**
       * 发一个价目请求。
       * @param {string} path - 接口路径。
       * @param {'GET' | 'POST'} method - 方法。
       * @returns {Promise<object>} 解析后的 JSON。
       */
      const request = async (path, method) => {
        const response = await fetch(path, {
          method,
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        })
        const body = await response.json().catch(() => ({}))
        if (!response.ok || body.ok === false) throw new Error(body.error ?? `HTTP ${response.status}`)
        return body
      }

      return {
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        get() {
          return state
        },
        /** 启动时取一次当前生效的价目书（失败也记下来，界面据此显示原因）。 */
        async load() {
          try {
            const body = await request(API.book, 'GET')
            set({ status: 'ready', book: body.book, error: undefined })
          } catch (error) {
            set({ status: 'error', book: undefined, error: error instanceof Error ? error.message : String(error) })
          }
        },
        /**
         * 抓官方页（宿主侧解析并暂存候选，**不生效**）。
         * @returns {Promise<{changes: string[], warnings: string[]}>} 候选的变更与提醒。
         */
        async refresh() {
          const body = await request(API.refresh, 'POST')
          return { changes: body.changes ?? [], warnings: body.warnings ?? [] }
        },
        /**
         * 采用暂存的候选。
         * @returns {Promise<void>} 完成后 store 里就是新书。
         */
        async apply() {
          const body = await request(API.apply, 'POST')
          set({ status: 'ready', book: body.book, error: undefined })
        },
      }
    })()

    // ---------------------------------------------------------------- 计价（pricing.js 的镜像）

    /**
     * 按当前价目书把一桶 token 折算成钱。
     * 与宿主 pricing.js 的 `spendFor` 一一对应；两处改动必须同步。
     * @param {object} bucket - 计价桶（model/row/peak/priceable/tokens）。
     * @param {object} book - 价目书。
     * @returns {{total: number, hit: number, miss: number}} CNY 金额。
     */
    function spendOf(bucket, book) {
      const price = book?.rows?.[bucket.row]
      if (price === undefined) return { total: 0, hit: 0, miss: 0 }
      const column = bucket.peak ? 'peak' : 'offPeak'
      const hit = ((bucket.tokens.cacheReadTokens ?? 0) * price.cacheHit[column]) / 1_000_000
      const miss = (((bucket.tokens.inputTokens ?? 0) + (bucket.tokens.cacheWriteTokens ?? 0)) * price.inputMiss[column]
        + (bucket.tokens.outputTokens ?? 0) * price.output[column]) / 1_000_000
      return { total: hit + miss, hit, miss }
    }

    /**
     * 一轮的费用与两个标记。
     * `approximated` 对应宿主 pricing.js 的 `isDowngradedPro`：本该按 pro 价、却被
     * 栅栏按下 Flash 档估的轮次（用户要求标出来，但暂不改逻辑）。
     * @param {object} turn - 事实视图里的一轮。
     * @param {object} book - 价目书。
     * @returns {{index: number, total: number, hit: number, miss: number, priced: boolean, approximated: boolean, unpriced: boolean}} 该轮结果。
     */
    function turnCost(turn, book) {
      let total = 0
      let hit = 0
      let miss = 0
      let priced = false
      let approximated = false
      for (const bucket of turn.buckets) {
        if (!bucket.priceable) continue
        const cost = spendOf(bucket, book)
        total += cost.total
        hit += cost.hit
        miss += cost.miss
        priced = true
        if (bucket.row === 'flash' && typeof bucket.model === 'string' && bucket.model.includes('v4-pro')) approximated = true
      }
      const priceableBuckets = turn.buckets.filter((bucket) => bucket.priceable).length
      return { index: turn.index, total, hit, miss, priced, approximated, unpriced: !priced && priceableBuckets === 0 && turn.buckets.length > 0 }
    }

    /**
     * 整个会话的费用：按保留的轮次现算，所以换一本价目书就是全部重算。
     * @param {object|undefined} view - 投影事实视图。
     * @param {object|undefined} book - 价目书。
     * @returns {{totals: object, turns: object[], approximatedTurns: number}} 汇总结果。
     */
    function sessionCost(view, book) {
      const totals = { total: 0, hit: 0, miss: 0 }
      let approximatedTurns = 0
      const turns = (view?.turns ?? []).map((turn) => {
        const cost = turnCost(turn, book)
        totals.total += cost.total
        totals.hit += cost.hit
        totals.miss += cost.miss
        if (cost.approximated) approximatedTurns += 1
        return cost
      })
      return { totals, turns, approximatedTurns }
    }

    // ---------------------------------------------------------------- 组件

    /**
     * 一颗胶囊的展开座位：定位、外部点击关闭、Esc 关闭。
     *
     * 与官方 `useStatDialog` 同一套：`useAnchoredPosition(side: 'top')` 把面板夹在
     * 视口内并放在锚点上方（带 ResizeObserver，面板变高会重新定位），
     * `useDismissOnOutsidePointer` 处理点外面，Esc 单独挂。
     * @returns {{open: boolean, setOpen: Function, rootRef: object, panelRef: object, pos: object|undefined}} 座位。
     */
    function useStatDialog() {
      const [open, setOpen] = React.useState(false)
      const rootRef = React.useRef(null)
      const panelRef = React.useRef(null)
      const pos = primitives.useAnchoredPosition({
        open,
        anchorRef: rootRef,
        panelRef,
        side: 'top',
        gap: PANEL_GAP,
        margin: PANEL_MARGIN,
      })
      primitives.useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)
      React.useEffect(() => {
        if (!open) return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [open])
      return { open, setOpen, rootRef, panelRef, pos }
    }

    /**
     * 价目刷新的状态机：抓取 → 确认 → 采用/放弃。
     *
     * 抽成 hook 是因为它的两块 UI 必须落在面板的**两个不同行**上：按钮在标题行，
     * "价目 + 变更确认"在独立的第二行。状态要共享，但绝不能都塞进标题行——
     * 那会把标题挤断、三个东西挤成一行（已经踩过一次）。
     *
     * 分两步确认是刻意的：官方页是人读文档，解析有可能错，所以**先把解析出的改动列给用户看**，
     * 点"采用"才生效。抓到的候选留在宿主内存里，浏览器不回传任何数字。
     * @returns {{phase: object, busy: boolean, startRefresh: Function, applyCandidate: Function, discard: Function}} 状态与动作。
     */
    function usePriceRefresh() {
      const [phase, setPhase] = React.useState({ kind: 'idle' })

      /** 抓取官方页并进入确认态。 */
      const startRefresh = async () => {
        setPhase({ kind: 'busy' })
        try {
          const { changes, warnings } = await bookStore.refresh()
          setPhase({ kind: 'confirm', changes, warnings })
        } catch (error) {
          setPhase({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
        }
      }

      /** 采用候选。 */
      const applyCandidate = async () => {
        setPhase({ kind: 'busy' })
        try {
          await bookStore.apply()
          setPhase({ kind: 'idle' })
        } catch (error) {
          setPhase({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
        }
      }

      return {
        phase,
        busy: phase.kind === 'busy',
        startRefresh,
        applyCandidate,
        discard: () => setPhase({ kind: 'idle' }),
      }
    }

    /**
     * 标题行右侧那颗"刷新"按钮。
     *
     * 短标签 + `white-space:nowrap`（见 .dshsc_action）：标题行是 flex，长标签会被挤成
     * `刷新价`/`目` 那样的断行。完整说明放 title 与 aria-label。
     * @param {{t: Function, refresh: object}} props - 文案与刷新状态机。
     * @returns {object} 按钮元素。
     */
    function RefreshButton({ t, refresh }) {
      return h('button', {
        type: 'button',
        className: 'dshsc_action',
        disabled: refresh.busy,
        title: t('cost.refreshTitle'),
        'aria-label': t('cost.refreshTitle'),
        onClick: refresh.startRefresh,
      }, refresh.busy ? t('cost.refreshing') : t('cost.refresh'))
    }

    /**
     * 面板的**第二行**：价目来源（恒定单行，过长省略）、抓取失败提示、解析结果确认区。
     *
     * 它必须是标题行的**兄弟节点**而不是子节点——作为子节点时它会成为标题行 flex 的第三个
     * 元素，把"本对话费用"挤到省略号、三者挤在同一行（这就是之前截图里的样子）。
     * @param {{t: Function, book: object|undefined, refresh: object}} props - 文案、价目书与刷新状态机。
     * @returns {object} 状态区元素。
     */
    function PriceStatus({ t, book, refresh }) {
      const { phase } = refresh
      return h(React.Fragment, null,
        h('div', {
          key: 'source',
          className: 'dshsc_source',
          title: book?.fetchedAtMs ? new Date(book.fetchedAtMs).toLocaleString() : undefined,
        }, book === undefined
          ? t('cost.bookUnknown', { error: t('cost.refresh') })
          : book.source === 'official'
            ? t('cost.bookOfficial', { time: formatFetchedAt(book.fetchedAtMs) })
            : t('cost.bookBuiltin')),

        phase.kind === 'error'
          ? h('div', { key: 'error', className: 'dshsc_alert dshsc_bad' }, t('cost.refreshFailed', { error: phase.message }))
          : null,

        phase.kind === 'confirm'
          ? h('div', { key: 'confirm', className: 'dshsc_confirm' },
            h('div', { className: 'dshsc_confirmTitle' }, t('cost.candidate')),
            h('ul', { className: 'dshsc_changes' }, phase.changes.length === 0
              ? h('li', null, t('cost.noChanges'))
              : phase.changes.map((change) => h('li', { key: change }, change))),
            phase.warnings.length > 0
              ? h('div', { className: 'dshsc_alert dshsc_bad' }, phase.warnings.join('；'))
              : null,
            h('div', { className: 'dshsc_actions' },
              h('button', { key: 'discard', type: 'button', className: 'dshsc_action', onClick: refresh.discard }, t('cost.discard')),
              h('button', { key: 'apply', type: 'button', className: 'dshsc_action', onClick: refresh.applyCandidate }, t('cost.apply'))))
          : null)
    }

    /**
     * 展开面板：第一行标题 + 刷新按钮，第二行价目来源，然后固定「总命中 / 总未命中」，
     * 下面按轮滚动，底部是档位与未计价提示。
     * @param {{costs: object, view: object, book: object|undefined, t: Function, pos: object|undefined, panelRef: object}} props - 面板入参。
     * @returns {object} 面板 React 元素。
     */
    function CostPanel({ costs, view, book, t, pos, panelRef }) {
      const scrollRef = React.useRef(null)
      const refresh = usePriceRefresh()
      const turnCount = costs.turns.length
      // 默认停在最底部（最新一轮），新轮次到达时也跟进：向上滚才能看更早的费用。
      React.useEffect(() => {
        const el = scrollRef.current
        if (el === null) return
        el.scrollTop = el.scrollHeight
      }, [turnCount])
      return h('div', {
        ref: panelRef,
        className: 'dshsc_panel',
        role: 'dialog',
        'aria-label': t('cost.title'),
        style: pos ?? MEASURE_STYLE,
      },
      // 第一行：只放标题与刷新按钮（两个 flex 子元素，谁都不会被挤断）。
      h('div', { key: 'title', className: 'dshsc_title' },
        h('span', { className: 'dshsc_titleLabel' }, CoinIcon(), t('cost.title')),
        h(RefreshButton, { key: 'refresh', t, refresh })),
      // 第二行：价目来源与价目相关的临时状态。
      h(PriceStatus, { key: 'status', t, book, refresh }),
      h('div', { key: 'rule', className: 'dshsc_rule', 'aria-hidden': true }),
      h('div', { key: 'summary', className: 'dshsc_summary' },
        h('span', { key: 'hl', className: 'dshsc_summaryLabel' }, t('cost.hit')),
        h('span', { key: 'hv', className: 'dshsc_summaryValue' }, formatCny(costs.totals.hit)),
        h('span', { key: 'ml', className: 'dshsc_summaryLabel' }, t('cost.miss')),
        h('span', { key: 'mv', className: 'dshsc_summaryValue' }, formatCny(costs.totals.miss))),
      h('div', { key: 'scroll', ref: scrollRef, className: 'dshsc_scroll' }, turnCount === 0
        ? h('div', { className: 'dshsc_line' }, h('span', { className: 'dshsc_lineLabel' }, t('cost.empty')))
        : costs.turns.map((turn) => h('div', { key: turn.index, className: 'dshsc_block' },
          h('div', { key: 't', className: 'dshsc_line dshsc_total' },
            h('span', { key: 'l', className: 'dshsc_lineLabel' },
              t('cost.turn', { n: turn.index }),
              turn.approximated ? h('span', { key: 'mark', className: 'dshsc_mark', title: t('cost.approxNote', { n: 1 }) }, t('cost.approxMark')) : null),
            h('span', { key: 'v', className: 'dshsc_lineValue' }, turn.priced ? formatCny(turn.total) : t('cost.unpriced'))),
          h('div', { key: 'h', className: 'dshsc_line dshsc_sub' },
            h('span', { key: 'l', className: 'dshsc_lineLabel' }, t('cost.hit')),
            h('span', { key: 'v', className: 'dshsc_lineValue' }, turn.priced ? formatCny(turn.hit) : '—')),
          h('div', { key: 'm', className: 'dshsc_line dshsc_sub' },
            h('span', { key: 'l', className: 'dshsc_lineLabel' }, t('cost.miss')),
            h('span', { key: 'v', className: 'dshsc_lineValue' }, turn.priced ? formatCny(turn.miss) : '—'))))),
      costs.approximatedTurns > 0
        ? h('div', { key: 'approx', className: 'dshsc_note dshsc_bad' }, t('cost.approxNote', { n: costs.approximatedTurns }))
        : null,
      view.unpricedCalls > 0
        ? h('div', { key: 'unpriced', className: 'dshsc_note' }, t('cost.unpricedNote', { n: view.unpricedCalls }))
        : null)
    }

    /**
     * 统计栏里的费用条目。
     * @param {{useProjection: Function, t: Function}} props - 渲染器注入的标准 prop + 本插件 inject 面提供的 `t`。
     * @returns {object|null} 胶囊元素；事实或价目表还没到时返回 null。
     */
    function SessionCostChip({ useProjection, t }) {
      const view = useProjection(PROJECTION_KEY)
      const bookState = React.useSyncExternalStore(bookStore.subscribe, bookStore.get, bookStore.get)
      const { open, setOpen, rootRef, panelRef, pos } = useStatDialog()
      // 投影或价目表还没到：不占位，避免先闪一个 ¥0。
      if (view === undefined || bookState.status === 'loading') return null
      if (view.turnsStarted === 0) return null
      const book = bookState.book
      const costs = sessionCost(view, book)
      const last = costs.turns[costs.turns.length - 1]
      const totalText = book === undefined ? '—' : formatCny(costs.totals.total)
      const lastText = last === undefined ? '—' : last.priced ? formatCny(last.total) : t('cost.unpriced')
      return h('span', { ref: rootRef, className: 'dshsc_anchor' },
        h('button', {
          key: 'pill',
          type: 'button',
          className: 'dshsc_pill',
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          'aria-label': t('cost.pill.aria', { total: totalText, last: lastText }),
          onClick: () => setOpen(!open),
        },
        CoinIcon(),
        h('span', { key: 'label', className: 'dshsc_label' },
          totalText,
          h('span', { key: 'sep', className: 'dshsc_sep', 'aria-hidden': true }, '·'),
          lastText)),
        open ? ReactDOM.createPortal(h(CostPanel, { costs, view, book, t, pos, panelRef }), document.body) : null)
    }

    /** 需要的客户端服务。 */
    const inject = ['slots', 'locale']

    /**
     * 客户端装配：装样式、注册词典、取一次价目表、把条目注册进统计栏 slot。
     * @param {import('@deepseek-ai/cordis').Context} ctx - 客户端根上下文。
     * @returns {void}
     */
    function apply(ctx) {
      installStyles()
      // 价目表取一次就够；采用新价目由面板里的按钮刷新 store。
      void bookStore.load()
      const disposers = [
        ctx.locale.register(NS, { zh, en }),
        // 等 slot 被声明出来再注册（ui-conversation 声明 conversation.composer.dock）。
        // order 1 排在官方 'stats' 条目的右边，同处一行。
        ctx.slots.inject(SLOT, () => ctx.slots.register({
          name: SLOT,
          id: ENTRY_ID,
          order: 1,
          // 词典走自己注入的 t，而不是 register 的 locale 选项：这样 t 一定存在，
          // 且每次调用都按当前语言重新 bind。
          inject: () => ({ t: (key, params) => ctx.locale.bind(NS)(key, params) }),
        }, SessionCostChip)),
      ]
      ctx.effect(() => () => {
        for (const dispose of disposers.splice(0)) {
          try {
            dispose()
          } catch {
            // 已经随 fiber 卸载掉了。
          }
        }
      }, NS + ': ui mounts')
    }

    return { apply, inject }
  },
})
