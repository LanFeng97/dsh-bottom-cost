/**
 * `sessionCost` 投影单元：把 {@link ../fold.js 纯折叠逻辑} 包装成 DSH 投影注册表要的形状
 * （stateSchema + `wire.viewSchema` + `wire.view`）。
 *
 * 为什么用投影而不是自己订阅 `session/event`：
 * 1. **自带历史回填**。注册表对「注册晚于事件流过」的会话，会在首次触碰时用 `init`
 *    在内存日志上重放（见 @deepseek-ai/dsh-session-projection 的注册表文档），所以插件装上
 *    或宿主重启之后，当前对话里**已经发生**的轮次也会被折出来，卡片不会显示成 0；
 * 2. **自带推送**。视图值按 key 走会话控制流下发，浏览器用 `useProjection('sessionCost')` 读，
 *    因此不需要 HTTP 路由、不需要轮询、也不需要从 DOM 猜当前会话 id。
 *
 * 注意这里**没有** `sessionProjectionCache` 的持久化依赖：状态里不含金额，也不含抓取到的
 * 价目表，所以即便 checkpoint 被丢弃、靠内存日志重放一次，算出来的钱也一样。
 *
 * 形状用本仓库自带的 {@link ./shape.js} 描述，**不依赖 zod**：注册表只调用 `.parse`，
 * 而复制式安装要求插件自足（详见 shape.js 顶部的取舍说明）。
 *
 * 这个文件**不承载业务逻辑**：折叠在 fold.js，价格在 pricebook.js / pricing.js。
 * @module dsh-bottom-cost/projection
 */

import { SESSION_COST_KEY, applyEvent, initState, viewOf } from './fold.js'
import * as shape from './shape.js'

/** 一行 token 桶的形状（字段与服务商 usage 口径一致）。 */
const tokensSchema = shape.object({
  /** 未命中缓存的输入。 */
  inputTokens: shape.number(),
  /** 命中缓存的输入（便宜档）。 */
  cacheReadTokens: shape.number(),
  /** 写入缓存的部分，按未命中输入计价。 */
  cacheWriteTokens: shape.number(),
  /** 输出（推理 token 已含在其中，服务商口径）。 */
  outputTokens: shape.number(),
  /** 推理 token，单列备查，不额外计价。 */
  reasoningTokens: shape.number(),
  /** 上面四项之和。 */
  totalTokens: shape.number(),
})

/**
 * 一个计价桶：同一次模型调用在「哪一行价目 + 哪个时段 + 能否计价」上的身份 + 它的 token。
 * 金额不在这里——浏览器按当前价目书现算。
 */
const bucketSchema = shape.object({
  /** 当时使用的模型 id。 */
  model: shape.string(),
  /** 该用哪一行价目（fold 时按模型与栅栏判定）。 */
  row: shape.oneOf(['flash', 'pro']),
  /** 是否落在高峰档（fold 时按事件时刻判定）。 */
  peak: shape.boolean(),
  /** provider 是否属于可计价的 DeepSeek 官方家族。 */
  priceable: shape.boolean(),
  /** 该桶累计的 token。 */
  tokens: tokensSchema,
})

/**
 * 状态里的一轮：比视图多两个时间事实（账本留档用，不下发）。
 */
const stateTurnSchema = shape.object({
  /** 第几轮（从 1 起，按会话内 turn/start 计数，不随列表裁剪回退）。 */
  index: shape.number(),
  /** 该轮开始时刻。 */
  startedAtMs: shape.number(),
  /** 该轮结束时刻；`null` 表示还在进行中。 */
  endedAtMs: shape.nullable(shape.number()),
  /** 该轮折叠了几次模型尝试。 */
  calls: shape.number(),
  /** 该轮的计价桶。 */
  buckets: shape.list(bucketSchema),
})

/**
 * 视图里的一轮：只下发面板要渲染的东西。
 *
 * 必须与 fold.js 的 `viewOf` 逐字段对应——这两处不一致会让**每次**投影读写都抛错。
 * `tools/schema-check.mjs` 专门守这条缝（它就是抓到过一次这种不一致才加的）。
 */
const viewTurnSchema = shape.object({
  /** 第几轮。 */
  index: shape.number(),
  /** 该轮折叠了几次模型尝试。 */
  calls: shape.number(),
  /** 该轮的计价桶。 */
  buckets: shape.list(bucketSchema),
})

/**
 * 宿主持有的投影状态（checkpoint 里存的就是它）。
 * 改动这个形状必须同时 +1 {@link SESSION_COST_STATE_VERSION}。
 */
export const sessionCostStateSchema = shape.object({
  /** 最近一次上报的 provider 路由 id。 */
  provider: shape.string(),
  /** 最近一次上报的模型 id。 */
  model: shape.string(),
  /** 已开始的轮次总数。 */
  turnsStarted: shape.number(),
  /** 因 provider 无价目表而未计价的调用次数。 */
  unpricedCalls: shape.number(),
  /** 明细，尾部最新。 */
  turns: shape.list(stateTurnSchema),
})

/** 浏览器可见的视图 schema（只有事实，没有金额）；注册表在每次下发前校验它。 */
export const sessionCostViewSchema = shape.object({
  /** 已开始的轮次总数。 */
  turnsStarted: shape.number(),
  /** 未计价的调用次数（非 DeepSeek 路由）；> 0 时面板给出提示。 */
  unpricedCalls: shape.number(),
  /** 明细，尾部最新。 */
  turns: shape.list(viewTurnSchema),
})

/**
 * 状态版本。
 *
 * v1 把金额烧在状态里（不可重算）；v2 改为只存 token 事实，金额由浏览器按当前价目书算；
 * v3 是**计价规则变化**逼出来的：桶里的 `row` 是在折叠时算好存下的，0.5.1 把
 * `deepseek-v4-pro` 从「按 Flash 档」改回「按自己的 pro 行」，旧检查点里的 pro 桶仍是
 * `flash`——不 +1 就会一直按旧规则显示。版本号 +1 让旧 checkpoint 作废并重放一次，
 * 于是历史轮次也按新规则重算。
 *
 * （形状本身的改动同样必须 +1；而把 zod 换成 shape.js 没改形状，所以那次没动版本号。）
 */
export const SESSION_COST_STATE_VERSION = 3

/** 注册进 `ctx.sessionProjections` 的单元定义。 */
export const sessionCostProjection = {
  key: SESSION_COST_KEY,
  stateVersion: SESSION_COST_STATE_VERSION,
  stateSchema: sessionCostStateSchema,
  /** 冷启动状态（fold.initState）。 */
  init: () => initState(),
  /** 事件折叠（fold.applyEvent）。 */
  apply: (state, event) => applyEvent(state, event),
  wire: {
    viewSchema: sessionCostViewSchema,
    /** 状态 → 客户端视图（fold.viewOf）。 */
    view: (state) => viewOf(state),
  },
}
