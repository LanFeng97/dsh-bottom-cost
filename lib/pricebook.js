/**
 * 价目书：内置价目表、严格校验、以及从官方中文价目页解析出的一张新表。
 *
 * 为什么需要"书"这一层：金额不再烧进投影状态（见 fold.js），而是由浏览器按**当前这本书**
 * 现算。于是"更新价目"就退化成"换一本书"，整段对话自动重算，不需要动任何历史数据。
 *
 * 关于官方来源（重要）：DeepSeek **没有**机读价目 API，只有人读的 Docusaurus 文档页
 * （`/zh-cn/quick_start/pricing` 给人民币，英文页给美元）。所以解析 HTML 是唯一途径，
 * 这也意味着它天生脆——页面改版就可能解析失败。因此这里的原则是：
 *   解析出来的东西必须逐项过校验，任何一项可疑就整份拒绝；调用方失败时回退内置表，
 *   并且**先把解析结果显示给用户确认再采用**，绝不静默替换。
 *
 * 表里只放"数字"：高峰时段与节假日规则是人写的规则而不是价格，仍留在 pricing.js /
 * holidays.js 里；解析器只额外检查官方页上那段时段描述有没有变，变了就报 warning。
 * @module dsh-bottom-cost/pricebook
 */

/** 价目书格式版本；改动 rows 的形状时 +1（落盘文件与解析结果共用）。 */
export const PRICE_BOOK_VERSION = 1

/** 官方中文价目页（给人民币）。 */
export const OFFICIAL_PRICING_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing'

/** 单价的合理上限（元/百万 tokens）；超出一律当成解析错了。 */
const MAX_ABSURD_PRICE = 1000

/**
 * 内置价目书，口径取自官方中文价目页（2026-10 抓取时逐项一致）：
 * `deepseek-flash` 命中 0.02/0.04、未命中 1/2、输出 4/8；
 * `deepseek-v4-pro` 命中 0.15/0.30、未命中 4.5/9.0、输出 13.5/27.0。
 * @type {{version: number, source: string, fetchedAtMs: number|null, sourceUrl: string|null, rows: object}}
 */
export const BUILTIN_PRICE_BOOK = {
  version: PRICE_BOOK_VERSION,
  source: 'builtin',
  fetchedAtMs: null,
  sourceUrl: null,
  rows: {
    flash: {
      cacheHit: { offPeak: 0.02, peak: 0.04 },
      inputMiss: { offPeak: 1.0, peak: 2.0 },
      output: { offPeak: 4.0, peak: 8.0 },
    },
    pro: {
      cacheHit: { offPeak: 0.15, peak: 0.3 },
      inputMiss: { offPeak: 4.5, peak: 9.0 },
      output: { offPeak: 13.5, peak: 27.0 },
    },
  },
}

/** 三个 token 桶与两个时段的固定枚举，校验时按它逐个检查。 */
const BUCKETS = ['cacheHit', 'inputMiss', 'output']
const COLUMNS = ['offPeak', 'peak']
/** 行键 → 官方页表头里出现的模型名片段（列顺序按表头动态找，不写死序号）。 */
const ROW_MODEL_MATCH = { flash: 'deepseek-flash', pro: 'deepseek-v4-pro' }

/**
 * 校验一份价目书对象（来自网络解析或落盘文件）。
 * @param {unknown} value - 待校验的值。
 * @returns {{ok: true, book: object} | {ok: false, error: string}} 校验结果。
 */
export function validatePriceBook(value) {
  if (typeof value !== 'object' || value === null) return { ok: false, error: '价目书不是对象' }
  const book = /** @type {Record<string, any>} */ (value)
  if (book.version !== PRICE_BOOK_VERSION) return { ok: false, error: `价目书版本不是 ${PRICE_BOOK_VERSION}` }
  if (book.source !== 'builtin' && book.source !== 'official') return { ok: false, error: '价目书来源不合法' }
  if (book.fetchedAtMs !== null && !Number.isFinite(book.fetchedAtMs)) return { ok: false, error: '抓取时间不合法' }
  if (typeof book.rows !== 'object' || book.rows === null) return { ok: false, error: '价目书缺少 rows' }
  for (const row of Object.keys(ROW_MODEL_MATCH)) {
    const price = book.rows[row]
    if (typeof price !== 'object' || price === null) return { ok: false, error: `缺少价目行 ${row}` }
    for (const bucket of BUCKETS) {
      for (const column of COLUMNS) {
        const amount = price[bucket]?.[column]
        if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || amount > MAX_ABSURD_PRICE) {
          return { ok: false, error: `价目 ${row}.${bucket}.${column} 不可用：${String(amount)}` }
        }
      }
    }
  }
  return { ok: true, book: book }
}

/** 把 HTML 片段里的标签与实体去掉，压成一个适合匹配的纯文本。 */
function cellText(raw) {
  return raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 去掉所有空白（含全角空格），用于标签与时段匹配（页面上「输入 （缓存命中）」中间有换行）。 */
function tight(text) {
  return text.replace(/[\s\u3000]/g, '')
}

/**
 * 判一个单元格是哪种 token 桶标签。
 * 顺序要紧：`缓存未命中` 也包含 `命中`，先判未命中。
 * @param {string} text - 已压平的单元格文本。
 * @returns {'cacheHit' | 'inputMiss' | 'output' | undefined} 桶名。
 */
function bucketOf(text) {
  const normalized = tight(text)
  if (normalized.includes('缓存未命中')) return 'inputMiss'
  if (normalized.includes('缓存命中')) return 'cacheHit'
  if (/百万tokens输出|输出tokens|tokens输出/.test(normalized)) return 'output'
  return undefined
}

/**
 * 抽取页面里所有 `<table>` 的行/单元格文本。
 * @param {string} html - 页面 HTML。
 * @returns {string[][][]} 每个表的每行的每个单元格文本。
 */
function tablesOf(html) {
  const tables = []
  for (const tableMatch of html.matchAll(/<table[\s\S]*?<\/table>/g)) {
    const rows = []
    for (const rowMatch of tableMatch[0].matchAll(/<tr[\s\S]*?<\/tr>/g)) {
      const cells = []
      for (const cellMatch of rowMatch[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)) {
        cells.push(cellText(cellMatch[1]))
      }
      if (cells.length > 0) rows.push(cells)
    }
    if (rows.length > 0) tables.push(rows)
  }
  return tables
}

/**
 * 从官方中文价目页解析出一份价目书。
 *
 * 做法（对着真实页面结构写的，见 tools/fixtures/pricing-zh.html）：
 * 1. 找到含「百万tokens输入（缓存命中）」那张表；
 * 2. 表头行给出模型列顺序，按模型名找列，不写死列号；
 * 3. 价格块用 rowspan：只有第一行带桶标签，后续行沿用上一个桶标签；
 * 4. 每行的最后 N 个单元格就是 N 个模型的单价。
 * 任何一步对不上就整份拒绝（宁可用内置表，也不要一张错表）。
 * @param {string} html - 页面 HTML。
 * @param {number} fetchedAtMs - 抓取时刻。
 * @returns {{ok: true, book: object, warnings: string[]} | {ok: false, error: string}} 解析结果。
 */
export function parseOfficialPricingPage(html, fetchedAtMs) {
  if (typeof html !== 'string' || html.length === 0) return { ok: false, error: '页面内容为空' }
  const warnings = []
  const table = tablesOf(html).find((rows) => rows.some((cells) => cells.some((cell) => tight(cell).includes('缓存命中'))))
  if (table === undefined) return { ok: false, error: '页面上找不到价目表' }

  // 表头：第一格是「模型」的那一行，其余格是模型名。
  const headerIndex = table.findIndex((cells) => tight(cells[0] ?? '') === '模型')
  if (headerIndex === -1) return { ok: false, error: '价目表缺少模型表头' }
  const modelCells = table[headerIndex].slice(1)
  const rowKeyByColumn = new Map()
  for (const row of Object.keys(ROW_MODEL_MATCH)) {
    const column = modelCells.findIndex((cell) => tight(cell).includes(ROW_MODEL_MATCH[row]))
    if (column === -1) return { ok: false, error: `表头里找不到模型 ${ROW_MODEL_MATCH[row]}` }
    rowKeyByColumn.set(column, row)
  }

  const rows = { flash: { cacheHit: {}, inputMiss: {}, output: {} }, pro: { cacheHit: {}, inputMiss: {}, output: {} } }
  let currentBucket
  let found = 0
  for (const cells of table.slice(headerIndex + 1)) {
    const label = cells.map((cell) => bucketOf(cell)).find((bucket) => bucket !== undefined)
    if (label !== undefined) currentBucket = label
    const periodCell = cells.find((cell) => ['空闲时段', '非高峰时段', '高峰时段'].includes(tight(cell)))
    if (periodCell === undefined || currentBucket === undefined) continue

    const column = tight(periodCell) === '高峰时段' ? 'peak' : 'offPeak'
    const priceCells = cells.slice(-modelCells.length)
    for (const [offset, text] of priceCells.entries()) {
      const row = rowKeyByColumn.get(offset)
      if (row === undefined) continue
      const match = tight(text).match(/([\d]+(?:\.[\d]+)?)/)
      if (match === null) return { ok: false, error: `单价解析失败：${text}` }
      const amount = Number(match[1])
      if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_ABSURD_PRICE) {
        return { ok: false, error: `单价不合理：${text}` }
      }
      rows[row][currentBucket][column] = amount
      found += 1
    }
  }

  const expected = Object.keys(ROW_MODEL_MATCH).length * BUCKETS.length * COLUMNS.length
  if (found !== expected) return { ok: false, error: `只解析到 ${found}/${expected} 个单价，页面结构可能变了` }

  // 官方口径：空闲价正好是高峰价的一半。不等就报出来，但不拒绝（万一官方改了规则）。
  for (const row of Object.keys(rows)) {
    for (const bucket of BUCKETS) {
      const { offPeak, peak } = rows[row][bucket]
      if (Math.abs(offPeak * 2 - peak) > 1e-9) {
        warnings.push(`${row}.${bucket}：空闲价 ${offPeak} 不等于高峰价 ${peak} 的一半`)
      }
    }
  }

  const book = { version: PRICE_BOOK_VERSION, source: 'official', fetchedAtMs, sourceUrl: OFFICIAL_PRICING_URL, rows }
  const checked = validatePriceBook(book)
  if (!checked.ok) return { ok: false, error: checked.error }

  // 高峰时段规则仍写死在 pricing.js 里，所以这里只做"是否被改动"的提醒。
  const windowText = html.match(/北京时间[^<]{0,120}高峰时段[^<]{0,40}/)
  if (windowText !== null && !/9:00\s*-\s*12:00/.test(windowText[0])) {
    warnings.push(`官方页描述的高峰时段与内置规则不一致：${windowText[0].trim()}`)
  }
  return { ok: true, book: checked.book, warnings }
}

/**
 * 列出候选书相对当前书改了哪些数字（给"先确认再采用"的界面用）。
 * @param {object} current - 当前生效的价目书。
 * @param {object} candidate - 候选价目书。
 * @returns {string[]} 形如 `flash 命中(高峰) 0.04 → 0.05` 的变更列表；无变化时为空数组。
 */
export function describePriceChanges(current, candidate) {
  const changes = []
  const bucketLabel = { cacheHit: '命中', inputMiss: '未命中', output: '输出' }
  const columnLabel = { offPeak: '空闲', peak: '高峰' }
  for (const row of Object.keys(ROW_MODEL_MATCH)) {
    for (const bucket of BUCKETS) {
      for (const column of COLUMNS) {
        const before = current?.rows?.[row]?.[bucket]?.[column]
        const after = candidate?.rows?.[row]?.[bucket]?.[column]
        if (before === after) continue
        changes.push(`${row} ${bucketLabel[bucket]}(${columnLabel[column]}) ${String(before)} → ${String(after)}`)
      }
    }
  }
  return changes
}
