/** 补充探针：boot 是否完成、覆盖层遮挡、GIF 帧数。 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash, createHmac } from 'node:crypto'

const guiUrl = 'http://127.0.0.1:62811'
const port = 9333
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

const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
const ws = new WebSocket(t.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }) })
let seq = 0; const pend = new Map()
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); const w = pend.get(m.id); if (w) { pend.delete(m.id); m.error ? w.reject(new Error(JSON.stringify(m.error))) : w.resolve(m.result) } })
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pend.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params })) })
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = {}

await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Network.setCookie', { name: cname, value: cval, url: guiUrl, path: '/', httpOnly: true, sameSite: 'Strict' })
await send('Page.navigate', { url: guiUrl })

const trail = []
for (let i = 0; i < 12; i += 1) {
  await sleep(4000)
  try {
    trail.push(await ev(`(function(){
      var txt = document.body.innerText.replace(/\\s+/g,' ').slice(0,120);
      var gear = document.querySelector('[data-status-anim-ui="gear"]');
      var hasComposer = !!document.querySelector('textarea, [contenteditable="true"], [data-chat-flow]');
      return { t: Math.round(performance.now()), gear: gear!==null, composer: hasComposer, boot: /INIT|WELCOME TO/i.test(txt), txt: txt.slice(0,70) };
    })()`))
  } catch (e) { trail.push({ err: String(e).slice(0, 120) }) }
  if (trail[trail.length - 1].composer === true && trail[trail.length - 1].boot === false) break
}
out.trail = trail

out.overlays = await ev(`(function(){
  var res = [];
  document.querySelectorAll('body > *, body > * > *').forEach(function(el){
    var cs = getComputedStyle(el); var r = el.getBoundingClientRect();
    if ((cs.position === 'fixed' || cs.position === 'absolute') && r.width > 300 && r.height > 300) {
      res.push({ tag: el.tagName, cls: String(el.className).slice(0,40), z: cs.zIndex, op: cs.opacity, cover: r.width*r.height });
    }
  });
  return res.slice(0,6);
})()`)

// 造状态条，看是否被覆盖层遮住（命中测试）
out.occlusion = await ev(`(async function(){
  var flow = document.createElement('div'); flow.setAttribute('data-chat-flow','1'); flow.setAttribute('id','sa-occl-flow');
  flow.style.cssText='position:fixed;left:40px;top:400px;z-index:2147482000;background:#111;color:#eee;padding:16px 22px;border-radius:10px;font:14px/1.6 system-ui';
  var row = document.createElement('div'); row.setAttribute('role','status'); row.setAttribute('aria-live','polite'); row.setAttribute('id','sa-occl-row');
  row.textContent='Deep diving...';
  flow.appendChild(row); document.body.appendChild(flow);
  await new Promise(function(r){setTimeout(r,3000)});
  var img = row.querySelector('img[data-status-anim="1"]');
  var tgt = img || row;
  var r = tgt.getBoundingClientRect();
  var hit = document.elementFromPoint(r.x + Math.min(6, r.width/2), r.y + Math.min(9, r.height/2));
  var chain = []; var n = hit;
  while (n && n !== document.documentElement && chain.length < 6) { chain.push(n.tagName + (n.getAttribute && n.getAttribute('data-status-anim-ui') ? '[' + n.getAttribute('data-status-anim-ui') + ']' : '') + (n.className && typeof n.className === 'string' ? '.' + n.className.slice(0,20) : '')); n = n.parentElement; }
  return { imgFound: img!==null, src: img && img.getAttribute('src'), rect: {x:r.x,y:r.y,w:r.width,h:r.height}, hitChain: chain, covered: !(img && hit === img) };
})()`)

// GIF 是否真的在动：采样 8 次
out.gifFrames = await ev(`(async function(){
  var img = document.querySelector('#sa-occl-row img[data-status-anim="1"]');
  if (img === null) return { noImg:true };
  var c = document.createElement('canvas'); c.width=72; c.height=72; var ctx=c.getContext('2d');
  var frames = [];
  for (var k=0;k<8;k++){ ctx.clearRect(0,0,72,72); ctx.drawImage(img,0,0,72,72); frames.push(ctx.getImageData(0,0,72,72).data.join(',').length + ':' + Array.from(ctx.getImageData(0,0,72,72).data.slice(0,40)).join('')); await new Promise(function(r){setTimeout(r,180)}); }
  var uniq = {}; frames.forEach(function(f){ uniq[f]=1 });
  return { distinctHashes: Object.keys(uniq).length, src: img.getAttribute('src'), natural: img.naturalWidth + 'x' + img.naturalHeight };
})()`)

const s = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(`${DIR}\\verify-5-mainstate.png`, Buffer.from(s.data, 'base64'))
out.shot5 = 'verify-5-mainstate.png'
ws.close()
writeFileSync(`${DIR}\\verify-report2.json`, JSON.stringify(out, null, 2))
console.log(JSON.stringify(out, null, 2))
