/** 最终轮：激活标签页看 GIF 是否被 headless 后台暂停 + 定位遮挡层 + 放大尺寸对照。 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash, createHmac } from 'node:crypto'

const guiUrl = 'http://127.0.0.1:62811'
const DIR = 'C:\\Users\\14023\\myproject\\dsh-status-anim\\assets'
const b64u = (b) => Buffer.from(b).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
const lines = readFileSync('C:\\Users\\14023\\.dsh\\.credentials.yaml', 'utf8').split(/\r?\n/)
let sb
for (let i = 0; i < lines.length; i += 1) if (lines[i].includes('client-connection/browser-session:')) {
  for (let j = i + 1; j < i + 8; j += 1) { const m = /^\s+secret:\s*(.+?)\s*$/.exec(lines[j]); if (m) { sb = m[1].replace(/^['"]|['"]$/g, ''); break } }
  break
}
const secret = Buffer.from(sb, 'base64url')
const authority = new URL(guiUrl).host
const now = Date.now()
const body = b64u(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt: now, expiresAt: now + 864e5 }), 'utf8'))
const cname = `dsh-auth-${b64u(createHash('sha256').update(authority).digest())}`
const cval = `v1.${body}.${b64u(createHmac('sha256', secret).update(body).digest())}`

const t = await (await fetch('http://127.0.0.1:9333/json/new?about:blank', { method: 'PUT' })).json()
const ws = new WebSocket(t.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }) })
let seq = 0; const pend = new Map()
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); const w = pend.get(m.id); if (w) { pend.delete(m.id); m.error ? w.reject(new Error(JSON.stringify(m.error))) : w.resolve(m.result) } })
const send = (m, p = {}) => new Promise((res, rej) => { const id = ++seq; pend.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method: m, params: p })) })
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (n, clip) => { const p = { format: 'png' }; if (clip) p.clip = clip; const s = await send('Page.captureScreenshot', p); writeFileSync(`${DIR}\\${n}`, Buffer.from(s.data, 'base64')); return n }
const out = {}

await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Network.setCookie', { name: cname, value: cval, url: guiUrl, path: '/', httpOnly: true, sameSite: 'Strict' })
await send('Page.navigate', { url: guiUrl })
await send('Page.bringToFront')
await sleep(9000)

out.state = await ev(`({dsu: document.querySelectorAll('.dsu-root').length, gear: document.querySelectorAll('[data-status-anim-ui="gear"]').length, hidden: document.hidden, vis: document.visibilityState})`)
// 移除启动遮罩（浏览器内，仅本次画面）
await ev(`document.querySelectorAll('.dsu-root').forEach(function(e){e.remove()})`)
await sleep(500)

// 造状态条，尺寸放大到 64px 便于肉眼辨认
out.probe = await ev(`(async function(){
  localStorage.setItem('dsh-status-anim.size','64');
  localStorage.setItem('dsh-status-anim.picked','diving.gif');
  var flow=document.createElement('div'); flow.setAttribute('data-chat-flow','1'); flow.setAttribute('id','sa-fin-flow');
  flow.style.cssText='position:fixed;left:60px;top:520px;z-index:2147482000;background:#101010;color:#eee;padding:18px 24px;border-radius:12px;font:15px/1.7 system-ui';
  var row=document.createElement('div'); row.setAttribute('role','status'); row.setAttribute('aria-live','polite'); row.setAttribute('id','sa-fin-row');
  row.textContent='Deep diving...'; flow.appendChild(row); document.body.appendChild(flow);
  await new Promise(function(r){setTimeout(r,3200)});
  var img=row.querySelector('img[data-status-anim="1"]');
  return { found: img!==null, src: img&&img.getAttribute('src'), w: img&&img.style.width };
})()`)

// 若 localStorage 尺寸不即刻生效，用滑块面板强改；再采样 GIF
out.anim = await ev(`(async function(){
  var img=document.querySelector('#sa-fin-row img[data-status-anim="1"]');
  if(img===null) return {noImg:true};
  if(typeof img.decode==='function'){try{await img.decode()}catch(e){}}
  var c=document.createElement('canvas'); c.width=72; c.height=72; var ctx=c.getContext('2d');
  function snap(){ ctx.clearRect(0,0,72,72); ctx.drawImage(img,0,0,72,72); return Array.from(ctx.getImageData(0,0,72,72).data) }
  var f=[]; for(var k=0;k<6;k++){ f.push(snap()); await new Promise(function(r){setTimeout(r,220)}); }
  function diff(a,b){var d=0;for(var i=0;i<a.length;i++){if(a[i]!==b[i])d++}return d}
  var ds=[]; for(var k=1;k<f.length;k++) ds.push(diff(f[k-1],f[k]));
  var r=img.getBoundingClientRect();
  var hit=document.elementFromPoint(r.x+r.width/2, r.y+r.height/2);
  var chain=[]; var n=hit; while(n&&chain.length<5){chain.push(n.tagName+(n.id?'#'+n.id:'')+(typeof n.className==='string'&&n.className?'.'+n.className.slice(0,26):'')); n=n.parentElement}
  return { rect:{x:r.x,y:r.y,w:r.width,h:r.height}, natural:img.naturalWidth+'x'+img.naturalHeight,
    frameDiffs: ds, animated: ds.some(function(d){return d>50}),
    hitIsImg: hit===img, hitChain: chain, visibility: document.visibilityState };
})()`)

// 打开设置面板，肉眼可见"调尺寸"的证据
out.panel = await ev(`(function(){var g=document.querySelector('[data-status-anim-ui="gear"]'); if(g===null)return {no:true}; g.click(); var p=document.querySelector('[data-status-anim-ui="panel"]'); if(p===null)return {noPanel:true}; var sl=p.querySelector('input[type=range]'); if(sl){sl.value='64'; sl.dispatchEvent(new Event('input',{bubbles:true}))} return {open:true, z:getComputedStyle(p).zIndex} })()`)
await sleep(700)
const box = await ev(`(function(){var f=document.getElementById('sa-fin-flow');if(f===null)return null;var r=f.getBoundingClientRect();return {x:Math.max(0,r.x-14),y:Math.max(0,r.y-14),width:Math.min(innerWidth-8,r.width+28),height:Math.min(innerHeight-8,r.height+28)}})()`)
out.shotA = await shot('verify-8-64px-zoom.png', box === null ? undefined : { ...box, scale: 3 })
const gb = await ev(`(function(){var g=document.querySelector('[data-status-anim-ui="gear"]');var r=g.getBoundingClientRect();return {x:Math.max(0,r.x-60),y:Math.max(0,r.y-70),width:Math.min(innerWidth-r.x+60,180),height:Math.min(innerHeight-r.y+70,180)}})()`)
out.shotB = await shot('verify-9-gear-panel.png', { ...gb, scale: 4 })
ws.close()
writeFileSync(`${DIR}\\verify-report4.json`, JSON.stringify(out, null, 2))
console.log(JSON.stringify(out, null, 2))
