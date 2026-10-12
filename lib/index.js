/**
 * dsh-session-cost 的宿主半区。
 *
 * 两件事：
 * 1. 注册 {@link sessionCostProjection}——把会话事件折成**按轮次的 token 事实**，
 *    金额留给浏览器按当前价目书现算（所以刷新价目表 = 换一本书，整段对话自动重算）；
 * 2. 提供三条仅回环路由，让浏览器读价目书、抓官方页、采用解析结果。
 *
 * 能力边界（写给审阅者）：不读凭据、不写会话数据；唯一的出网请求是抓官方公开价目页，
 * 且只在你点"抓取"时发生；唯一的落盘是 `$DSH_HOME/dsh-session-cost/pricebook.json`。
 * 不抓取、不点击时，它既不联网也不写文件。
 */

import { sessionCostProjection } from './projection.js'
import { createPriceBookStore } from './pricebook-store.js'
import { makeApplyRoute, makePriceBookRoute, makeRefreshRoute } from './routes.js'

/** 稳定的插件名（profile 的 patch 行按它引用本包）。 */
export const name = 'dsh-session-cost'

/** 硬依赖：投影注册表用来折叠事实，webServer 用来挂价目路由。 */
export const inject = ['webServer', 'sessionProjections']

/**
 * 装配：注册投影单元 + 价目路由，并把上次采用的官方价目表载回内存。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主根上下文。
 * @returns {void}
 */
export const apply = (ctx) => {
  // register 本身就是调用方 fiber 上的一个 effect，卸载时自动反注册。
  ctx.sessionProjections.register(sessionCostProjection)

  const store = createPriceBookStore()
  const loaded = store.load()
  if (loaded.error !== undefined) {
    // 落盘文件损坏/版本不符：已回退内置表，这里只留一行日志，不打断装载。
    ctx.logger?.warn?.(`dsh-session-cost: 价目表载入失败，改用内置表：${loaded.error}`)
  }

  const disposers = [makePriceBookRoute(store), makeRefreshRoute(store), makeApplyRoute(store)]
    .map((route) => ctx.webServer.register(route))
  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // 路由 fiber 已随宿主卸载。
      }
    }
  }, 'dsh-session-cost: routes')
}
