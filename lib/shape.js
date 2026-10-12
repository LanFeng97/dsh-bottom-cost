/**
 * 极小的形状校验器：只提供本插件用到的谓词，**零依赖**。
 *
 * 为什么不用 zod：本插件的 README 首推「git clone + tools/install.mjs」这条复制式安装，
 * 而复制安装不会带上依赖。zod 完整包 840 个文件 / 5.86 MB（哪怕只留 v4 ESM 运行时也有
 * 111 个文件 / 886 KB），为了 6 个形状谓词背这些体积、或让安装脚本去联网装包、或改写用户
 * profile 的 package.json，都不划算。
 *
 * 契约是鸭子类型的：`@deepseek-ai/dsh-session-projection` 注册表只调用 schema 的 `.parse`
 * （`stateSchema.parse` / `wire.viewSchema.parse` 共 6 处），因此一个带 `parse` 的对象就够。
 * 行为刻意与 zod 对齐两点（自测里锁住了）：
 * 1. **合法数据按声明整形**，未声明的字段被丢弃（zod 的 object 默认行为）；
 * 2. **非法数据抛错并给出路径**（如 `turns[0].buckets[1].peak: expected boolean, got string`）。
 *
 * 一处刻意比 zod **更严**：数字必须是有限值（`NaN` / `Infinity` 一律拒绝）。
 * 它们一旦混进 token 或金额，会静默污染累计值，宁可当场抛错。
 *
 * 各谓词的 `kind` 只用于错误信息里的"期望类型"，不参与校验逻辑。
 * @module dsh-bottom-cost/shape
 */

/**
 * 造一条带路径的校验错误。
 * @param {string} path - 出错位置（如 `turns[0].index`；根层为空串）。
 * @param {string} expected - 期望的描述。
 * @param {unknown} value - 实际收到的值。
 * @returns {Error} 错误对象。
 */
function invalid(path, expected, value) {
  // NaN / Infinity 的 typeof 也是 'number'，直接报 "got number" 会自相矛盾，所以单列出来。
  const got = value === null
    ? 'null'
    : Array.isArray(value)
      ? 'array'
      : typeof value === 'number' && !Number.isFinite(value)
        ? String(value)
        : typeof value
  return new Error(`${path === '' ? 'value' : path}: expected ${expected}, got ${got}`)
}

/**
 * 数字（必须是有限值）。
 * @returns {{kind: string, parse: (value: unknown, path: string) => number}} 谓词。
 */
export function number() {
  return {
    kind: 'number',
    parse(value, path) {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid(path, 'number', value)
      return value
    },
  }
}

/**
 * 字符串。
 * @returns {{kind: string, parse: (value: unknown, path: string) => string}} 谓词。
 */
export function string() {
  return {
    kind: 'string',
    parse(value, path) {
      if (typeof value !== 'string') throw invalid(path, 'string', value)
      return value
    },
  }
}

/**
 * 布尔。
 * @returns {{kind: string, parse: (value: unknown, path: string) => boolean}} 谓词。
 */
export function boolean() {
  return {
    kind: 'boolean',
    parse(value, path) {
      if (typeof value !== 'boolean') throw invalid(path, 'boolean', value)
      return value
    },
  }
}

/**
 * 字面量枚举。
 * @param {readonly string[]} allowed - 允许的取值。
 * @returns {{kind: string, parse: (value: unknown, path: string) => string}} 谓词。
 */
export function oneOf(allowed) {
  const set = new Set(allowed)
  return {
    kind: `one of ${allowed.join('/')}`,
    parse(value, path) {
      if (typeof value !== 'string' || !set.has(value)) throw invalid(path, `one of ${allowed.join('/')}`, value)
      return value
    },
  }
}

/**
 * 允许 `null`（但**不**允许 `undefined`：字段缺失仍算错）。
 * @param {{parse: Function}} inner - 内部谓词。
 * @returns {{kind: string, parse: Function}} 谓词。
 */
export function nullable(inner) {
  return {
    kind: `${inner.kind} or null`,
    parse(value, path) {
      return value === null ? null : inner.parse(value, path)
    },
  }
}

/**
 * 数组。
 * @param {{parse: Function}} inner - 元素谓词。
 * @returns {{kind: string, parse: (value: unknown, path: string) => unknown[]}} 谓词。
 */
export function list(inner) {
  return {
    kind: `array of ${inner.kind}`,
    parse(value, path) {
      if (!Array.isArray(value)) throw invalid(path, 'array', value)
      return value.map((item, index) => inner.parse(item, `${path}[${index}]`))
    },
  }
}

/**
 * 对象：**只保留声明的字段**（未声明的丢弃），缺失或类型不符即抛错。
 * @param {Record<string, {parse: Function}>} fields - 字段谓词表。
 * @returns {{kind: string, parse: (value: unknown, path?: string) => object}} 谓词。
 */
export function object(fields) {
  const names = Object.keys(fields)
  return {
    kind: 'object',
    parse(value, path = '') {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid(path, 'object', value)
      const source = /** @type {Record<string, unknown>} */ (value)
      const shaped = {}
      for (const name of names) {
        shaped[name] = fields[name].parse(source[name], path === '' ? name : `${path}.${name}`)
      }
      return shaped
    },
  }
}
