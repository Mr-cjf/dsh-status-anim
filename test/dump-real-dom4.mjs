/**
 * 第四轮：等待启动门动画彻底结束 → 打开「进行中」会话（或第一个历史会话）→ 枚举真实状态行结构。
 * 用法：node test/dump-real-dom4.mjs <guiUrl> <cdpPort>
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
  for (let j = i + 1; j <= i + 8; j += 1) { const m = /^\s+secret:\s*(.+?)\s*$/.exec(lines[j] ?? ''); if (m) { sb = m[1].replace(/^['"]|['"]$/g, ''); break } }
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
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
await sleep(9000)

const out = {}
out.gate = await ev(`({dsu: document.querySelectorAll('.dsu-root').length})`)

// 找会话条目：用 innerText 里的时间戳（1分钟 / 42分钟 / 6天）附近的可点元素
out.sessions = await ev(`(function(){
  var res=[];var all=document.querySelectorAll('a,button,div,li,span');
  for(var i=0;i<all.length;i++){var e=all[i];var t=(e.textContent||'').trim();
    if(t.length<10||t.length>80) continue;
    if(!/^(安装 dsh-notify-tray 插件|PowerShell 静默安装 MSI|dsh桌面版GUI工作树会话搜索|配置正确性确认|若变 -live)/.test(t)) continue;
    if(e.querySelector('*')&&e.children.length>3) continue;
    var r=e.getBoundingClientRect(); if(r.height<8) continue;
    res.push({tag:e.tagName,cls:typeof e.className==='string'?e.className.slice(0,60):'',txt:t.slice(0,40),x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)});}
  return res.slice(0,20);})()`)

// 真点第一个会话条目
const first = Array.isArray(out.sessions) && out.sessions.length > 0 ? out.sessions[0] : null
if (first) {
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: first.x + Math.min(first.w / 2, 100), y: first.y + first.h / 2, button: 'left', clickCount: 1 })
  await sleep(6000)
}

out.after = await ev(`({live: document.querySelectorAll('[aria-live]').length, status: document.querySelectorAll('[role="status"]').length, url: location.href, tail:(document.body.innerText||'').slice(-500)})`)
const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(`${DIR}\\real-dom4-screenshot.png`, Buffer.from(shot.data, 'base64'))
ws.close()
writeFileSync(`${DIR}\\real-dom4.json`, JSON.stringify(out, null, 2))
console.log(JSON.stringify(out, null, 2).slice(0, 5000))
