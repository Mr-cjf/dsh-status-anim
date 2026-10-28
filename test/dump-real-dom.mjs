/**
 * 抓真实 DOM：连 headless Chrome，打开 DSH Web GUI，枚举所有疑似「状态行」的元素，
 * 输出真实结构（tagName / className / aria-live / 祖先链 / outerHTML 片段），
 * 并找出包含「深度求索中 / Deep diving / 用时」文本的元素及其祖先链。
 *
 * 用法：node test/dump-real-dom.mjs <guiUrl> <cdpPort>
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash, createHmac } from 'node:crypto'

const guiUrl = process.argv[2] ?? 'http://127.0.0.1:54109'
const port = Number(process.argv[3] ?? 9223)
const DIR = 'C:\\Users\\14023\\myproject\\dsh-status-anim\\assets'
mkdirSync(DIR, { recursive: true })

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
const send = (m, p = {}) => new Promise((res, rej) => { const id = ++seq; pend.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method: m, params: p })) })
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500)); return r.result.value }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Network.setCookie', { name: cname, value: cval, url: guiUrl, path: '/', httpOnly: true, sameSite: 'Strict' })
await send('Page.navigate', { url: guiUrl })
await send('Page.bringToFront')
await sleep(11000)

const out = {}
out.title = await ev(`({url: location.href, title: document.title})`)
out.boot = await ev(`({plugged: !!(window.__DSH_BOOT__ && (window.__DSH_BOOT__.entries||[]).some(function(e){return e.id==='dsh-status-anim'})), dsu: document.querySelectorAll('.dsu-root').length})`)

// A) 所有 role=status 命中
out.roleStatus = await ev(`(function(){
  var all=document.querySelectorAll('[role="status"]'); var a=[];
  for(var i=0;i<all.length;i++){var e=all[i];var r=e.getBoundingClientRect();
    var anc=[],n=e;while(n&&anc.length<30){anc.push(n.tagName);n=n.parentElement}
    a.push({i:i, tag:e.tagName, cls:typeof e.className==='string'?e.className:'', live:e.getAttribute('aria-live'),
      hasFlow: e.closest('[data-chat-flow]')!==null, ancHasFlowAttr: anc.some(function(){return false}),
      rect:[Math.round(r.width),Math.round(r.height)], text:(e.textContent||'').slice(0,80),
      html:e.outerHTML.slice(0,200)});}
  return a;})()`)

// A2) 祖先链里出现的所有属性名（判断 data-chat-flow 是否存在）
out.flowAttrs = await ev(`(function(){
  var names={}; var all=document.querySelectorAll('*');
  for(var i=0;i<all.length;i++){var e=all[i];
    if(e.hasAttribute('data-chat-flow')) names.flow=(names.flow||0)+1;
    if(e.getAttribute('role')==='status') names.status=(names.status||0)+1;
    if(e.getAttribute('aria-live')) names.live=(names.live||0)+1;
    var c=typeof e.className==='string'?e.className:'';
    if(/status|Status/.test(c)) { names['cls:'+c.slice(0,60)]=(names['cls:'+c.slice(0,60)]||0)+1 }
  }
  return names;})()`)

// B) 文本定位：包含 深度求索中 / Deep diving / 用时 的元素
out.textHits = await ev(`(function(){
  var re=/深度求索中|Deep diving|深度思考|深入思考|thinking/i; var out=[];
  var all=document.querySelectorAll('body *');
  for(var i=0;i<all.length;i++){var e=all[i];
    var txt=(e.textContent||'').trim();
    if(!re.test(txt)) continue;
    // 只看最内层：没有子元素也匹配的，或子元素数很少
    var innerOnly=true;
    for(var k=0;k<e.children.length;k++){ if(re.test((e.children[k].textContent||''))) { innerOnly=false; break } }
    if(!innerOnly) continue;
    var r=e.getBoundingClientRect();
    var chain=[];var n=e;while(n&&n!==document.documentElement){chain.push(n.tagName+(n.id?'#'+n.id:'')+(typeof n.className==='string'&&n.className?'.'+n.className.replace(/\\s+/g,'.').slice(0,60):''));n=n.parentElement}
    out.push({tag:e.tagName, cls:typeof e.className==='string'?e.className:'', live:e.getAttribute('aria-live'),
      role:e.getAttribute('role'), rect:[Math.round(r.width),Math.round(r.height)], y:Math.round(r.y),
      text:txt.slice(0,120), chain:chain, html:e.outerHTML.slice(0,500)});
    if(out.length>=8) break;
  }
  return out;})()`)

// C) 所有「用时」类状态行（含秒数）
out.timerHits = await ev(`(function(){
  var out=[]; var all=document.querySelectorAll('body *');
  for(var i=0;i<all.length;i++){var e=all[i];var txt=(e.textContent||'');
    if(!/用时\\s*\\d+/.test(txt)) continue;
    var ok=true; for(var k=0;k<e.children.length;k++){ if(/用时\\s*\\d+/.test(e.children[k].textContent||'')){ok=false;break} }
    if(!ok) continue;
    var r=e.getBoundingClientRect();
    var chain=[];var n=e;while(n&&n!==document.documentElement){chain.push(n.tagName+(n.id?'#'+n.id:'')+(typeof n.className==='string'&&n.className?'.'+n.className.replace(/\\s+/g,'.').slice(0,60):''));n=n.parentElement}
    out.push({tag:e.tagName, cls:typeof e.className==='string'?e.className:'', live:e.getAttribute('aria-live'), role:e.getAttribute('role'),
      rect:[Math.round(r.width),Math.round(r.height)], text:txt.trim().slice(0,120), chain:chain, html:e.outerHTML.slice(0,600)});
    if(out.length>=5) break;}
  return out;})()`)

// D) 整个页面可见文本里最后 800 字符（判断是否在会话页）
out.tailText = await ev(`(document.body.innerText||'').slice(-700)`)
out.bodyHtmlSample = await ev(`document.body.innerHTML.length`)

const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(`${DIR}\\real-dom-screenshot.png`, Buffer.from(shot.data, 'base64'))

ws.close()
writeFileSync(`${DIR}\\real-dom.json`, JSON.stringify(out, null, 2))
console.log(JSON.stringify(out, null, 2).slice(0, 6000))
