/**
 * 自测：价格档位、节假日例外、官方页解析器、价目书校验、按当前价目书重算、
 * 按轮聚合（v2 事实状态）、重放幂等、JSON 安全。
 *
 * 只依赖 lib/fold.js、lib/pricing.js、lib/pricebook.js（三者都零三方依赖），
 * 所以能脱离 DSH 直接跑：
 *   node tools/selftest.mjs
 *
 * 断言里的绝对金额都是手算出来的期望值（不是用被测函数反推），用来兜住计价公式写错。
 * 解析器那几项用 tools/fixtures/pricing-zh.html（抓取当时的官方中文页快照），
 * 因此不联网也能验证"解析结果 == 内置表"。
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { deepseekPeriodAt, isDeepSeekProviderRoute, priceRowKeyFor, spendFor } from '../lib/pricing.js'
import { BUILTIN_PRICE_BOOK, describePriceChanges, parseOfficialPricingPage, validatePriceBook } from '../lib/pricebook.js'
import { MAX_RETAINED_TURNS, applyEvent, initState, viewOf } from '../lib/fold.js'
import { sessionCostStateSchema, sessionCostViewSchema } from '../lib/projection.js'

/** 断言计数与失败收集。 */
let passed = 0
const failures = []

/**
 * 断言。
 * @param {string} name - 用例名。
 * @param {boolean} ok - 是否通过。
 * @param {unknown} [detail] - 失败时的补充信息。
 * @returns {void}
 */
function check(name, ok, detail) {
  if (ok) {
    passed += 1
    return
  }
  failures.push(detail === undefined ? name : `${name} — ${JSON.stringify(detail)}`)
}

/**
 * 近似相等（浮点累加，容差 1e-12）。
 * @param {number} a - 实际值。
 * @param {number} b - 期望值。
 * @returns {boolean} 是否相等。
 */
function near(a, b) {
  return Math.abs(a - b) < 1e-12
}

/** 北京时间的毫秒时间戳。 */
function beijing(iso) {
  return new Date(iso + '+08:00').getTime()
}

/** 造一条事件。 */
const ev = (type, atMs, data) => ({ type, time: atMs, data })

/** 跑一串事件得到状态。 */
function fold(events) {
  let state = initState()
  for (const event of events) state = applyEvent(state, event)
  return state
}

/** 一段正常会话：deepseek-flash，两轮。 */
const T0 = beijing('2026-10-14T13:00:00')
const deepseekHeader = ev('request/header', T0, { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } })

// ---------------------------------------------------------------- 价格档位

check('周三 10:00 北京＝高峰', deepseekPeriodAt(beijing('2026-10-14T10:00:00')).peak === true)
check('周三 13:00 北京＝空闲（峰段之间）', deepseekPeriodAt(beijing('2026-10-14T13:00:00')).peak === false)
check('周三 15:00 北京＝高峰', deepseekPeriodAt(beijing('2026-10-14T15:00:00')).peak === true)
check('周三 12:00 北京＝空闲（峰段右开端）', deepseekPeriodAt(beijing('2026-10-14T12:00:00')).peak === false)
check('周六 10:00 北京＝空闲', deepseekPeriodAt(beijing('2026-10-17T10:00:00')).peak === false)
check('周四但法定节假日（2026-10-01）10:00 北京＝空闲', deepseekPeriodAt(beijing('2026-10-01T10:00:00')).peak === false)
check('deepseek 家族可计价', isDeepSeekProviderRoute('deepseek') && isDeepSeekProviderRoute('deepseek-official') && isDeepSeekProviderRoute('deepseek-account'))
check('非 DeepSeek 路由不可计价', !isDeepSeekProviderRoute('openrouter') && !isDeepSeekProviderRoute(''))

// v4-pro 恒用自己那一行：官方继续提供 Pro 且计费不变（早期照 dsh-usage 抄来的
// 时间栅栏已在 0.5.1 删除），所以这里断言「任何时刻都是 pro 行」。
check('v4-pro 恒用 pro 行（含 2026-09-14 之后）', priceRowKeyFor('deepseek-v4-pro') === 'pro')
check('v4-flash 用 flash 行', priceRowKeyFor('deepseek-v4-flash') === 'flash')
check('未收录的模型 id 走 flash 行', priceRowKeyFor('deepseek-chat') === 'flash')

// ---------------------------------------------------------------- 计价拆分

const mixTokens = { inputTokens: 1000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0, outputTokens: 1000 }
const book = BUILTIN_PRICE_BOOK

const offCost = spendFor(book, 'flash', false, mixTokens)
check('空闲档命中＝1M×0.02/1M', near(offCost.hit, 0.02), offCost.hit)
check('空闲档未命中＝(1000×1.0+1000×4.0)/1M', near(offCost.miss, 0.005), offCost.miss)
check('空闲档总额＝0.025', near(offCost.total, 0.025), offCost.total)
check('总费用恒等于 命中+未命中', near(offCost.total, offCost.hit + offCost.miss))

const peakCost = spendFor(book, 'flash', true, mixTokens)
check('高峰档总额＝0.05', near(peakCost.total, 0.05), peakCost.total)
check('高峰价正好是空闲价的两倍', near(peakCost.total, offCost.total * 2))

const proCost = spendFor(book, 'pro', false, mixTokens)
check('pro 空闲档命中＝1M×0.15/1M', near(proCost.hit, 0.15), proCost.hit)
check('pro 空闲档未命中＝(1000×4.5+1000×13.5)/1M', near(proCost.miss, 0.018), proCost.miss)

// ---------------------------------------------------------------- 按当前价目书重算（B 方案的核心）

const doubled = {
  ...book,
  rows: {
    flash: { cacheHit: { offPeak: 0.04, peak: 0.08 }, inputMiss: { offPeak: 2, peak: 4 }, output: { offPeak: 8, peak: 16 } },
    pro: book.rows.pro,
  },
}
check('换一本价目书，同一批 token 的钱翻倍', near(spendFor(doubled, 'flash', false, mixTokens).total, offCost.total * 2))
check('缺行的价目书返回 0 而不是崩', near(spendFor({ rows: {} }, 'flash', false, mixTokens).total, 0))

// ---------------------------------------------------------------- 官方页解析器

const fixture = readFileSync(path.join(import.meta.dirname, 'fixtures', 'pricing-zh.html'), 'utf8')
const parsed = parseOfficialPricingPage(fixture, 1_700_000_000_000)
check('官方页快照解析成功', parsed.ok === true, parsed.ok ? undefined : parsed.error)
if (parsed.ok) {
  check('解析出的表与内置表逐项一致', JSON.stringify(parsed.book.rows) === JSON.stringify(BUILTIN_PRICE_BOOK.rows))
  check('解析出的表通过校验', validatePriceBook(parsed.book).ok === true)
  check('官方页与内置规则一致 → 无提醒', parsed.warnings.length === 0, parsed.warnings)
  check('解析出的来源标记为 official', parsed.book.source === 'official' && parsed.book.fetchedAtMs === 1_700_000_000_000)
}
check('空页面被拒', parseOfficialPricingPage('', 0).ok === false)
check('没有价目表的页面被拒', parseOfficialPricingPage('<table><tr><td>模型</td><td>x</td></tr></table>', 0).ok === false)
check('缺一个模型列被拒', parseOfficialPricingPage(fixture.replace('deepseek-v4-pro', 'other-model'), 0).ok === false)
check('单价被改坏时被拒', parseOfficialPricingPage(fixture.replace('0.02元', '免费'), 0).ok === false)

// ---------------------------------------------------------------- 价目书校验

check('内置表通过校验', validatePriceBook(BUILTIN_PRICE_BOOK).ok === true)
check('版本不符被拒', validatePriceBook({ ...BUILTIN_PRICE_BOOK, version: 99 }).ok === false)
check('缺少 pro 行被拒', validatePriceBook({ ...BUILTIN_PRICE_BOOK, rows: { flash: BUILTIN_PRICE_BOOK.rows.flash } }).ok === false)
check('单价为 0 被拒', validatePriceBook({
  ...BUILTIN_PRICE_BOOK,
  rows: { ...BUILTIN_PRICE_BOOK.rows, flash: { ...BUILTIN_PRICE_BOOK.rows.flash, output: { offPeak: 0, peak: 8 } } },
}).ok === false)
check('单价荒谬大被拒', validatePriceBook({
  ...BUILTIN_PRICE_BOOK,
  rows: { ...BUILTIN_PRICE_BOOK.rows, flash: { ...BUILTIN_PRICE_BOOK.rows.flash, output: { offPeak: 4, peak: 99999 } } },
}).ok === false)

const changed = { ...BUILTIN_PRICE_BOOK, rows: { ...BUILTIN_PRICE_BOOK.rows, flash: { ...BUILTIN_PRICE_BOOK.rows.flash, cacheHit: { offPeak: 0.02, peak: 0.05 } } } }
const changes = describePriceChanges(BUILTIN_PRICE_BOOK, changed)
check('变更清单只列出改过的那一项', changes.length === 1 && changes[0].includes('0.04 → 0.05'), changes)
check('相同表无变更', describePriceChanges(BUILTIN_PRICE_BOOK, BUILTIN_PRICE_BOOK).length === 0)

// ---------------------------------------------------------------- 按轮聚合（v2 事实）

const script = [
  deepseekHeader,
  ev('turn/start', T0),
  ev('assistant/message', T0 + 1000, { usage: { inputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0, outputTokens: 0 } }),
  // 同一轮、同一模型、同一档位的第二次尝试：必须并进同一个桶
  ev('assistant/message', T0 + 2000, { usage: { inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1000 } }),
  // 同一轮但跨到高峰（15:00）：必须新开一个桶，否则算钱会用错档
  ev('assistant/message', beijing('2026-10-14T15:00:00'), { usage: { inputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0, outputTokens: 0 } }),
  ev('turn/end', beijing('2026-10-14T15:01:00')),
  ev('turn/start', beijing('2026-10-14T15:02:00')),
  ev('assistant/message', beijing('2026-10-14T15:03:00'), { usage: { inputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0, outputTokens: 0 } }),
  ev('turn/end', beijing('2026-10-14T15:04:00')),
]
const state = fold(script)
const view = viewOf(state)

check('折出两轮', state.turns.length === 2, state.turns.length)
check('第一轮三次尝试', state.turns[0].calls === 3, state.turns[0].calls)
check('第一轮两个桶（空闲一个、高峰一个）', state.turns[0].buckets.length === 2, state.turns[0].buckets.length)
// 空闲桶 = 第一次 1M 命中 + 第二次 1000 输入 + 1000 输出（命中/输入/输出各自独立累加，总 1_002_000）
check('空闲桶合并了两次尝试', state.turns[0].buckets[0].peak === false && state.turns[0].buckets[0].tokens.totalTokens === 1_002_000, state.turns[0].buckets[0].tokens)
check('高峰桶单列', state.turns[0].buckets[1].peak === true && state.turns[0].buckets[1].tokens.cacheReadTokens === 1_000_000)
check('桶记的是 flash 行', state.turns[0].buckets.every((bucket) => bucket.row === 'flash'))
check('桶标记为可计价', state.turns[0].buckets.every((bucket) => bucket.priceable === true))

// 手算第一轮：空闲 (0.02 命中) + (1000×1 + 1000×4)/1M=0.005 → 0.025；高峰命中 1M×0.04=0.04
const t1 = state.turns[0].buckets.reduce((sum, bucket) => sum + spendFor(book, bucket.row, bucket.peak, bucket.tokens).total, 0)
check('第一轮按桶算钱＝0.025+0.04', near(t1, 0.065), t1)
const t2 = state.turns[1].buckets.reduce((sum, bucket) => sum + spendFor(book, bucket.row, bucket.peak, bucket.tokens).total, 0)
check('第二轮按桶算钱＝0.04', near(t2, 0.04), t2)

// 事实视图必须**不含金额**：这是 B 方案的核心契约，锁死它以免哪天又烧回状态里。
const turnKeys = Object.keys(view.turns[0]).sort()
check('视图里的一轮只有 index/calls/buckets', JSON.stringify(turnKeys) === JSON.stringify(['buckets', 'calls', 'index']), turnKeys)
const stateTurnKeys = Object.keys(state.turns[0]).sort()
check('状态里的一轮保留时间事实', JSON.stringify(stateTurnKeys) === JSON.stringify(['buckets', 'calls', 'endedAtMs', 'index', 'startedAtMs']), stateTurnKeys)
const bucketKeys = Object.keys(view.turns[0].buckets[0]).sort()
check('桶只有 model/peak/priceable/row/tokens', JSON.stringify(bucketKeys) === JSON.stringify(['model', 'peak', 'priceable', 'row', 'tokens']), bucketKeys)
check('状态与视图里都没有 cost 字段', !JSON.stringify(state).includes('"cost"') && !JSON.stringify(view).includes('"cost"'))
// 视图与状态这两套字段必须与 projection.js 的 schema 逐字段对齐。
// 注意：这一层**能**在这里测（校验器是自带代码），而"装上的那份副本"另由 tools/schema-check.mjs 守。

// ---------------------------------------------------------------- 边界与不变式

check('无关事件不产生新引用', applyEvent(state, ev('tool/result', T0 + 99_000, {})) === state)
check('已收尾后再 turn/end 不产生新引用', applyEvent(state, ev('turn/end', T0 + 99_000)) === state)
check('turn/start 会先收尾上一轮', (() => {
  const open = fold([deepseekHeader, ev('turn/start', T0)])
  const next = applyEvent(open, ev('turn/start', T0 + 5000))
  return next.turns[0].endedAtMs === T0 + 5000 && next.turns.length === 2
})())

// 缺 turn/start 的异常流：不能把用量丢掉
const orphan = fold([
  deepseekHeader,
  ev('assistant/message', T0, { usage: { inputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0, outputTokens: 0 } }),
])
check('无 turn/start 时补一轮记账', orphan.turns.length === 1 && orphan.turns[0].buckets.length === 1)

// 无 usage 的 assistant/message 不该造桶
const noUsage = fold([ev('turn/start', T0), ev('assistant/message', T0 + 1, {})])
check('无 usage 不记桶', noUsage.turns.length === 1 && noUsage.turns[0].buckets.length === 0)

// 非 DeepSeek 路由：记 token 与次数，标为不可计价
const other = fold([
  ev('request/header', T0, { header: { config: { provider: 'openrouter', model: 'x' } } }),
  ev('turn/start', T0),
  ev('assistant/message', T0 + 1, { usage: { inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1000 } }),
])
check('非 DeepSeek 的桶标为不可计价', other.turns[0].buckets[0].priceable === false)
check('非 DeepSeek 计数未计价调用', other.unpricedCalls === 1, other.unpricedCalls)

// 重放幂等：同一批事件折两遍结果一致（投影回放/checkpoint 恢复都依赖这条）
check('重放幂等', JSON.stringify(fold(script)) === JSON.stringify(fold(script)))

// JSON 安全：状态要能进 checkpoint（undefined 会在序列化时被丢掉）
check('状态 JSON 安全', JSON.stringify(JSON.parse(JSON.stringify(state))) === JSON.stringify(state))
check('冷状态 JSON 安全', JSON.stringify(JSON.parse(JSON.stringify(initState()))) === JSON.stringify(initState()))

// 明细裁剪
const many = [deepseekHeader]
for (let i = 0; i < MAX_RETAINED_TURNS + 5; i += 1) {
  many.push(ev('turn/start', T0 + i * 1000))
  many.push(ev('assistant/message', T0 + i * 1000 + 1, { usage: { inputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0, outputTokens: 0 } }))
}
const long = fold(many)
check(`明细裁剪到 ${MAX_RETAINED_TURNS} 轮`, long.turns.length === MAX_RETAINED_TURNS, long.turns.length)
check('裁剪后保留的是最新的轮', long.turns[long.turns.length - 1].index === MAX_RETAINED_TURNS + 5)

// ---------------------------------------------------------------- 形状校验器（lib/shape.js）

// 校验器是本仓库自带的（不再依赖 zod），所以能在这里直接测——这是换成手写校验器的一个额外好处：
// 投影 schema 的行为第一次变得可自测。
const goodState = sessionCostStateSchema.parse(JSON.parse(JSON.stringify(state)))
check('状态过 stateSchema', goodState.turns.length === 2)
check('视图过 viewSchema', sessionCostViewSchema.parse(viewOf(goodState)).turns.length === 2)
check('冷状态过 stateSchema', sessionCostStateSchema.parse(initState()).turns.length === 0)

check('未声明的字段被丢弃（与 zod 的 object 默认行为一致）', (() => {
  const parsed = sessionCostStateSchema.parse({ ...state, 多余的字段: 1, turns: state.turns.map((turn) => ({ ...turn, 也不该留: true })) })
  return !Object.hasOwn(parsed, '多余的字段') && !Object.hasOwn(parsed.turns[0], '也不该留')
})())

check('类型不符被拒且给出路径', (() => {
  try {
    sessionCostStateSchema.parse({ ...state, turns: [{ ...state.turns[0], index: '一' }] })
    return false
  } catch (error) {
    return error.message.startsWith('turns[0].index: expected number, got string')
  }
})())

check('缺失字段被拒', (() => {
  try {
    sessionCostStateSchema.parse({ provider: 'x', model: 'y', turnsStarted: 0, unpricedCalls: 0 })
    return false
  } catch (error) {
    return error.message.includes('turns: expected array, got undefined')
  }
})())

check('NaN / Infinity 被拒（刻意比 zod 更严）', (() => {
  const bad = { ...state, turnsStarted: Number.NaN }
  try {
    sessionCostStateSchema.parse(bad)
    return false
  } catch (error) {
    // 报错要能一眼看出是 NaN，而不是自相矛盾的 "expected number, got number"
    return error.message === 'turnsStarted: expected number, got NaN'
  }
})())

check('未知的价目行被拒（枚举生效）', (() => {
  const bad = { ...state, turns: [{ ...state.turns[0], buckets: [{ ...state.turns[0].buckets[0], row: 'v4' }] }] }
  try {
    sessionCostStateSchema.parse(bad)
    return false
  } catch (error) {
    return error.message.includes('turns[0].buckets[0].row: expected one of flash/pro, got string')
  }
})())

check('null 只被 nullable 接受', (() => {
  const okTurn = { ...state.turns[1], endedAtMs: null }
  const accepted = sessionCostStateSchema.parse({ ...state, turns: [state.turns[0], okTurn] })
  if (accepted.turns[1].endedAtMs !== null) return false
  try {
    sessionCostStateSchema.parse({ ...state, turns: [{ ...state.turns[0], endedAtMs: undefined }] })
    return false
  } catch {
    return true
  }
})())

check('数组/对象本身类型不对时被拒', (() => {
  try {
    sessionCostStateSchema.parse({ ...state, turns: {} })
    return false
  } catch (error) {
    return error.message.includes('turns: expected array, got object')
  }
})())

// ---------------------------------------------------------------- 客户端文案（静态检查）

// 客户端 bundle 是 ModuleLoader 包壳，不能当 ESM import，所以这里把 client.js 当文本查。
// 两类错会让界面直接显示 `cost.xxx` 这样的裸键，必须挡住：
// 1. 中英词典键集合不一致；2. 代码里 t('...') 用到的键在词典里不存在。
const clientSource = readFileSync(path.join(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8')

/**
 * 取出 client.js 里某个词典对象的源码块（从 `const <name> = {` 到缩进 4 的收尾大括号）。
 * @param {string} name - 词典变量名（zh / en）。
 * @returns {string} 源码块。
 */
function dictBlock(name) {
  const start = clientSource.indexOf(`const ${name} = {`)
  return clientSource.slice(start, clientSource.indexOf('\n    }', start))
}

const zhKeys = [...dictBlock('zh').matchAll(/'([a-zA-Z.]+)':/g)].map((match) => match[1]).sort()
const enKeys = [...dictBlock('en').matchAll(/'([a-zA-Z.]+)':/g)].map((match) => match[1]).sort()
check('中英文案键数量非空', zhKeys.length > 0 && enKeys.length > 0, [zhKeys.length, enKeys.length])
check('中英文案键集合一致', JSON.stringify(zhKeys) === JSON.stringify(enKeys), { zh: zhKeys.length, en: enKeys.length })

const usedKeys = [...new Set([...clientSource.matchAll(/\bt\('([a-zA-Z.]+)'/g)].map((match) => match[1]))].sort()
const missingKeys = usedKeys.filter((key) => !zhKeys.includes(key))
check('代码里用到的每个文案键都在词典里', missingKeys.length === 0, missingKeys)

// ---------------------------------------------------------------- 结果

if (failures.length === 0) {
  console.log(`selftest: ${passed} 项全部通过`)
  process.exit(0)
}
console.error(`selftest: ${passed} 项通过，${failures.length} 项失败`)
for (const failure of failures) console.error('  ✗ ' + failure)
process.exit(1)
