/**
 * dsh-status-anim — Host 半边（类型化参照源码）
 *
 * ⚠️ 本文件**不是构建输入**。运行产物是手写的 `lib/index.js`（见 README「开发说明」）。
 * 改行为请改 `lib/index.js`；本文件用于类型检查、IDE 跳转与阅读。
 *
 * 契约：webServer.register({ kind: 'prefix', path, handler })
 *  - 前缀匹配是 `pathname === prefix || pathname.startsWith(prefix + '/')`，
 *    所以 path 必须写 '/status-anim'（不带尾斜杠）。
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

export const name = 'status-anim'

export const inject = ['webServer'] as const

const ROUTE_PREFIX = '/status-anim'
const ASSET_DIR = 'status-anim'

const MIME: Readonly<Record<string, string>> = Object.freeze({
  '.gif': 'image/gif',
  '.apng': 'image/apng',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
})

const ALLOWED_EXT = new Set(Object.keys(MIME))

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

async function listAssets(): Promise<string[]> {
  let entries
  try {
    entries = await readdir(assetDir(), { withFileTypes: true })
  } catch {
    return []
  }
  const names: string[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!isAllowedName(entry.name)) continue
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
