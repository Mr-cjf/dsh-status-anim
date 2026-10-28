/**
 * dsh-status-anim — Host 半边
 *
 * 职责：把 `<DSH_HOME>/status-anim/` 目录下的用户自选动图，以只读 HTTP 前缀
 * `/status-anim/` 暴露给 Web GUI 的 client 半边。
 *
 * 契约（对照 DSH 0.2.1-rc.3 实测）：
 *  - 服务名 `webServer`，注册 API `register({ kind: 'prefix', path, handler })`
 *    （dsh-host-webserver/lib/index.js:326）。返回值即 disposer。
 *  - 前缀匹配规则是 `pathname === prefix || pathname.startsWith(prefix + '/')`
 *    （dsh-host-webserver/lib/index.js:499-503）。因此 path 必须写 `/status-anim`
 *    **不带尾斜杠**，否则 `/status-anim/list` 不会命中。
 *  - `/plugins` 前缀已被 dsh-client-modules 占用，故本插件用 `/status-anim`。
 *
 * 安全性：resolve + startsWith 目录穿越防护（同 dsh-host-frontend-static/lib/index.js:49-75）；
 * 扩展名白名单；响应头 Cache-Control: no-store（换图零刷新延迟）。
 */

import { closeSync, openSync, readSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'

/** Loader 行 id 与插件短名。 */
export const name = 'status-anim'

/** 唯一依赖：宿主 HTTP 载体服务。 */
export const inject = ['webServer']

/** URL 前缀（不带尾斜杠，见文件头注释）。 */
const ROUTE_PREFIX = '/status-anim'

/** 素材目录名（相对 DSH home）。 */
const ASSET_DIR = 'status-anim'

/**
 * 只允许的图片扩展名 → MIME。
 *
 * 策略：**只接受带 alpha 的真动图**。GIF 已下线（体积大、256 色、无 alpha 半透明），
 * 静态 PNG 也不收 —— 扩展名只是第一道筛子，真正的判定在 `isAnimatedFile()`
 * （读文件头找 acTL / ANIM 块）。
 */
const MIME = Object.freeze({
  '.apng': 'image/apng',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
})

const ALLOWED_EXT = new Set(Object.keys(MIME))

/** 校验动图时只读文件头这么多字节：acTL / ANIM 都出现在第一屏数据之前。 */
const HEADER_PROBE_BYTES = 4096

/** 需要按「块名」深查的扩展名（真动图才放行）。 */
const ANIMATED_PROBE = Object.freeze({
  '.png': 'acTL', // APNG animation control chunk，必须位于 IDAT 之前
  '.apng': 'acTL',
  '.webp': 'ANIM', // animated WebP 的 ANIM chunk（配合 ANMF 帧）
})

/** 不深查、直接放行的扩展名（avif 序列/单帧都不拦）。 */
const PROBE_SKIP = new Set(['.avif'])

/**
 * 运行时校验：这个文件是不是**真动图**（不是光看扩展名）。
 *
 * 只看文件头 4KB，扫 ASCII 块名：
 *  - `.png` / `.apng` → 必须含 `acTL`（静态 PNG 没有 → 排除）
 *  - `.webp` → 必须含 `ANIM`（静态 WebP 只有 VP8/VP8L/VP8X → 排除）
 *  - `.avif` → 直接放行
 * 任何读写异常一律视为不合法（返回 false，绝不抛错）。
 * @param {string} fullPath 素材绝对路径
 * @param {string} ext 已小写化的扩展名（带点）
 * @returns {boolean}
 */
function isAnimatedFile(fullPath, ext) {
  if (PROBE_SKIP.has(ext)) return true
  const marker = ANIMATED_PROBE[ext]
  if (marker === undefined) return false
  let fd
  try {
    fd = openSync(fullPath, 'r')
    const buf = Buffer.alloc(HEADER_PROBE_BYTES)
    const read = readSync(fd, buf, 0, HEADER_PROBE_BYTES, 0)
    if (read <= 0) return false
    return buf.subarray(0, read).includes(Buffer.from(marker, 'latin1'))
  } catch {
    return false
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // ignore
      }
    }
  }
}

/**
 * 解析 DSH home：优先 `DSH_HOME`，否则 `~/.dsh`。
 * 语义等价于 @deepseek-ai/dsh-home-paths 的 `resolveDshHome()`
 * （dsh-home-paths/lib/index.js:109-110），但零依赖、不引入 top-level await。
 * @returns {string} 绝对路径
 */
function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return resolve(configured.trim())
  }
  return join(homedir(), '.dsh')
}

/** @returns {string} 素材目录绝对路径 */
function assetDir() {
  return join(dshHome(), ASSET_DIR)
}

/**
 * 该文件是否是允许的图片名（防止把任意文件当素材列出）。
 * @param {string} fileName
 */
function isAllowedName(fileName) {
  if (typeof fileName !== 'string' || fileName.length === 0) return false
  if (fileName.includes('/') || fileName.includes('\\')) return false
  if (fileName.startsWith('.')) return false
  return ALLOWED_EXT.has(extname(fileName).toLowerCase())
}

/**
 * 列出素材目录下的图片文件名，按名字排序（locale 无关的码点序）。
 * 目录不存在 / 不可读 → 返回空数组，绝不抛错。
 * @returns {Promise<string[]>}
 */
async function listAssets() {
  const dir = assetDir()
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const names = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!isAllowedName(entry.name)) continue
    // 第二道筛子：内容校验，静态图（无 acTL / ANIM）不进榜单。
    if (!isAnimatedFile(join(dir, entry.name), extname(entry.name).toLowerCase())) continue
    names.push(entry.name)
  }
  names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return names
}

/**
 * 把请求路径里的名字解析成素材目录内的绝对路径，越界即拒绝。
 * @param {string} rawName 已 decodeURIComponent 的文件名
 * @returns {string | undefined} 绝对路径；非法则 undefined
 */
function resolveAsset(rawName) {
  if (!isAllowedName(rawName)) return undefined
  const root = resolve(assetDir())
  const target = resolve(join(root, rawName))
  if (target !== root && !target.startsWith(root + sep)) return undefined
  return target
}

/** @param {import('node:http').ServerResponse} res @param {number} code @param {Record<string,string>} headers @param {string|Buffer} [body] */
function send(res, code, headers, body) {
  res.writeHead(code, { 'cache-control': 'no-store', ...headers })
  res.end(body)
}

/** JSON 响应（同样零缓存，list 随文件增删即时变化）。 */
function sendJson(res, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  send(res, 200, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length) }, body)
}

/**
 * 处理 `/status-anim/*` 的 GET/HEAD 请求。
 * 任何内部异常都被吞掉并降级为 404/500，避免影响宿主 webServer 的回退链。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
async function handle(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, { 'content-type': 'text/plain; charset=utf-8' }, 'method not allowed')
    return
  }

  // 只取 pathname，忽略 query（?v=... 之类的破缓存参数）。
  let pathname
  try {
    pathname = new URL(req.url ?? '/', 'http://local').pathname
  } catch {
    send(res, 400, { 'content-type': 'text/plain; charset=utf-8' }, 'bad request')
    return
  }

  const rest = pathname.slice(ROUTE_PREFIX.length).replace(/^\/+/, '')

  // /status-anim/list → JSON 数组
  if (rest === 'list' || rest === 'list/') {
    try {
      sendJson(res, await listAssets())
    } catch {
      sendJson(res, [])
    }
    return
  }

  // /status-anim/file/<name> → 图片本体
  if (rest === 'file' || rest === 'file/') {
    send(res, 404, { 'content-type': 'text/plain; charset=utf-8' }, 'not found')
    return
  }
  if (rest.startsWith('file/')) {
    const raw = rest.slice('file/'.length)
    let decoded
    try {
      decoded = decodeURIComponent(raw)
    } catch {
      send(res, 400, { 'content-type': 'text/plain; charset=utf-8' }, 'bad encoding')
      return
    }
    const target = resolveAsset(decoded)
    if (target === undefined) {
      send(res, 404, { 'content-type': 'text/plain; charset=utf-8' }, 'not found')
      return
    }
    try {
      const info = await stat(target)
      if (!info.isFile()) {
        send(res, 404, { 'content-type': 'text/plain; charset=utf-8' }, 'not found')
        return
      }
      const body = await readFile(target)
      send(
        res,
        200,
        {
          'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
          'content-length': String(body.length),
        },
        req.method === 'HEAD' ? undefined : body,
      )
    } catch {
      send(res, 404, { 'content-type': 'text/plain; charset=utf-8' }, 'not found')
    }
    return
  }

  // /status-anim/ 自述：便于人工排查素材目录位置。
  if (rest === '') {
    sendJson(res, { dir: assetDir(), routes: [`${ROUTE_PREFIX}/list`, `${ROUTE_PREFIX}/file/<name>`] })
    return
  }

  send(res, 404, { 'content-type': 'text/plain; charset=utf-8' }, 'not found')
}

/**
 * 插件入口。
 * @param {any} ctx cordis 插件上下文（已注入 webServer）
 */
export function apply(ctx) {
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: (req, res) => handle(req, res),
    }),
  )
}
