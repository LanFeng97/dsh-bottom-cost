/**
 * schema 校验工具：确认「投影状态 ↔ 视图 ↔ schema」三者一致，且**装上的那份副本能加载**。
 *
 * 为什么要单独一个工具（`selftest` 现在已能直接测校验器）：`selftest` 测的是**源码**，
 * 这个工具测的是 **profile 里实际装着的那份**——安装脚本复制了哪些文件、裸导入能否解析、
 * `viewOf()` 与视图 schema 是否还逐字段一致，只有对着已安装的副本来跑才算数。
 * 这条缝在开发中真的挂过一次（视图少了两个时间字段，而 schema 仍要求它们），所以它有自己的守卫。
 *
 * 用法：
 *   node tools/schema-check.mjs [profileName]      # 默认 desktop
 * 没装到 profile 时以非零码退出并提示先跑 install.mjs。
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const profileName = process.argv[2] ?? 'desktop'
const DSH_HOME = process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? '', '.dsh')
const installed = path.join(DSH_HOME, 'profiles', profileName, 'node_modules', 'dsh-session-cost')

if (!existsSync(installed)) {
  console.error(`找不到已安装的副本：${installed}\n先跑：node tools/install.mjs ${profileName}`)
  process.exit(1)
}

const base = 'file:///' + installed.replace(/\\/g, '/') + '/lib/'

const failures = []
/**
 * 断言。
 * @param {string} name - 用例名。
 * @param {boolean} ok - 是否通过。
 * @returns {void}
 */
function check(name, ok) {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failures.push(name)
}

const main = await import(base + 'index.js')
check(`主入口可加载（name=${main.name}, inject=${JSON.stringify(main.inject)}）`, main.name === 'dsh-session-cost' && typeof main.apply === 'function')

const fold = await import(base + 'fold.js')
const { sessionCostProjection } = await import(base + 'projection.js')
check(`投影单元形状（key=${sessionCostProjection.key}, stateVersion=${sessionCostProjection.stateVersion}）`, sessionCostProjection.key === 'sessionCost' && sessionCostProjection.stateVersion === 2)

// 折一段覆盖各分支的事件：跨峰谷的一轮、进行中的一轮、以及不可计价的 provider。
const off = Date.parse('2026-10-14T13:00:00+08:00')
const peak = Date.parse('2026-10-14T15:00:00+08:00')
const usageEvent = (atMs, cacheRead) => ({
  type: 'assistant/message',
  time: atMs,
  data: { usage: { inputTokens: 1000, cacheReadTokens: cacheRead, cacheWriteTokens: 0, outputTokens: 1000, reasoningTokens: 0 } },
})

let state = sessionCostProjection.init()
for (const event of [
  { type: 'request/header', time: off, data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } } },
  { type: 'turn/start', time: off, data: {} },
  usageEvent(off + 1000, 1_000_000),
  usageEvent(peak, 1_000_000),
  { type: 'turn/end', time: peak + 1000, data: {} },
  { type: 'request/header', time: peak + 2000, data: { header: { config: { provider: 'openrouter', model: 'x' } } } },
  { type: 'turn/start', time: peak + 2000, data: {} },
  usageEvent(peak + 3000, 0),
]) {
  state = sessionCostProjection.apply(state, event)
}

const parsedState = sessionCostProjection.stateSchema.parse(JSON.parse(JSON.stringify(state)))
check('状态过 stateSchema（含结构化克隆往返）', parsedState.turns.length === 2)
check('状态保留了轮次时间事实', typeof parsedState.turns[0].startedAtMs === 'number' && parsedState.turns[0].endedAtMs !== undefined)

const view = sessionCostProjection.wire.view(parsedState)
const parsedView = sessionCostProjection.wire.viewSchema.parse(view)
check('视图过 viewSchema（这一条曾经挂过：视图少了时间字段而 schema 仍要求）', parsedView.turns.length === 2)
check('跨峰谷的一轮折出两个桶', parsedView.turns[0].buckets.length === 2)
check('不可计价的桶标为 priceable=false', parsedView.turns[1].buckets[0].priceable === false)
check('视图与状态都不含金额字段', !JSON.stringify(parsedView).includes('"cost"') && !JSON.stringify(parsedState).includes('"cost"'))

const cold = sessionCostProjection.stateSchema.parse(sessionCostProjection.init())
check('冷状态过 stateSchema', cold.turns.length === 0 && cold.totals === undefined)

// 时区/时钟无关：视图只带事实（row/peak），所以换台机器算出的钱也一样。
check('桶里带的是行键与峰谷事实（不是金额）', typeof parsedView.turns[0].buckets[0].row === 'string' && typeof parsedView.turns[0].buckets[0].peak === 'boolean')

const pricebook = await import(base + 'pricebook.js')
check('价目书内置表过校验', pricebook.validatePriceBook(pricebook.BUILTIN_PRICE_BOOK).ok === true)

if (failures.length === 0) {
  console.log(`\nschema-check: ${profileName} profile 里的副本全部通过`)
  process.exit(0)
}
console.error(`\nschema-check: ${failures.length} 项失败`)
process.exit(1)
