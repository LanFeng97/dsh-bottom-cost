/**
 * 价目书仓库：内置表的兜底、抓取候选的暂存、以及落盘。
 *
 * 分两步走是刻意的（用户要求"解析结果先看再采用"）：
 *   `refresh()` 只抓取+解析+暂存候选，**不改变生效中的书**；
 *   `applyPending()` 才把候选落盘并生效。
 * 这样一次误解析绝不会静默污染所有金额，而且 `apply` 不需要从浏览器接收任何数字
 * （候选留在宿主内存里），少一条可被伪造的输入通道。
 *
 * 落盘位置：`$DSH_HOME/dsh-bottom-cost/pricebook.json`（原子写：先写临时文件再改名）。
 * 载入时逐项过校验，文件损坏或版本不符就回退内置表——一张错表的危害远大于用旧表。
 * @module dsh-bottom-cost/pricebook-store
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BUILTIN_PRICE_BOOK, OFFICIAL_PRICING_URL, describePriceChanges, parseOfficialPricingPage, validatePriceBook } from './pricebook.js'

/** 抓取官方页的超时（毫秒）：抓不到就用内置表，绝不阻塞界面。 */
const FETCH_TIMEOUT_MS = 10_000

/** 响应体大小上限（官方页约 22 KB，给足余量但挡住异常大的响应）。 */
const MAX_BODY_BYTES = 512 * 1024

/**
 * 解析 DSH 家目录：`DSH_HOME` 环境变量优先，否则 `~/.dsh`（与 dsh-home-paths 的约定一致）。
 * @returns {string} DSH 家目录绝对路径。
 */
function dshHome() {
  const raw = process.env.DSH_HOME
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim()
  return join(homedir(), '.dsh')
}

/**
 * 建一个价目书仓库。
 * @returns {object} 仓库接口。
 */
export function createPriceBookStore() {
  /** 生效中的书；载入前先用内置表，界面永远不会出现"没有价目"。 */
  let book = BUILTIN_PRICE_BOOK
  /** 已抓取但还没采用的候选。 */
  let pending

  const dir = join(dshHome(), 'dsh-bottom-cost')
  const file = join(dir, 'pricebook.json')

  return {
    /**
     * 从磁盘载入已采用的官方表；失败一律回退内置表。
     * @returns {{loaded: boolean, error?: string}} 载入结果（供日志与自测观察）。
     */
    load() {
      if (!existsSync(file)) return { loaded: false }
      try {
        const checked = validatePriceBook(JSON.parse(readFileSync(file, 'utf8')))
        if (!checked.ok) return { loaded: false, error: checked.error }
        book = checked.book
        return { loaded: true }
      } catch (error) {
        return { loaded: false, error: error instanceof Error ? error.message : String(error) }
      }
    },

    /** @returns {object} 当前生效的价目书。 */
    current() {
      return book
    },

    /** @returns {object|undefined} 暂存中的候选。 */
    candidate() {
      return pending
    },

    /**
     * 抓取官方中文价目页并暂存为候选（不生效）。
     * @returns {Promise<{ok: true, candidate: object, changes: string[], warnings: string[]} | {ok: false, error: string}>} 抓取结果。
     */
    async refresh() {
      let html
      try {
        const response = await fetch(OFFICIAL_PRICING_URL, {
          headers: { 'user-agent': 'dsh-bottom-cost/0.1 (+local DSH plugin)', accept: 'text/html' },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        })
        if (!response.ok) return { ok: false, error: `官方页返回 HTTP ${response.status}` }
        html = await response.text()
      } catch (error) {
        // 断网、超时、TLS 失败都走这里：报出来，什么都不改。
        return { ok: false, error: `抓取失败：${error instanceof Error ? error.message : String(error)}` }
      }
      if (html.length > MAX_BODY_BYTES) return { ok: false, error: '官方页体积异常，放弃解析' }

      const parsed = parseOfficialPricingPage(html, Date.now())
      if (!parsed.ok) return { ok: false, error: parsed.error }
      pending = parsed.book
      return {
        ok: true,
        candidate: parsed.book,
        changes: describePriceChanges(book, parsed.book),
        warnings: parsed.warnings,
      }
    },

    /**
     * 采用暂存的候选：落盘并生效。
     * @returns {{ok: true, book: object} | {ok: false, error: string}} 结果。
     */
    applyPending() {
      if (pending === undefined) return { ok: false, error: '没有待采用的价目表，请先抓取' }
      const candidate = pending
      try {
        mkdirSync(dir, { recursive: true })
        // 原子写：先落临时文件再改名，避免写到一半断电留下半张表。
        const tmp = file + '.tmp'
        writeFileSync(tmp, JSON.stringify(candidate, null, 2) + '\n')
        renameSync(tmp, file)
      } catch (error) {
        return { ok: false, error: `写入失败：${error instanceof Error ? error.message : String(error)}` }
      }
      book = candidate
      pending = undefined
      return { ok: true, book }
    },
  }
}
