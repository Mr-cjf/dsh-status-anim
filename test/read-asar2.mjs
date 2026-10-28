/** 精确读出运行时代码里 data-chat-running 区块 + data-chat-flow 容器 + visuallyHidden 定义。 */
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
const target = all.find((e) => e.path.endsWith('dsh-client-ui-chat/lib/client.js'))
const buf = Buffer.alloc(target.size)
readSync(fd, buf, 0, target.size, baseOffset + target.offset)
const text = buf.toString('utf8')
closeSync(fd)
writeFileSync('C:\\Users\\14023\\myproject\\dsh-status-anim\\assets\\ui-chat-client.js', text)

const show = (label, idx, before, after) => {
  console.log(`\n===== ${label} @${idx} =====`)
  console.log(text.slice(Math.max(0, idx - before), idx + after))
}
const iRun = text.indexOf('data-chat-running')
show('data-chat-running JSX', iRun, 900, 2200)
// column / data-chat-flow 的 JSX
const iFlow = text.indexOf('"data-chat-flow"')
show('data-chat-flow JSX', iFlow, 900, 900)
// visuallyHidden 定义（css 或 style）
for (const n of ['visuallyHidden']) {
  let i = text.indexOf(n)
  let k = 0
  while (i >= 0 && k < 3) { show(`${n} #${k}`, i, 200, 420); i = text.indexOf(n, i + 1); k += 1 }
}
// running css
for (const n of ['runningDivider', 'running:', '.running']) {
  const i = text.indexOf(n)
  if (i >= 0) show(n, i, 260, 700)
}
