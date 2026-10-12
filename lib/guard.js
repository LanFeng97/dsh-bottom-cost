/**
 * 路由信任围栏。
 *
 * 本插件的路由会暴露"本机读了什么价目表"以及"代表本机去抓一次官网"，因此和同类插件
 * 保持同一套判据：回环套接字地址 + 回环 Host 头 + 浏览器同源标记。套接字地址是权威来源，
 * `x-forwarded-for` 一律不采信——否则 DNS rebinding 页面就能借浏览器读这些数据。
 * （写法与本工作区里 dsh-skill-panel / dsh-usage 的围栏一致。）
 */

/**
 * IPv4 回环判定（127/8）。
 * @param {string} value - 形如 127.0.0.1 的地址。
 * @returns {boolean} 是否属于回环网段。
 */
function isIPv4Loopback(value) {
  const parts = value.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * 套接字远端地址是否回环（127/8、::1、IPv4-mapped）。
 * @param {string | undefined} address - `socket.remoteAddress`。
 * @returns {boolean} 是否回环。
 */
function isLoopbackAddress(address) {
  if (address === undefined) return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice(7))
  return isIPv4Loopback(normalized)
}

/**
 * 主机名是否回环（localhost、[::1]、127/8）。
 * @param {string} hostname - URL hostname。
 * @returns {boolean} 是否回环。
 */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}

/**
 * 请求是否来自本机 GUI。
 * @param {import('node:http').IncomingMessage} request - 请求。
 * @returns {boolean} 是否放行。
 */
export function isLocalRequest(request) {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}
