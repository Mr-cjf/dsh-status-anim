/**
 * 可视化实证：截图 + 遮挡检测 + 图片渲染检测 + GIF 是否在动。
 * 只操作浏览器（localStorage / 造 DOM），不改磁盘、不发消息。
 *
 * 用法：node test/verify-visual.mjs <guiUrl> [cdpPort]
 */
import { createHash, createHmac } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const guiUrl = process.argv[2] ?? 'http://127.0.0.1:62811'
const port = Number(process.argv[3] ?? 9333)
const DIR = 'C:\\Users\\14023\\myproject\\dsh-status-anim\\assets'
mkdirSync(DIR, { recursive: true })

// ---------- 1. 铸 auth cookie（复刻 BrowserAuth.encodeCookie） ----------
const b64u = (buf) => Buffer.from(buf).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
const yaml = readFileSync('C:\\Users\\14023\\.dsh\\.credentials.yaml', 'utf8')
const lines = yaml.split(/\r?\n/)
let secretB64
for (let i = 0; i < lines.length; i += 1) {
  if (lines[i].includes('client-connection/browser-session:')) {
    for (let j = i + 1; j < Math.min(i + 8, lines.length); j += 1) {
      const m = /^\s+secret:\s*(.+?)\s*$/.exec(lines[j])
      if (m !== null) { secretB64 = m[1].replace(/^['"]|['"]$/g, ''); break }
    }
    break
  }
}
if (secretB64 === undefined) throw new Error('secret not found in credentials.yaml')
const secret = Buffer.from(secretB64, 'base64url')
if (secret.byteLength !== 32) throw new Error(`secret length ${secret.byteLength} != 32`)
const authority = new URL(guiUrl).host
const now = Date.now()
const payload = { version: 1, authority, issuedAt: now, expiresAt: now + 7 * 864e5 }
const body = b64u(Buffer.from(JSON.stringify(payload), 'utf8'))
const cookieName = `dsh-auth-${b64u(createHash('sha256').update(authority).digest())}`
const cookieValue = `v1.${body}.${b64u(createHmac('sha256', secret).update(body).digest())}`

// ---------- 2. CDP ----------
const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }) })
let seq = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data)
  const w = pending.get(msg.id)
  if (w !== undefined) { pending.delete(msg.id); msg.error !== undefined ? w.reject(new Error(JSON.stringify(msg.error))) : w.resolve(msg.result) }
})
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params })) })
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails !== undefined) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 600))
  return r.result.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (name, clip) => {
  const params = { format: 'png' }
  if (clip !== undefined) params.clip = clip
  const s = await send('Page.captureScreenshot', params)
  const buf = Buffer.from(s.data, 'base64')
  writeFileSync(`${DIR}\\${name}`, buf)
  return { name, bytes: buf.byteLength, buf }
}
const report = {}

await send('Runtime.enable')
await send('Page.enable')
await send('Network.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Network.setCookie', { name: cookieName, value: cookieValue, url: guiUrl, path: '/', httpOnly: true, sameSite: 'Strict' })
await send('Page.navigate', { url: guiUrl })

// ---------- 3. 等 gear 出现 ----------
let gearReady = false
for (let i = 0; i < 40; i += 1) {
  await sleep(500)
  try { gearReady = await evaluate(`document.querySelector('[data-status-anim-ui="gear"]') !== null`) } catch { gearReady = false }
  if (gearReady === true) break
}
await sleep(1200)
report.gearReady = gearReady
report.pageText = String(await evaluate(`document.body.innerText.slice(0,160)`))

// ---------- 4. 齿轮几何 + 遮挡检测 ----------
report.gear = await evaluate(`(function(){
  var g = document.querySelector('[data-status-anim-ui="gear"]');
  if (g === null) return { exists:false };
  var r = g.getBoundingClientRect();
  var cs = getComputedStyle(g);
  var cx = r.x + r.width/2, cy = r.y + r.height/2;
  var hit = document.elementFromPoint(cx, cy);
  var hitTop = hit === null ? null : (hit.getAttribute && hit.getAttribute('data-status-anim-ui')) || hit.tagName;
  return {
    exists:true,
    rect:{x:r.x,y:r.y,w:r.width,h:r.height},
    viewport:{w:innerWidth,h:innerHeight},
    inViewport: r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
    style:{position:cs.position,right:cs.right,bottom:cs.bottom,zIndex:cs.zIndex,opacity:cs.opacity,display:cs.display,visibility:cs.visibility,pointerEvents:cs.pointerEvents},
    hitIsGear: hit === g,
    hitElement: hitTop,
    text: g.textContent
  };
})()`)

// ---------- 5. 截图 1：全页 idle ----------
const s1 = await shot('verify-1-idle.png')
report.shot1 = { name: s1.name, bytes: s1.bytes }

// ---------- 6. 截图 2：右下角放大（scale 4） ----------
const geo = await evaluate(`({w:innerWidth,h:innerHeight})`)
const crop = { x: Math.max(0, geo.w - 200), y: Math.max(0, geo.h - 200), width: 200, height: 200 }
const s2 = await shot('verify-2-gear-zoom.png', { ...crop, scale: 4 })
report.shot2 = { name: s2.name, bytes: s2.bytes, clip: crop }

// ---------- 7. 造真实结构状态条 → 看插件插图 ----------
report.inject = await evaluate(`(async function(){
  var flow = document.createElement('div');
  flow.setAttribute('data-chat-flow','1');
  flow.setAttribute('id','sa-verify-flow');
  flow.style.cssText = 'position:fixed;left:40px;top:120px;z-index:2147482000;background:#1e1e1e;color:#eee;padding:16px 22px;border-radius:10px;font:14px/1.6 system-ui;min-width:320px;box-shadow:0 8px 28px rgba(0,0,0,.5)';
  var row = document.createElement('div');
  row.setAttribute('role','status');
  row.setAttribute('aria-live','polite');
  row.setAttribute('id','sa-verify-row');
  row.textContent = 'Deep diving...';
  flow.appendChild(row);
  document.body.appendChild(flow);
  await new Promise(function(r){ setTimeout(r, 3000) });
  var img = row.querySelector('img[data-status-anim="1"]');
  if (img === null) return { found:false, rowHtml: row.outerHTML.slice(0,300), flowExists: document.querySelectorAll('[data-chat-flow]').length };
  if (typeof img.decode === 'function') { try { await img.decode() } catch(e) {} }
  var r = img.getBoundingClientRect();
  var cs = getComputedStyle(img);
  return {
    found:true,
    src: img.getAttribute('src'),
    name: img.dataset.statusAnimName,
    inline:{w:img.style.width,h:img.style.height,objectFit:img.style.objectFit,verticalAlign:img.style.verticalAlign},
    rect:{x:r.x,y:r.y,w:r.width,h:r.height},
    computed:{display:cs.display,visibility:cs.visibility,opacity:cs.opacity,maxWidth:cs.maxWidth,maxHeight:cs.maxHeight,overflow:cs.overflow,position:cs.position,transform:cs.transform},
    natural:{w:img.naturalWidth,h:img.naturalHeight,complete:img.complete},
    count: row.querySelectorAll('img[data-status-anim="1"]').length,
    isFirst: row.firstElementChild === img
  };
})()`)

// ---------- 8. 截图 3：图片插入后 ----------
const rowBox = await evaluate(`(function(){var f=document.getElementById('sa-verify-flow');if(f===null)return null;var r=f.getBoundingClientRect();return {x:Math.max(0,r.x-10),y:Math.max(0,r.y-10),width:Math.min(innerWidth,r.width+20),height:Math.min(innerHeight,r.height+20)}})()`)
const s3 = await shot('verify-3-img-inserted.png', rowBox === null ? undefined : { ...rowBox, scale: 3 })
report.shot3 = { name: s3.name, bytes: s3.bytes, clip: rowBox }

// ---------- 9. 强制 diving.gif → 刷新 → 再造状态条 → 验动画 ----------
await evaluate(`localStorage.setItem('dsh-status-anim.picked','diving.gif')`)
await send('Page.reload', { ignoreCache: false })
let ready2 = false
for (let i = 0; i < 40; i += 1) {
  await sleep(500)
  try { ready2 = await evaluate(`document.querySelector('[data-status-anim-ui="gear"]') !== null`) } catch { ready2 = false }
  if (ready2 === true) break
}
await sleep(800)
report.afterReload = await evaluate(`({gear: document.querySelectorAll('[data-status-anim-ui="gear"]').length, picked: localStorage.getItem('dsh-status-anim.picked'), size: localStorage.getItem('dsh-status-anim.size'), enabled: localStorage.getItem('dsh-status-anim.enabled')})`)

report.gif = await evaluate(`(async function(){
  var flow = document.createElement('div');
  flow.setAttribute('data-chat-flow','1');
  flow.setAttribute('id','sa-verify-flow2');
  flow.style.cssText = 'position:fixed;left:40px;top:120px;z-index:2147482000;background:#1e1e1e;color:#eee;padding:16px 22px;border-radius:10px;font:14px/1.6 system-ui;min-width:320px';
  var row = document.createElement('div');
  row.setAttribute('role','status'); row.setAttribute('aria-live','polite'); row.setAttribute('id','sa-verify-row2');
  row.textContent = 'Deep diving...';
  flow.appendChild(row); document.body.appendChild(flow);
  await new Promise(function(r){ setTimeout(r, 3000) });
  var img = row.querySelector('img[data-status-anim="1"]');
  if (img === null) return { found:false };
  if (typeof img.decode === 'function') { try { await img.decode() } catch(e) {} }
  var r = img.getBoundingClientRect();
  // 用 canvas 采样同一位置两次，判断 GIF 帧是否变化
  var c = document.createElement('canvas'); c.width = 64; c.height = 64;
  var ctx = c.getContext('2d');
  function sample(){
    ctx.clearRect(0,0,64,64);
    ctx.drawImage(img, 0, 0, 64, 64);
    return ctx.getImageData(0,0,64,64).data;
  }
  if (r.width === 0) return { found:true, zeroSize:true, src: img.getAttribute('src') };
  var a = sample();
  await new Promise(function(rr){ setTimeout(rr, 450) });
  var b = sample();
  var diff = 0;
  for (var i = 0; i < a.length; i += 4) { if (a[i]!==b[i] || a[i+1]!==b[i+1] || a[i+2]!==b[i+2]) diff++ }
  return {
    found:true, src: img.getAttribute('src'), name: img.dataset.statusAnimName,
    rect:{x:r.x,y:r.y,w:r.width,h:r.height},
    natural:{w:img.naturalWidth,h:img.naturalHeight},
    changedPixels: diff, animated: diff > 40
  };
})()`)

// 两张连续整页截图，字节比对（证明画面真的在变）
const g1 = await send('Page.captureScreenshot', { format: 'png' })
await sleep(420)
const g2 = await send('Page.captureScreenshot', { format: 'png' })
const b1 = Buffer.from(g1.data, 'base64'); const b2 = Buffer.from(g2.data, 'base64')
report.frameDiff = { same: b1.equals(b2), len1: b1.byteLength, len2: b2.byteLength }

const box2 = await evaluate(`(function(){var f=document.getElementById('sa-verify-flow2');if(f===null)return null;var r=f.getBoundingClientRect();return {x:Math.max(0,r.x-10),y:Math.max(0,r.y-10),width:Math.min(innerWidth,r.width+20),height:Math.min(innerHeight,r.height+20)}})()`)
const s4a = await shot('verify-4-diving.gif.png', box2 === null ? undefined : { ...box2, scale: 4 })
report.shot4 = { name: s4a.name, bytes: s4a.bytes, clip: box2 }

// ---------- 10. CSS 冲突 / 素材目录 ----------
report.materials = await evaluate(`fetch('/status-anim/list',{cache:'no-store'}).then(function(r){return r.json()}).catch(function(e){return String(e)})`)
report.imgGlobalCss = await evaluate(`(function(){
  var hits = [];
  for (var i = 0; i < document.styleSheets.length; i++) {
    var sh = document.styleSheets[i]; var rules;
    try { rules = sh.cssRules } catch(e) { continue }
    for (var j = 0; j < rules.length; j++) {
      var t = rules[j].selectorText;
      if (t && /(^|,|\\s)img(\\s|,|$|\\[|:|\\.|#)/.test(t) && /max-width|display\\s*:\\s*none|visibility\\s*:\\s*hidden|opacity\\s*:\\s*0/.test(rules[j].cssText)) hits.push(t + ' => ' + rules[j].cssText.slice(0,120));
    }
  }
  return hits.slice(0,5);
})()`)

ws.close()
writeFileSync(`${DIR}\\verify-report.json`, JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
