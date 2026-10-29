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

import { execFile } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Loader 行 id 与插件短名。 */
export const name = 'status-anim'

/** 唯一依赖：宿主 HTTP 载体服务。 */
export const inject = ['webServer']

/** URL 前缀（不带尾斜杠，见文件头注释）。 */
const ROUTE_PREFIX = '/status-anim'

/** 素材目录名（相对 DSH home）。 */
const ASSET_DIR = 'status-anim'

/**
 * 包根目录：本文件在 `lib/` 下，故上跳一层。
 * 用 `fileURLToPath(import.meta.url)` 而非 `__dirname`（本项目 `type: module`），
 * 范式同 dsh-boot-suite/lib/host-wallpaper.js:18,27。
 */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 包内自带默认素材目录（装完即有动画）。 */
const BUNDLED_ASSET_DIR = join(PACKAGE_ROOT, 'assets')

/**
 * 只允许的图片扩展名 → MIME。
 *
 * 策略：**只接受带 alpha 的真动图**。GIF 已下线（体积大、256 色、无 alpha 半透明），
 * 静态 PNG 也不收 —— 扩展名只是第一道筛子，真正的判定在 `isAnimatedFile()`
 * （按块结构遍历找 acTL / ANIM）。
 *
 * `.avif` 已从白名单移除：ISOBMFF 里「序列 vs 单帧」的判定要钻 meta/ilst/seqp，
 * 成本远高于收益，且用户硬需求是「静态格式一律不收」—— 宁缺勿滥。
 */
const MIME = Object.freeze({
  '.apng': 'image/apng',
  '.png': 'image/png',
  '.webp': 'image/webp',
})

const ALLOWED_EXT = new Set(Object.keys(MIME))

/** 块遍历的块数上限（防畸形文件把我们拖进死循环）。 */
const MAX_CHUNKS = 64

/** 块遍历的总读取字节上限（按每次 readAt 的请求长度累加，1 MiB）。 */
const MAX_PROBE_BYTES = 1 << 20

/** PNG 文件签名（8 字节魔数）。 */
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** 块长度字段的合理上限：超过即视为畸形。 */
const MAX_CHUNK_LEN = 0x7fffffff

/** 需要按「块结构」深查的扩展名（真动图才放行）。 */
const ANIMATED_PROBE = Object.freeze({
  '.png': 'png', // APNG：acTL 必须先于 IDAT
  '.apng': 'png',
  '.webp': 'webp', // 动画 WebP：ANIM（或只有 ANMF 帧）
})

/**
 * 造一个「按需分段读」的读取器：只读需要的 8 字节头，靠 offset 直接跳过
 * iCCP / eXIf / sPLT 这类可长达数百 KB 的块，不再依赖固定头部缓冲。
 * 超预算或短读一律抛错，由 `isAnimatedFile` 兜成 false。
 * @param {number} fd
 * @returns {(offset: number, length: number) => Buffer}
 */
function makeReader(fd) {
  let used = 0
  return function readAt(offset, length) {
    if (!Number.isInteger(offset) || offset < 0 || length <= 0) throw new Error('bad read at')
    used += length
    if (used > MAX_PROBE_BYTES) throw new Error('probe budget exceeded')
    const buf = Buffer.alloc(length)
    const got = readSync(fd, buf, 0, length, offset)
    if (got !== length) throw new Error('short read')
    return buf
  }
}

/**
 * PNG / APNG 块遍历：从 offset 8 起读 `len`(4BE) + `type`(4 ASCII)。
 * @param {(offset: number, length: number) => Buffer} readAt
 * @returns {boolean}
 */
function pngIsAnimated(readAt) {
  if (!readAt(0, 8).equals(PNG_SIG)) return false
  let offset = 8
  for (let i = 0; i < MAX_CHUNKS; i += 1) {
    const head = readAt(offset, 8)
    const len = head.readUInt32BE(0)
    if (len > MAX_CHUNK_LEN) return false
    const type = head.toString('latin1', 4, 8)
    if (type === 'acTL') return true
    // acTL 规范上必须先于 IDAT；见到 IDAT / IEND 就再也不可能出现。
    if (type === 'IDAT' || type === 'IEND') return false
    offset += 12 + len // 8 头 + len 数据 + 4 CRC
  }
  return false
}

/**
 * WebP 块遍历：从 offset 12 起读 `id`(4 ASCII) + `size`(4 **小端**)，
 * 每块按 RIFF 要求做偶数字节对齐（`size & 1` 的 padding）。
 * @param {(offset: number, length: number) => Buffer} readAt
 * @returns {boolean}
 */
function webpIsAnimated(readAt) {
  const head = readAt(0, 12)
  if (head.toString('latin1', 0, 4) !== 'RIFF') return false
  if (head.toString('latin1', 8, 12) !== 'WEBP') return false
  let offset = 12
  for (let i = 0; i < MAX_CHUNKS; i += 1) {
    const chunk = readAt(offset, 8)
    const id = chunk.toString('latin1', 0, 4)
    const size = chunk.readUInt32LE(4)
    // ANIM 是动画控制块；有的编码器只写 ANMF 帧块，同样算动图。
    if (id === 'ANIM' || id === 'ANMF') return true
    if (size > MAX_CHUNK_LEN) return false
    offset += 8 + size + (size & 1)
  }
  return false
}

/**
 * 运行时校验：这个文件是不是**真动图**（不是光看扩展名）。
 *
 * 按真实容器结构逐块遍历，而不是在头部 4KB 里做字节 includes：
 *  - `.png` / `.apng` → 从 offset 8 起走 chunk，见 `acTL` 即真，见 `IDAT`/`IEND` 即假
 *  - `.webp` → 走 RIFF chunk，见 `ANIM`/`ANMF` 即真
 * 任何 I/O 异常、短读、越预算一律视为不合法（返回 false，绝不抛错）。
 * @param {string} fullPath 素材绝对路径
 * @param {string} ext 已小写化的扩展名（带点）
 * @returns {boolean}
 */
function isAnimatedFile(fullPath, ext) {
  const kind = ANIMATED_PROBE[ext]
  if (kind === undefined) return false
  let fd
  try {
    fd = openSync(fullPath, 'r')
    const readAt = makeReader(fd)
    return kind === 'png' ? pngIsAnimated(readAt) : webpIsAnimated(readAt)
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

/** @returns {string} 包内默认素材目录绝对路径 */
function bundledAssetDir() {
  return BUNDLED_ASSET_DIR
}

/**
 * 在系统文件管理器中打开**用户素材目录**（`assetDir()`，不接受任何外部路径）。
 *
 * - 目录不存在时 explorer / open / xdg-open 会直接失败，故先 `mkdirSync(recursive)` 兜底；
 * - 一律 `execFile(cmd, [dir])` 数组参数，**绝不拼 shell 字符串** → 无命令注入面；
 * - 打开动作是 fire-and-forget：`explorer.exe` 即使在成功打开时也常返回退出码 1，
 *   所以**不看退出码**，只有 `error.code === 'ENOENT'`（解释器不存在）才算真失败。
 * @returns {Promise<{dir: string, opened: boolean}>}
 */
async function revealAssetDir() {
  const dir = assetDir()
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // 建目录失败（已存在但无写权限等）不拦打开动作，交给下面的命令自行判定。
  }
  const command =
    process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const opened = await new Promise(function (settle) {
    execFile(command, [dir], function (error) {
      if (error !== null && error.code === 'ENOENT') settle(false)
      else settle(true)
    })
  })
  return { dir: dir, opened: opened }
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
 * 扫描一个素材目录，返回通过全部校验的文件名（按码点序排序）。
 * 目录不存在 / 读取失败 / 无权限 → 静默返回空数组，绝不抛错。
 * @param {string} dir 素材目录绝对路径
 * @returns {Promise<string[]>}
 */
async function scanAssetDir(dir) {
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
 * 列出可用素材：**包内默认素材 ∪ 用户素材**，同名时用户的覆盖包内的。
 *
 * - 新用户装完即有 12 张默认动图，开箱可用；
 * - 往 `~/.dsh/status-anim/` 放图会**追加**；
 * - 放同名文件则**覆盖**默认素材（用户目录优先）；
 * - 两处都为空 → `[]`（client 显示「素材目录为空」并静默跳过）。
 * 结果按名字排序（码点序），保证 `names[i % N]` 轮换与 `stampOf` 缓存稳定。
 * @returns {Promise<string[]>}
 */
async function listAssets() {
  const [userNames, bundledNames] = await Promise.all([
    scanAssetDir(assetDir()),
    scanAssetDir(bundledAssetDir()),
  ])
  const merged = new Set(bundledNames)
  // 同名覆盖：用户目录的名字直接进集合，天然去重且用户侧生效。
  for (const name of userNames) merged.add(name)
  const names = [...merged]
  names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return names
}

/**
 * 把请求路径里的名字解析成素材目录内的绝对路径，越界即拒绝。
 * 查找顺序：**用户目录优先，找不到再落到包内 assets**。
 * 两处都做 `resolve + startsWith(root + sep)` 穿越防护。
 * @param {string} rawName 已 decodeURIComponent 的文件名
 * @returns {string | undefined} 绝对路径；非法则 undefined
 */
function resolveAsset(rawName) {
  if (!isAllowedName(rawName)) return undefined
  for (const candidateRoot of [assetDir(), bundledAssetDir()]) {
    const root = resolve(candidateRoot)
    const target = resolve(join(root, rawName))
    if (target !== root && !target.startsWith(root + sep)) continue
    try {
      if (existsSync(target)) return target
    } catch {
      // ignore
    }
  }
  return undefined
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
  // POST 仅对 /status-anim/reveal 开放（在系统文件管理器里打开素材目录）。
  // 路径硬编码 assetDir()，**不接受任何用户传入路径参数** → 攻击面只有「打开自己的素材目录」。
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    let postRest
    try {
      postRest = new URL(req.url ?? '/', 'http://local').pathname
        .slice(ROUTE_PREFIX.length)
        .replace(/^\/+/, '')
    } catch {
      postRest = ''
    }
    if (req.method === 'POST' && (postRest === 'reveal' || postRest === 'reveal/')) {
      try {
        sendJson(res, await revealAssetDir())
      } catch {
        send(res, 500, { 'content-type': 'text/plain; charset=utf-8' }, 'reveal failed')
      }
      return
    }
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

  // reveal 只接受 POST：GET 到此一律 405（避免被预取/缓存当成普通读接口）。
  if (rest === 'reveal' || rest === 'reveal/') {
    send(res, 405, { 'content-type': 'text/plain; charset=utf-8' }, 'method not allowed')
    return
  }

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

  // /status-anim/ 自述：便于人工排查素材目录位置（用户目录 + 包内默认）。
  if (rest === '') {
    sendJson(res, {
      dir: assetDir(),
      bundledDir: bundledAssetDir(),
      routes: [`${ROUTE_PREFIX}/list`, `${ROUTE_PREFIX}/file/<name>`],
    })
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
