/** 直接解析 Electron asar，读出运行时真正加载的 dsh-client-ui-chat client.js，搜 data-chat-flow / aria-live。 */
import { openSync, readSync, closeSync, writeFileSync } from 'node:fs'

const ASAR = 'C:\\Users\\14023\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar'
const fd = openSync(ASAR, 'r')
const head = Buffer.alloc(16)
readSync(fd, head, 0, 16, 0)
const headerSize = head.readUInt32LE(12)
const hb = Buffer.alloc(headerSize)
readSync(fd, hb, 0, headerSize, 16)
const json = JSON.parse(hb.toString('utf8').replace(/\0+$/u, ''))
const baseOffset = 16 + headerSize

function walk(node, path, out) {
  for (const [name, v] of Object.entries(node.files ?? {})) {
    const p = path === '' ? name : `${path}/${name}`
    if (v.files) walk(v, p, out)
    else if (v.offset !== undefined) out.push({ path: p, offset: Number(v.offset), size: v.size })
  }
  return out
}
const all = walk(json, '', [])
console.log('entries:', all.length)
const targets = all.filter((e) => /ui-chat/.test(e.path) && e.path.endsWith('.js'))
console.log('ui-chat js:', JSON.stringify(targets.map((t) => `${t.path} (${t.size})`).slice(0, 40), null, 1))
const out = []
for (const t of targets) {
  const buf = Buffer.alloc(Math.min(t.size, 8 * 1024 * 1024))
  readSync(fd, buf, 0, buf.length, baseOffset + t.offset)
  const text = buf.toString('utf8')
  const hits = {}
  for (const n of ['data-chat-flow', 'turnStatus', 'aria-live', 'role:"status"', '深度求索中']) {
    const i = text.indexOf(n)
    hits[n] = i
    if (i >= 0) out.push({ path: t.path, needle: n, snippet: text.slice(Math.max(0, i - 300), i + 320) })
  }
  console.log(t.path, JSON.stringify(hits))
}
closeSync(fd)
writeFileSync('C:\\Users\\14023\\myproject\\dsh-status-anim\\assets\\asar-hits.json', JSON.stringify(out, null, 2))
for (const r of out) console.log(`\n=== ${r.path} :: ${r.needle} ===\n${r.snippet}\n`)
