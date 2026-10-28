/**
 * dsh-status-anim — Host 半边（类型化参照源码）
 *
 * ⚠️ 本文件**不是构建输入**。运行产物是手写的 `lib/index.js`（见 README「开发说明」）。
 * 改行为请改 `lib/index.js`；本文件用于类型检查、IDE 跳转与阅读。
 *
 * 契约：webServer.register({ kind: 'prefix', path, handler })
 *  - 前缀匹配是 `pathname === prefix || pathname.startsWith(prefix + '/')`，
 *    所以 path 必须写 '/status-anim'（不带尾斜杠）。
 *
 * 格式策略（与 `lib/index.js` 当前行为一致）：**只接受真动图**，白名单仅
 * `.apng` / `.png` / `.webp` 三种。扩展名只是第一道筛子，真正的判定是按容器
 * **块结构遍历**找动画控制块：
 *  - PNG / APNG → 见 `acTL` 即真动图，见到 `IDAT` / `IEND` 即静态（不收）
 *  - WebP      → RIFF 块里见到 `ANIM` 或 `ANMF` 即真动图
 * 静态 PNG、静态 WebP 一律**不收**（文件名对但内容静态的会被 `isAnimatedFile` 刷掉）。
 * GIF 已下线（体积大、256 色、无 alpha 半透明）；AVIF 已从白名单移除（ISOBMFF 里
 * 「序列 vs 单帧」判定要钻 meta/ilst/seqp，成本远高于收益）。
 */

import { closeSync, openSync, readSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

export const name = 'status-anim'

export const inject = ['webServer'] as const

const ROUTE_PREFIX = '/status-anim'
const ASSET_DIR = 'status-anim'

/**
 * 只允许的图片扩展名 → MIME（与 `lib/index.js:46-50` 的 MIME 表逐项对齐）。
 *
 * 只留三种带 alpha 的格式；GIF / AVIF 已下线，不在表内即不在白名单内。
 */
const MIME: Readonly<Record<string, string>> = Object.freeze({
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
const ANIMATED_PROBE: Readonly<Record<string, 'png' | 'webp'>> = Object.freeze({
  '.png': 'png', // APNG：acTL 必须先于 IDAT
  '.apng': 'png',
  '.webp': 'webp', // 动画 WebP：ANIM（或只有 ANMF 帧）
})

/** 按需分段读：只读需要的头，靠 offset 跳过 iCCP / eXIf 这类大块。 */
type ReadAt = (offset: number, length: number) => Buffer

/**
 * 造一个「按需分段读」的读取器：只读需要的 8 字节头，靠 offset 直接跳过
 * iCCP / eXIf / sPLT 这类可长达数百 KB 的块，不再依赖固定头部缓冲。
 * 超预算或短读一律抛错，由 `isAnimatedFile` 兜成 false。
 */
function makeReader(fd: number): ReadAt {
  let used = 0
  return function readAt(offset: number, length: number): Buffer {
    if (!Number.isInteger(offset) || offset < 0 || length <= 0) throw new Error('bad read at')
    used += length
    if (used > MAX_PROBE_BYTES) throw new Error('probe budget exceeded')
    const buf = Buffer.alloc(length)
    const got = readSync(fd, buf, 0, length, offset)
    if (got !== length) throw new Error('short read')
    return buf
  }
}

/** PNG / APNG 块遍历：从 offset 8 起读 `len`(4BE) + `type`(4 ASCII)。 */
function pngIsAnimated(readAt: ReadAt): boolean {
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

/** WebP 块遍历：从 offset 12 起读 `id`(4 ASCII) + `size`(4 小端)，按 RIFF 偶数字节对齐。 */
function webpIsAnimated(readAt: ReadAt): boolean {
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
 * 按真实容器结构逐块遍历，而非在头部若干 KB 里做字节 includes：
 *  - `.png` / `.apng` → 见 `acTL` 即真，见 `IDAT` / `IEND` 即假
 *  - `.webp` → 见 `ANIM` / `ANMF` 即真
 * 任何 I/O 异常、短读、越预算一律视为不合法（返回 false，绝不抛错）。
 * 实现与 `lib/index.js:148-167` 逐行对齐。
 *
 * @param fullPath 素材绝对路径
 * @param ext 已小写化的扩展名（带点）
 */
function isAnimatedFile(fullPath: string, ext: string): boolean {
  const kind = ANIMATED_PROBE[ext]
  if (kind === undefined) return false
  let fd: number | undefined
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

function dshHome(): string {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return resolve(configured.trim())
  }
  return join(homedir(), '.dsh')
}

function assetDir(): string {
  return join(dshHome(), ASSET_DIR)
}

function isAllowedName(fileName: string): boolean {
  if (typeof fileName !== 'string' || fileName.length === 0) return false
  if (fileName.includes('/') || fileName.includes('\\')) return false
  if (fileName.startsWith('.')) return false
  return ALLOWED_EXT.has(extname(fileName).toLowerCase())
}

/**
 * 列出素材目录下的**真动图**文件名，按码点序排序。
 * 目录不存在 / 不可读 → 返回空数组，绝不抛错。
 * 两道筛子：扩展名白名单 → 内容校验（无 acTL / ANIM 的静态图不进榜单）。
 */
async function listAssets(): Promise<string[]> {
  const dir = assetDir()
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const names: string[] = []
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

function resolveAsset(rawName: string): string | undefined {
  if (!isAllowedName(rawName)) return undefined
  const root = resolve(assetDir())
  const target = resolve(join(root, rawName))
  if (target !== root && !target.startsWith(root + sep)) return undefined
  return target
}

function send(res: ServerResponse, code: number, headers: Record<string, string>, body?: string | Buffer): void {
  res.writeHead(code, { 'cache-control': 'no-store', ...headers })
  res.end(body)
}

function sendJson(res: ServerResponse, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  send(res, 200, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length) }, body)
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, { 'content-type': 'text/plain; charset=utf-8' }, 'method not allowed')
    return
  }

  let pathname: string
  try {
    pathname = new URL(req.url ?? '/', 'http://local').pathname
  } catch {
    send(res, 400, { 'content-type': 'text/plain; charset=utf-8' }, 'bad request')
    return
  }

  const rest = pathname.slice(ROUTE_PREFIX.length).replace(/^\/+/, '')

  if (rest === 'list' || rest === 'list/') {
    try {
      sendJson(res, await listAssets())
    } catch {
      sendJson(res, [])
    }
    return
  }

  if (rest === 'file' || rest === 'file/') {
    send(res, 404, { 'content-type': 'text/plain; charset=utf-8' }, 'not found')
    return
  }

  if (rest.startsWith('file/')) {
    let decoded: string
    try {
      decoded = decodeURIComponent(rest.slice('file/'.length))
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

  if (rest === '') {
    sendJson(res, { dir: assetDir(), routes: [`${ROUTE_PREFIX}/list`, `${ROUTE_PREFIX}/file/<name>`] })
    return
  }

  send(res, 404, { 'content-type': 'text/plain; charset=utf-8' }, 'not found')
}

interface Ctx {
  webServer: {
    register(route: { kind: 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void }): () => void
  }
  effect(fn: () => () => void): void
}

export function apply(ctx: Ctx): void {
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: (req, res) => {
        void handle(req, res)
      },
    }),
  )
}
