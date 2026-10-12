/**
 * 价目表相关的三条仅回环路由。
 *
 * - `GET  /api/dsh-bottom-cost/pricebook`          读当前生效的价目书（浏览器启动时取一次）
 * - `POST /api/dsh-bottom-cost/pricebook/refresh`  抓官方页 → 解析 → 暂存候选（**不生效**）
 * - `POST /api/dsh-bottom-cost/pricebook/apply`    采用暂存的候选（落盘 + 生效）
 *
 * 三条都过 {@link isLocalRequest}：价目表虽是公开信息，但 `refresh` 是"代表本机发起网络
 * 请求"，`apply` 是"改本机状态"，都不该让局域网或跨站页面触发。
 * @module dsh-bottom-cost/routes
 */

import { isLocalRequest } from './guard.js'

/** 本插件的 API 前缀。 */
export const API_PREFIX = '/api/dsh-bottom-cost'

/**
 * 写 JSON 响应。
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {number} status - 状态码。
 * @param {unknown} body - 响应体。
 * @returns {void}
 */
function writeJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

/**
 * 统一的围栏与响应壳。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {'GET' | 'POST'} method - 该路由允许的方法。
 * @returns {boolean} 是否继续处理（false 表示已回包）。
 */
function gate(req, res, method) {
  if (!isLocalRequest(req)) {
    writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
    return false
  }
  if (req.method !== method) {
    writeJson(res, 405, { ok: false, error: `method not allowed: use ${method}` })
    return false
  }
  return true
}

/**
 * 读当前生效的价目书。
 * @param {object} store - 价目书仓库。
 * @returns {import('@deepseek-ai/dsh-host-webserver').WebRoute} 路由。
 */
export function makePriceBookRoute(store) {
  return {
    kind: 'exact',
    path: API_PREFIX + '/pricebook',
    handler: (req, res) => {
      if (!gate(req, res, 'GET')) return
      writeJson(res, 200, { ok: true, book: store.current() })
    },
  }
}

/**
 * 抓取官方页并暂存候选。
 * @param {object} store - 价目书仓库。
 * @returns {import('@deepseek-ai/dsh-host-webserver').WebRoute} 路由。
 */
export function makeRefreshRoute(store) {
  return {
    kind: 'exact',
    path: API_PREFIX + '/pricebook/refresh',
    handler: async (req, res) => {
      if (!gate(req, res, 'POST')) return
      const result = await store.refresh()
      writeJson(res, result.ok ? 200 : 502, result.ok
        ? { ok: true, candidate: result.candidate, changes: result.changes, warnings: result.warnings }
        : result)
    },
  }
}

/**
 * 采用暂存的候选。
 * @param {object} store - 价目书仓库。
 * @returns {import('@deepseek-ai/dsh-host-webserver').WebRoute} 路由。
 */
export function makeApplyRoute(store) {
  return {
    kind: 'exact',
    path: API_PREFIX + '/pricebook/apply',
    handler: (req, res) => {
      if (!gate(req, res, 'POST')) return
      const result = store.applyPending()
      writeJson(res, result.ok ? 200 : 409, result)
    },
  }
}
