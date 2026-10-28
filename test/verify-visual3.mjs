/** 对照实验：boot 遮罩是否长期存在？移除遮罩后动画是否可见/在动？ */
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
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pend.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params })) })
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (n, clip) => { const p = { format: 'png' }; if (clip) p.clip = clip; const s = await send('Page.captureScreenshot', p); writeFileSync(`${DIR}\\${n}`, Buffer.from(s.data, 'base64')); return n }
const out = { bootTrail: [] }

await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Network.setCookie', { name: cname, value: cval, url: guiUrl, path: '/', httpOnly: true, sameSite: 'Strict' })
await send('Page.navigate', { url: guiUrl })

for (let i = 0; i < 14; i += 1) {
  await sleep(5000)
  const s = await ev(`(function(){
    var dsu = document.querySelector('.dsu-root');
    var cs = dsu === null ? null : getComputedStyle(dsu);
    return { t: Math.round(performance.now()/1000), dsu: dsu !== null,
      dsuZ: cs && cs.zIndex, dsuOp: cs && cs.opacity, dsuVis: cs && cs.visibility,
      dsuDisplay: cs && cs.display,
      step: (document.body.innerText.match(/\\[\\s*(\\d+)\\s*\\/\\s*06\\s*\\]/) || [0])[0] || null,
      composer: !!document.querySelector('textarea, [contenteditable="true"]') };
  })()`)
  out.bootTrail.push(s)
  if (s.dsu === false && s.composer === true) break
}
out.dsuGoneBeforeRemove = out.bootTrail[out.bootTrail.length - 1].dsu === false

// 对照：强制移除遮罩（仅浏览器内，允许）
out.removed = await ev(`(function(){var n=document.querySelectorAll('.dsu-root').length;document.querySelectorAll('.dsu-root').forEach(function(e){e.remove()});return n})()`)
await sleep(600)

out.visible = await ev(`(async function(){
  var flow = document.createElement('div'); flow.setAttribute('data-chat-flow','1'); flow.setAttribute('id','sa-free-flow');
  flow.style.cssText='position:fixed;left:40px;top:300px;z-index:2147482000;background:#101010;color:#eee;padding:16px 22px;border-radius:10px;font:14px/1.6 system-ui';
  var row = document.createElement('div'); row.setAttribute('role','status'); row.setAttribute('aria-live','polite'); row.setAttribute('id','sa-free-row');
  row.textContent='Deep diving...'; flow.appendChild(row); document.body.appendChild(flow);
  await new Promise(function(r){setTimeout(r,3000)});
  var img=row.querySelector('img[data-status-anim="1"]');
  if(img===null) return {found:false};
  if(typeof img.decode==='function'){try{await img.decode()}catch(e){}}
  var r=img.getBoundingClientRect();
  var hit=document.elementFromPoint(r.x+r.width/2, r.y+r.height/2);
  var c=document.createElement('canvas'); c.width=72; c.height=72; var ctx=c.getContext('2d');
  function snap(){ ctx.clearRect(0,0,72,72); ctx.drawImage(img,0,0,72,72); return Array.from(ctx.getImageData(0,0,72,72).data) }
  var f0=snap(); await new Promise(function(rr){setTimeout(rr,200)}); var f1=snap();
  await new Promise(function(rr){setTimeout(rr,200)}); var f2=snap();
  function diff(a,b){var d=0;for(var i=0;i<a.length;i++){if(a[i]!==b[i])d++}return d}
  return {found:true, src:img.getAttribute('src'), rect:{x:r.x,y:r.y,w:r.width,h:r.height},
    hitIsImg: hit===img, hitTag: hit?hit.tagName+'.'+String(hit.className).slice(0,24):null,
    natural: img.naturalWidth+'x'+img.naturalHeight,
    diff01: diff(f0,f1), diff12: diff(f1,f2), animated: diff(f0,f1)>50 || diff(f1,f2)>50};
})()`)

const box = await ev(`(function(){var f=document.getElementById('sa-free-flow');var r=f.getBoundingClientRect();return {x:Math.max(0,r.x-12),y:Math.max(0,r.y-12),width:Math.min(innerWidth-10,r.width+24),height:Math.min(innerHeight-10,r.height+24)}})()`)
out.shotVisible = await shot('verify-6-no-overlay.png', { ...box, scale: 4 })
const whole = await shot('verify-7-final-full.png')
out.shotFinal = whole
ws.close()
writeFileSync(`${DIR}\\verify-report3.json`, JSON.stringify(out, null, 2))
console.log(JSON.stringify(out, null, 2))
