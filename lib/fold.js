/**
 * `sessionCost` 的纯折叠逻辑：`session/event` → 按轮次的 **token 事实**账本。
 *
 * **这里刻意不存任何金额。** 状态里只有事实：每次模型调用的 token 桶、它属于哪一行价目
 * （flash/pro）、当时是高峰还是空闲、以及该 provider 是否可计价。钱由浏览器按**当前那本
 * 价目书**现算（见 client.js），于是"刷新价目"就是把书换掉、整段对话立刻重算——
 * 不需要改历史数据，也不会有两代价格混在一本账里。
 *
 * 这个文件**零三方依赖**（只用 ./pricing.js），因此可以脱离 DSH 直接跑自测。
 *
 * 约定：`applyEvent` 只在真的变了的时候返回**新引用**（投影注册表按 `Object.is` 判断是否
 * 重算视图），且状态必须 JSON 安全（会被结构化克隆写进 checkpoint），所以用 `null` 而不是
 * `undefined`。
 * @module dsh-bottom-cost/fold
 */

import { deepseekPeriodAt, isDeepSeekProviderRoute, priceRowKeyFor } from './pricing.js'

/** 投影 key：浏览器侧用 `useProjection(SESSION_COST_KEY)` 读同一个 key。 */
export const SESSION_COST_KEY = 'sessionCost'

/** 每个会话最多保留多少轮明细供面板滚动查看；累计由视图层按保留的轮次算。 */
export const MAX_RETAINED_TURNS = 200

/** 一个空的 token 桶。 */
export function emptyTokens() {
  return { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 }
}

/**
 * 取事件时刻。
 *
 * 必须用事件自己的 `time` 而不是 `Date.now()`：投影会在内存日志上**回放历史**
 * （插件晚注册、宿主重启后的回填），用当前时间会把几个月前的调用按今天的峰谷档计价。
 * 回退分支只为手工构造的测试事件存在，正式事件由会话格式保证带 `time`。
 * @param {{time?: unknown}} event - 会话事件。
 * @returns {number} 毫秒时间戳。
 */
export function eventTimeOf(event) {
  return typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : Date.now()
}

/**
 * 归一化一条 `assistant/message` 的 usage。
 * `inputTokens` 只含未命中缓存的输入；缓存读/写是各自独立的桶（服务商口径）。
 * @param {unknown} usage - 事件里的 usage 对象。
 * @returns {object|undefined} token 桶；字段不可用时 undefined。
 */
export function readTokens(usage) {
  if (typeof usage !== 'object' || usage === null) return undefined
  const raw = /** @type {Record<string, unknown>} */ (usage)
  const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  const tokens = emptyTokens()
  tokens.inputTokens = num(raw.inputTokens)
  tokens.cacheReadTokens = num(raw.cacheReadTokens)
  tokens.cacheWriteTokens = num(raw.cacheWriteTokens)
  tokens.outputTokens = num(raw.outputTokens)
  tokens.reasoningTokens = num(raw.reasoningTokens)
  tokens.totalTokens = tokens.inputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens + tokens.outputTokens
  return tokens
}

/**
 * 生成一轮的初始状态。
 * @param {number} index - 轮序号（从 1 起）。
 * @param {number} startedAtMs - 该轮开始时刻。
 * @returns {object} 轮对象。
 */
function newTurn(index, startedAtMs) {
  return { index, startedAtMs, endedAtMs: null, calls: 0, buckets: [] }
}

/**
 * 用新的轮对象替换列表里的某一轮。
 * @param {object} state - 当前状态。
 * @param {number} index - 要替换的下标。
 * @param {object} turn - 新的轮。
 * @returns {object} 新状态。
 */
function replaceTurn(state, index, turn) {
  const turns = state.turns.slice()
  turns[index] = turn
  return { ...state, turns }
}

/**
 * 一轮是否已结束（`endedAtMs` 非 null）；没有这一轮也算「已结束」。
 * @param {object|undefined} turn - 轮对象。
 * @returns {boolean} 是否已结束。
 */
function isClosed(turn) {
  return turn === undefined || turn.endedAtMs !== null
}

/**
 * 追加一轮并按上限裁剪明细（只有明细会被裁，早先的轮次账不再保留——因为没有金额，
 * 累计由视图层按保留的轮次现算）。
 * @param {object} state - 当前状态。
 * @param {object} turn - 新轮。
 * @returns {object} 新状态。
 */
function appendTurn(state, turn) {
  const turns = [...state.turns, turn]
  if (turns.length > MAX_RETAINED_TURNS) turns.splice(0, turns.length - MAX_RETAINED_TURNS)
  return { ...state, turnsStarted: turn.index, turns }
}

/**
 * 收尾最后一轮（若它还没结束）。
 * @param {object} state - 当前状态。
 * @param {number} nowMs - 收尾时刻。
 * @returns {object} 新状态；没有需要收尾的轮时原样返回。
 */
function closeLastTurn(state, nowMs) {
  const last = state.turns[state.turns.length - 1]
  if (isClosed(last)) return state
  return replaceTurn(state, state.turns.length - 1, { ...last, endedAtMs: nowMs })
}

/** 冷启动状态。会话 header 里没有 provider/model，两者留空，等第一个请求事件补上。 */
export function initState() {
  return {
    provider: '',
    model: '',
    turnsStarted: 0,
    unpricedCalls: 0,
    turns: [],
  }
}

/**
 * 把一次模型调用并进当前轮的对应桶。
 *
 * 桶的键是 `(model, row, peak, priceable)`：同一轮里可能跨峰谷、换模型、或者来自不可
 * 计价的 provider，所以必须分开记，否则算钱时会用错档。
 * @param {object} turn - 当前轮。
 * @param {object} bucketKey - 桶的身份字段。
 * @param {object} tokens - 这次的 token 桶。
 * @returns {object} 新的轮。
 */
function addToBucket(turn, bucketKey, tokens) {
  const index = turn.buckets.findIndex((bucket) => bucket.model === bucketKey.model
    && bucket.row === bucketKey.row
    && bucket.peak === bucketKey.peak
    && bucket.priceable === bucketKey.priceable)
  const buckets = turn.buckets.slice()
  if (index === -1) {
    buckets.push({ ...bucketKey, tokens: { ...tokens } })
    return { ...turn, buckets }
  }
  const current = buckets[index]
  buckets[index] = {
    ...current,
    tokens: {
      inputTokens: current.tokens.inputTokens + tokens.inputTokens,
      cacheReadTokens: current.tokens.cacheReadTokens + tokens.cacheReadTokens,
      cacheWriteTokens: current.tokens.cacheWriteTokens + tokens.cacheWriteTokens,
      outputTokens: current.tokens.outputTokens + tokens.outputTokens,
      reasoningTokens: current.tokens.reasoningTokens + tokens.reasoningTokens,
      totalTokens: current.tokens.totalTokens + tokens.totalTokens,
    },
  }
  return { ...turn, buckets }
}

/**
 * 吃一个会话事件，返回下一个状态。
 * @param {object} state - 当前状态。
 * @param {{type: string, time?: number, data?: unknown}} event - 会话事件。
 * @returns {object} 下一个状态（无变化时是同一个引用）。
 */
export function applyEvent(state, event) {
  switch (event.type) {
    case 'request/header': {
      const config = /** @type {any} */ (event.data ?? {}).header?.config
      if (config?.provider === undefined) return state
      const provider = config.provider
      const model = config.model ?? ''
      if (provider === state.provider && model === state.model) return state
      return { ...state, provider, model }
    }
    case 'request/context': {
      const data = /** @type {any} */ (event.data ?? {})
      if (data.provider === undefined) return state
      const provider = data.provider
      const model = data.model ?? ''
      if (provider === state.provider && model === state.model) return state
      return { ...state, provider, model }
    }
    case 'turn/start': {
      // 上一轮若还开着（异常流），先按本轮开始时刻收尾，再开新轮。
      const atMs = eventTimeOf(event)
      const closed = closeLastTurn(state, atMs)
      return appendTurn(closed, newTurn(closed.turnsStarted + 1, atMs))
    }
    case 'turn/end': {
      return closeLastTurn(state, eventTimeOf(event))
    }
    case 'assistant/message': {
      const tokens = readTokens(/** @type {Record<string, unknown>} */ (event.data ?? {}).usage)
      if (tokens === undefined) return state
      const atMs = eventTimeOf(event)
      // 正常情况下 turn/start 一定先到（会话不变式要求核心执行事件包在轮内）；
      // 若没有开着的轮（插件中途装载等异常路径），就补一轮，别把用量丢掉。
      let base = state
      let index = base.turns.length - 1
      if (isClosed(base.turns[index])) {
        base = appendTurn(base, newTurn(base.turnsStarted + 1, atMs))
        index = base.turns.length - 1
      }
      const model = base.model
      const priceable = isDeepSeekProviderRoute(base.provider)
      const bucketKey = {
        model,
        row: priceRowKeyFor(model, atMs),
        peak: deepseekPeriodAt(atMs).peak,
        priceable,
      }
      const current = base.turns[index]
      const turn = addToBucket(current, bucketKey, tokens)
      const next = replaceTurn(base, index, { ...turn, calls: current.calls + 1 })
      return priceable ? next : { ...next, unpricedCalls: base.unpricedCalls + 1 }
    }
    default:
      return state
  }
}

/**
 * 状态 → 浏览器可见的视图。只下发**事实**（token 桶与它们的计价身份），
 * 金额由浏览器按当前价目书算；因此换书即重算，不需要重新下发任何东西。
 * @param {object} state - 投影状态。
 * @returns {object} 视图。
 */
export function viewOf(state) {
  return {
    turnsStarted: state.turnsStarted,
    unpricedCalls: state.unpricedCalls,
    turns: state.turns.map((turn) => ({ index: turn.index, calls: turn.calls, buckets: turn.buckets })),
  }
}
