/**
 * 联网验证工具：确认官方价目页现在仍然抓得到、解析得出来、落盘后能读回。
 *
 * 用途：怀疑官网改版、或发布前跑一次。fixture 自测（selftest.mjs）验证的是"解析器对着
 * 当时的页面快照是对的"，这个工具验证的是"现在的页面还认得出"——两者不能互相替代。
 *
 * 用法：
 *   node tools/live-check.mjs [--home <临时目录>]
 * 会把价目表写到临时 DSH_HOME 里做落盘往返验证，跑完删掉；不碰真实 DSH_HOME。
 * 需要网络；失败时以非零码退出并打印原因。
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { BUILTIN_PRICE_BOOK, describePriceChanges } from '../lib/pricebook.js'
import { createPriceBookStore } from '../lib/pricebook-store.js'

const args = process.argv.slice(2)
const homeArg = args.indexOf('--home')
const home = homeArg === -1 ? path.join(tmpdir(), `dsh-session-cost-check-${process.pid}`) : args[homeArg + 1]
mkdirSync(home, { recursive: true })
process.env.DSH_HOME = home

let failed = false
try {
  const store = createPriceBookStore()
  console.log(`临时 DSH_HOME：${home}`)
  console.log('抓取官方中文价目页…')
  const result = await store.refresh()
  if (!result.ok) {
    console.error(`✗ 抓取/解析失败：${result.error}`)
    failed = true
  } else {
    console.log('✓ 解析成功：')
    for (const [row, price] of Object.entries(result.candidate.rows)) {
      console.log(`  ${row.padEnd(6)} 命中 ${price.cacheHit.offPeak}/${price.cacheHit.peak}  未命中 ${price.inputMiss.offPeak}/${price.inputMiss.peak}  输出 ${price.output.offPeak}/${price.output.peak}`)
    }
    const changes = describePriceChanges(BUILTIN_PRICE_BOOK, result.candidate)
    console.log(changes.length === 0 ? '✓ 与内置表一致（无需改动）' : `• 与内置表有 ${changes.length} 项差异：\n  ${changes.join('\n  ')}`)
    for (const warning of result.warnings) console.log(`• 提醒：${warning}`)

    const applied = store.applyPending()
    if (!applied.ok) {
      console.error(`✗ 落盘失败：${applied.error}`)
      failed = true
    } else {
      console.log('✓ 已落盘')
      // 落盘往返：新开一个 store 从磁盘读回来，必须与刚采用的一致。
      const reloaded = createPriceBookStore().load()
      const fresh = createPriceBookStore()
      fresh.load()
      const same = JSON.stringify(fresh.current().rows) === JSON.stringify(applied.book.rows)
      console.log(same ? '✓ 读回一致' : '✗ 读回不一致')
      if (!same) failed = true
      if (!reloaded.loaded) {
        console.error(`✗ 载入报告失败：${reloaded.error}`)
        failed = true
      }
    }
  }
} catch (error) {
  console.error(`✗ 异常：${error instanceof Error ? error.stack : String(error)}`)
  failed = true
} finally {
  // 只删自己建的临时目录。
  if (existsSync(home) && home.includes('dsh-session-cost-check-')) rmSync(home, { recursive: true, force: true })
}

process.exit(failed ? 1 : 0)
