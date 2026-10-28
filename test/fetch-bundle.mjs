/**
 * 直连运行中的 GUI：带 auth cookie 抓 index.html 与所有 JS bundle，
 * 搜索 data-chat-flow / turnStatus / aria-live 的真实渲染代码；
 * 同时验证 /status-anim/list 路由是否可用。
 * 用法：node test/fetch-bundle.mjs <guiUrl>
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash, createHmac } from 'node:crypto'

const guiUrl = process.argv[2] ?? 'http://127.0.0.1:54109'
const b64u = (b) => Buffer.from(b).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
const lines = readFileSync('C:\\Users\\14023\\.dsh\\.credentials.yaml', 'utf8').split(/\r?\n/)
let sb
for (let i = 0; i < lines.length; i += 1) if (lines[i].includes('client-connection/browser-session:')) {
  for (let j = i + 1; j <= i + 8; j += 1) { const m = /^\s+secret:\s*(.+?)\s*$/.exec(lines[j] ?? ''); if (m) { sb = m[1].replace(/^['"]|['"]$/g, ''); break } }
  break
}
const secret = Buffer.from(sb, 'base64url')
const authority = new URL(guiUrl).host
const now = Date.now()
const body = b64u(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt: now, expiresAt: now + 864e5 }), 'utf8'))
const cname = `dsh-auth-${b64u(createHash('sha256').update(authority).digest())}`
const cval = `v1.${body}.${b64u(createHmac('sha256', secret).update(body).digest())}`
const cookie = `${cname}=${cval}`
const get = async (p) => {
  const res = await fetch(new URL(p, guiUrl), { headers: { cookie } })
  return { status: res.status, type: res.headers.get('content-type'), text: await res.text() }
}

const index = await get('/')
console.log('index status', index.status, 'len', index.text.length)
const scripts = [...index.text.matchAll(/(?:src|href)="([^"]+\.js[^"]*)"/g)].map((m) => m[1])
console.log('scripts:', JSON.stringify(scripts.slice(0, 12)))

const report = []
for (const s of scripts.slice(0, 12)) {
  const r = await get(s)
  const t = r.text
  const hit = { src: s, status: r.status, len: t.length, flow: -1, turnStatus: -1, ariaLive: -1 }
  for (const [k, needle] of [['flow', 'data-chat-flow'], ['turnStatus', 'turnStatus'], ['ariaLive', 'aria-live']]) {
    const i = t.indexOf(needle)
    hit[k] = i
    if (i >= 0) report.push({ src: s, needle, snippet: t.slice(Math.max(0, i - 260), i + 260) })
  }
  console.log(JSON.stringify(hit))
  writeFileSync(`C:\\Users\\14023\\myproject\\dsh-status-anim\\assets\\bundle-${s.replace(/[^a-z0-9]/gi, '_').slice(-40)}.js`, t)
}
writeFileSync('C:\\Users\\14023\\myproject\\dsh-status-anim\\assets\\bundle-hits.json', JSON.stringify(report, null, 2))
for (const r of report) console.log(`\n=== ${r.src} :: ${r.needle} ===\n${r.snippet}`)

const list = await get('/status-anim/list')
console.log('\n/status-anim/list', list.status, list.text.slice(0, 300))
const self = await get('/status-anim')
console.log('/status-anim', self.status, self.text.slice(0, 200))
