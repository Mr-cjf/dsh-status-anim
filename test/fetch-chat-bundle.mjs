/**
 * 抓真实 bundle：直接取 comb 里的 dsh-client-ui-chat/client.js 并搜索 data-chat-flow / turnStatus。
 * 用法：node test/fetch-chat-bundle.mjs <guiUrl>
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
  const t = await res.text()
  return { status: res.status, len: t.length, text: t }
}

// 逐条单独抓（comb 里用 %3F 编码逗号列表很脆，直接试单模块路径）
const cands = [
  '/plugins/@deepseek-ai/dsh-client-ui-chat/client.js',
  '/plugins/@deepseek-ai/dsh-client-ui-chat/client.js?rev=x',
  '/plugins/??@deepseek-ai/dsh-client-ui-chat/client.js',
]
for (const c of cands) {
  const r = await get(c)
  console.log(c, r.status, r.len)
  if (r.status === 200 && r.len > 1000) {
    writeFileSync('C:\\Users\\14023\\myproject\\dsh-status-anim\\assets\\chat-bundle.js', r.text)
    for (const needle of ['data-chat-flow', 'turnStatus', 'role:"status"', "role='status'", 'aria-live']) {
      const i = r.text.indexOf(needle)
      console.log(`  [${needle}] @${i}`)
      if (i >= 0) console.log('    ...' + r.text.slice(Math.max(0, i - 320), i + 320).replaceAll('\n', ' ') + '...')
    }
    break
  }
}
