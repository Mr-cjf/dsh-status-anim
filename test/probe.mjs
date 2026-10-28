/**
 * 离线探针：不启动 dsh，直接把 host 半边的 handler 挂到一个裸 http server 上，
 * 验证 list / file / 目录穿越 / 404 / 405 与响应头。
 * 用法：node test/probe.mjs
 */
import { createServer } from 'node:http'
import * as plugin from '../lib/index.js'

let disposed = false
const ctx = {
  webServer: {
    register(route) {
      if (route.kind !== 'prefix') throw new Error(`unexpected kind ${route.kind}`)
      serverRoutes.push(route)
      return () => {
        disposed = true
        const i = serverRoutes.indexOf(route)
        if (i >= 0) serverRoutes.splice(i, 1)
      }
    },
  },
  effect(fn) {
    effects.push(fn())
  },
}

const serverRoutes = []
const effects = []

plugin.apply(ctx)

const server = createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://x').pathname
  const route = serverRoutes.find((r) => pathname === r.path || pathname.startsWith(`${r.path}/`)) ?? null
  if (route === null) {
    res.writeHead(404)
    res.end('no route')
    return
  }
  route.handler(req, res)
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const base = `http://127.0.0.1:${port}`

const out = []
const check = (label, ok, detail) => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
}

try {
  // 1) list
  let res = await fetch(`${base}/status-anim/list`)
  const listBody = await res.text()
  check('GET /status-anim/list → 200 JSON', res.status === 200 && Array.isArray(JSON.parse(listBody)), `body=${listBody}`)
  check('list 带 no-store', res.headers.get('cache-control') === 'no-store', `cc=${res.headers.get('cache-control')}`)

  const names = JSON.parse(listBody)

  // 2) file
  if (names.length > 0) {
    const name = names[0]
    res = await fetch(`${base}/status-anim/file/${encodeURIComponent(name)}`)
    const buf = Buffer.from(await res.arrayBuffer())
    check(
      `GET /status-anim/file/${name} → 200 图片`,
      res.status === 200 && buf.length > 0,
      `content-type=${res.headers.get('content-type')} bytes=${buf.length}`,
    )
    check('file 带 no-store', res.headers.get('cache-control') === 'no-store', `cc=${res.headers.get('cache-control')}`)

    // HEAD
    res = await fetch(`${base}/status-anim/file/${encodeURIComponent(name)}`, { method: 'HEAD' })
    check('HEAD /status-anim/file → 200', res.status === 200, `status=${res.status}`)
  } else {
    out.push('SKIP  file 用例（素材目录为空）')
  }

  // 3) 目录穿越
  for (const evil of ['..%2F..%2Fpackage.json', '..%2F..%2F.dsh%2Fcredentials.yaml', '%2e%2e%2fsecret.gif']) {
    res = await fetch(`${base}/status-anim/file/${evil}`)
    check(`穿越防护 ${evil} → 4xx`, res.status >= 400 && res.status < 500, `status=${res.status}`)
  }

  // 4) 不存在的名字 / 非白名单扩展名
  res = await fetch(`${base}/status-anim/file/nope.gif`)
  check('不存在的图 → 404', res.status === 404, `status=${res.status}`)
  res = await fetch(`${base}/status-anim/file/evil.txt`)
  check('非白名单扩展名 → 404', res.status === 404, `status=${res.status}`)

  // 5) 方法
  res = await fetch(`${base}/status-anim/list`, { method: 'POST' })
  check('POST /status-anim/list → 405', res.status === 405, `status=${res.status}`)

  // 6) 自述
  res = await fetch(`${base}/status-anim`)
  const selfBody = await res.text()
  check('GET /status-anim → 自述 JSON', res.status === 200 && JSON.parse(selfBody).dir !== undefined, `body=${selfBody}`)

  // 7) 断开后不再命中
  effects.forEach((fn) => fn())
  check('ctx.effect 清理后路由已注销', disposed && serverRoutes.length === 0, `routes=${serverRoutes.length}`)
} finally {
  await new Promise((r) => server.close(r))
}

console.log(out.join('\n'))
const failed = out.filter((line) => line.startsWith('FAIL')).length
console.log(`\n${out.length - failed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1
