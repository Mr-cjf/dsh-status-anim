/**
 * 第三轮：用真实 Input 事件通过启动门（Enter / 鼠标点击），打开一个会话，
 * 然后全量枚举页面上所有「疑似状态行」结构。
 * 用法：node test/dump-real-dom3.mjs <guiUrl> <cdpPort>
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash, createHmac } from 'node:crypto'

const guiUrl = process.argv[2] ?? 'http://127.0.0.1:54109'
const port = Number(process.argv[3] ?? 9333)
const DIR = 'C:\\Users\\14023\\myproject\\dsh-status-anim\\assets'
const b64u = (b) => Buffer.from(b).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
const lines = readFileSync('C:\\Users\\14023\\.dsh\\.credentials.yaml', 'utf8').split(/\r?\n/)
let sb
for (let i = 0; i < lines.length; i += 1) if (lines[i].includes('client-connection/browser-session:')) {
  for (let j = i + 1; i + 8; j += 1) { const m = /^\s+secret:\s*(.+?)\s*$/.exec(lines[j] ?? ''); if (m) { sb = m[1].replace(/^['"]|['"]$/g, ''); break } if (j > i + 7) break }
  break
}
const secret = Buffer.from(sb, 'base64url')
const authority = new URL(guiUrl).host
const now = Date.now()
const body = b64u(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt: now, expiresAt: now + 864e5 }), 'utf8'))
const cname = `dsh-auth-${b64u(createHash('sha256').update(authority).digest())}`
const cval = `v1.${body}.${b64u(createHmac('sha256', secret).update(body).digest())}`

const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
const ws = new WebSocket(t.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }) })
let seq = 0; const pend = new Map()
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); const w = pend.get(m.id); if (w) { pend.delete(m.id); m.error ? w.reject(new Error(JSON.stringify(m.error))) : w.resolve(m.result) } })
const send = (m, p = {}) => new Promise((res, rej) => { const id = ++seq; pend.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method: m, params: p })) })
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 600)); return r.result.value }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Network.setCookie', { name: cname, value: cval, url: guiUrl, path: '/', httpOnly: true, sameSite: 'Strict' })
await send('Page.navigate', { url: guiUrl })
await send('Page.bringToFront')
await sleep(10000)

// 用真实键盘 Enter 敲过一次启动门
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
await sleep(1200)
// 若无反应，按坐标真点 GRANT ACCESS 按钮
const box = await ev(`(function(){var b=Array.from(document.querySelectorAll('button')).filter(function(x){return /授予访问权限|GRANT ACCESS/i.test(x.textContent||'')})[0];if(!b)return null;var r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
if (box) {
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
}
await sleep(3500)
const out = {}
out.afterGate = await ev(`({dsu: document.querySelectorAll('.dsu-root').length, live: document.querySelectorAll('[aria-live]').length, status: document.querySelectorAll('[role="status"]').length})`)

// 打开会话：点侧栏里带时间的会话条目
out.open = await ev(`(function(){
  var items=Array.from(document.querySelectorAll('a,button,div[role="button"],li'));
  var c=items.filter(function(e){var t=(e.textContent||'').trim();var r=e.getBoundingClientRect();
    return r.height>14&&r.width>80&&r.x<400&&r.y>200&&/dsh|插件|PowerShell|配置|搜索|CoHub/i.test(t)&&t.length<70});
  if(!c.length) return {none:true};
  c[c.length-1].click();
  return {n:c.length, clicked:(c[c.length-1].textContent||'').trim().slice(0,60)};
})()`)
await sleep(5000)

out.state = await ev(`({live: document.querySelectorAll('[aria-live]').length, status: document.querySelectorAll('[role="status"]').length, tail:(document.body.innerText||'').slice(-400)})`)
const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(`${DIR}\\real-dom3-screenshot.png`, Buffer.from(shot.data, 'base64'))
ws.close()
writeFileSync(`${DIR}\\real-dom3.json`, JSON.stringify(out, null, 2))
console.log(JSON.stringify(out, null, 2).slice(0, 4000))
