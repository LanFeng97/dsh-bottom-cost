/**
 * 计价：峰谷时钟、模型→价目行判定、以及「用哪本价目书算多少钱」。
 *
 * 口径与官方中文价目页（api-docs.deepseek.com/zh-cn/quick_start/pricing）一致：
 * 高峰时段为北京时间周一至周五 09:00-12:00 与 14:00-18:00（法定节假日除外），
 * 空闲价为高峰价的一半；服务商按**日历日**判定，所以调休上班的周六周日仍是空闲档。
 *
 * 本模块**不内置金额**：数字全部来自 ./pricebook.js 的价目书（内置表或抓取到的官方表）。
 * 这里只负责——什么时候是高峰、某个模型该用哪一行、以及按当前那本书把 token 折算成钱。
 * 因为金额不再烧进持久化状态（见 fold.js 的注释），换一本书就能把整段对话重算一遍。
 * @module dsh-bottom-cost/pricing
 */

import { CHINESE_PUBLIC_HOLIDAYS, HOLIDAY_TABLE_LAST_YEAR } from './holidays.js'

/**
 * 计入 DeepSeek 官方计价的 provider 路由 id。
 *
 * `deepseek` 是可配置目录里的路由别名，`deepseek-official` 是 llm-deepseek 运行时
 * 实际注册的路由，`deepseek-account` 是登录账号路由——它没有 API key、探测目录里也没有，
 * 但计的是同一个账号。其他 provider 没有公开价目表，一律不计价。
 */
const DEEPSEEK_FAMILY_IDS = new Set(['deepseek', 'deepseek-official', 'deepseek-account'])

/**
 * 该 provider 路由是否属于 DeepSeek 官方家族（决定能否计价）。
 * @param {string} provider - 会话上报的 provider id。
 * @returns {boolean} 是否可计价。
 */
export function isDeepSeekProviderRoute(provider) {
  return typeof provider === 'string' && DEEPSEEK_FAMILY_IDS.has(provider)
}

/** 高峰时段（北京时间，分钟数，含起点不含终点）。 */
export const PEAK_WINDOWS = [
  { from: 9 * 60, to: 12 * 60 },
  { from: 14 * 60, to: 18 * 60 },
]

/** 北京全年 UTC+8、无夏令时，所以固定偏移就是精确值。 */
const BEIJING_UTC_OFFSET_MS = 8 * 3_600_000

/**
 * 关于 `deepseek-v4-pro` 的一处历史：2026-09-14 曾计划下线 Pro、把它的请求按 V4.1-Flash
 * 承接并计费，@linxin666/dsh-usage 据此设了一条时间栅栏。**官方随后决定继续提供 Pro、
 * 计费方式保持不变**，所以本插件按官方价目把 pro 恒记在它自己那一行。
 * 早先照抄的那条栅栏已删除（0.5.1），不要再从旧资料里加回来。
 */

/**
 * 北京时间的 `YYYY-MM-DD` 日历日。
 * @param {number} ms - 时间戳。
 * @returns {string} 该时刻的北京日历日。
 */
function beijingDate(ms) {
  const shifted = new Date(ms + BEIJING_UTC_OFFSET_MS)
  const month = `${shifted.getUTCMonth() + 1}`.padStart(2, '0')
  const day = `${shifted.getUTCDate()}`.padStart(2, '0')
  return `${shifted.getUTCFullYear()}-${month}-${day}`
}

/**
 * 该时刻是否落在「可能有高峰」的北京日：周一至周五且非法定节假日。
 * 表里没有的年份视为没有节假日，工作日按高峰档，估算偏高而非偏低。
 * @param {number} ms - 时间戳。
 * @returns {boolean} 是否可能有高峰时段。
 */
function isPeakDay(ms) {
  const shifted = new Date(ms + BEIJING_UTC_OFFSET_MS)
  const weekday = shifted.getUTCDay()
  if (weekday < 1 || weekday > 5) return false
  const year = shifted.getUTCFullYear()
  if (year > HOLIDAY_TABLE_LAST_YEAR) return true
  return CHINESE_PUBLIC_HOLIDAYS[String(year)]?.includes(beijingDate(ms)) !== true
}

/**
 * 该时刻的 DeepSeek 计费档位。
 *
 * 折叠时会把结果作为**事实**记进 token 桶（`peak: boolean`），所以浏览器侧算钱时
 * 不需要时钟、也不需要节假日表。
 * @param {number} ms - 时间戳。
 * @returns {{peak: boolean}} 高峰为 true，空闲为 false。
 */
export function deepseekPeriodAt(ms) {
  const shifted = new Date(ms + BEIJING_UTC_OFFSET_MS)
  const minuteOfDay = shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
  if (!isPeakDay(ms)) return { peak: false }
  return { peak: PEAK_WINDOWS.some((w) => minuteOfDay >= w.from && minuteOfDay < w.to) }
}

/**
 * 某个模型 id 该用哪一行价目。
 *
 * `deepseek-v4-pro` **恒用它自己那一行**（官方继续提供 Pro 且计费不变，见上方说明）。
 * 未收录的 id 走 flash 行：官方页脚注说明旧模型名（`deepseek-v4-flash`、
 * `deepseek-v4-flash-vision-exp`）由 V4.1-Flash 提供服务并按 Flash 价格计费。
 * @param {string} model - 模型 id。
 * @returns {'flash' | 'pro'} 价目行键。
 */
export function priceRowKeyFor(model) {
  return typeof model === 'string' && model.includes('v4-pro') ? 'pro' : 'flash'
}

/**
 * 按给定的价目书把一批 token 折算成费用，并拆成命中/未命中两个加数。
 *
 * 口径：
 * - 命中 = 缓存读 tokens × 命中价；
 * - 未命中 = （未命中输入 + 缓存写）tokens × 未命中输入价 + 输出 tokens × 输出价；
 * - 推理 tokens 已包含在输出桶里（服务商口径），不再单独相加。
 *
 * 不做取整：让「总 = 命中 + 未命中」在浮点累加下成立，取整只发生在显示层。
 * @param {object} book - 价目书（见 pricebook.js）。
 * @param {'flash' | 'pro'} row - 价目行键。
 * @param {boolean} peak - 该次调用是否落在高峰档。
 * @param {{inputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, outputTokens: number}} tokens - token 桶。
 * @returns {{total: number, hit: number, miss: number}} CNY 金额，未取整；价目行缺失时全为 0。
 */
export function spendFor(book, row, peak, tokens) {
  const price = book?.rows?.[row]
  if (price === undefined) return { total: 0, hit: 0, miss: 0 }
  const column = peak ? 'peak' : 'offPeak'
  const hit = ((tokens.cacheReadTokens ?? 0) * price.cacheHit[column]) / 1_000_000
  const miss = (((tokens.inputTokens ?? 0) + (tokens.cacheWriteTokens ?? 0)) * price.inputMiss[column]
    + (tokens.outputTokens ?? 0) * price.output[column]) / 1_000_000
  return { total: hit + miss, hit, miss }
}
