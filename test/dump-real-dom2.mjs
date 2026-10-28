/**
 * 第二轮：移除授权遮罩 → 打开最近会话 → 全量枚举 aria-live / role=status / class*=Status /
 * 文本命中「深度求索中|Deep diving|用时」，并在需要时发一条会触发思考的消息抓活跃状态行。
 * 用法：node test/dump-real-dom2.mjs <guiUrl> <cdpPort>
 */
import { readFileSync, writeFileSync } from 'node:fs'

const guiUrl = process.argv[2] ?? 'http://127.0.0.1:54109'
const port = Number(process.argv[3] ?? 9333)
const DIR = 'C:\\Users\\14023\\myproject\\dsh-status-anim\\assets'
const b64u = (b) => Buffer.from(b).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
const lines = readFileSync('C:\\Users\\14023\\.dsh\\.credentials.yaml', 'utf8').split(/\r?\n/)
let sb
for (let i = 0; i < lines.length; i += 1) if (lines[i].includes('client-connection/browser-session:')) {
  for (let j = i + 1; j < i + 8; j += 1) { const m = /^\s+secret:\s*(.+?)\s*$/.exec(lines[j]); if (m) { sb = m[1].replace(/^['"]|['"]$/g, ''); break } }
  break
}
const { createHash, createHmac } = await import('node:crypto')
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
await sleep(10500)

const out = {}
// 1) 授权遮罩：优先真点按钮，失败则移除节点
out.gate = await ev(`(function(){
  var btns=Array.from(document.querySelectorAll('button')).filter(function(b){return /授予访问权限|GRANT ACCESS/i.test(b.textContent||'')});
  if(btns.length){ btns[0].click(); return {clicked:true, n:btns.length} }
  var g=document.querySelectorAll('.dsu-root'); var n=g.length; g.forEach(function(e){e.remove()});
  return {removed:n};
})()`)
await sleep(2500)

// 2) 打开最近一个会话（侧栏第一条会话）
out.openSession = await ev(`(function(){
  var sel='[class*="session"],[class*="Session"],[class*="conversation"],[class*="history"]';
  var cands=Array.from(document.querySelectorAll('a,button,div[role="button"],li')).filter(function(e){
    var t=(e.textContent||'').trim(); var r=e.getBoundingClientRect();
    return r.height>10 && r.width>60 && r.x<420 && /dsh|插件|PowerShell|会话|配置|worktree|CoHub/i.test(t) && t.length<60;
  });
  if(cands.length===0) return {none:true};
  cands[0].click();
  return {clicked:(cands[0].textContent||'').trim().slice(0,50), n:cands.length};
})()`)
await sleep(4000)

// 3) 全量枚举：aria-live 元素
out.ariaLive = await ev(`(function(){
  var a=[];var all=document.querySelectorAll('[aria-live]');
  for(var i=0;i<all.length;i++){var e=all[i];var r=e.getBoundingClientRect();
    var chain=[];var n=e;while(n&&n!==document.documentElement){chain.push(n.tagName+(typeof n.className==='string'&&n.className?'.'+n.className.replace(/\\s+/g,'.').slice(0,50):''));n=n.parentElement}
    a.push({i:i,live:e.getAttribute('aria-live'),role:e.getAttribute('role'),tag:e.tagName,
      cls:typeof e.className==='string'?e.className.slice(0,80):'',rect:[Math.round(r.width),Math.round(r.height)],
      text:(e.textContent||'').trim().slice(0,90),chain:chain.slice(0,8),html:e.outerHTML.slice(0,300)});}
  return a;})()`)

// 4) role=status
out.roleStatus = await ev(`(function(){
  var a=[];var all=document.querySelectorAll('[role="status"]');
  for(var i=0;i<all.length;i++){var e=all[i];var r=e.getBoundingClientRect();
    a.push({i:i,tag:e.tagName,cls:typeof e.className==='string'?e.className.slice(0,80):'',live:e.getAttribute('aria-live'),
      rect:[Math.round(r.width),Math.round(r.height)],text:(e.textContent||'').trim().slice(0,90),html:e.outerHTML.slice(0,300)});}
  return a;})()`)

// 5) class 含 Status 的元素
out.clsStatus = await ev(`(function(){
  var a=[];var all=document.querySelectorAll('*');
  for(var i=0;i<all.length;i++){var e=all[i];var c=typeof e.className==='string'?e.className:'';
    if(!/status|Status/.test(c)) continue;
    var r=e.getBoundingClientRect();
    a.push({tag:e.tagName,cls:c.slice(0,90),live:e.getAttribute('aria-live'),role:e.getAttribute('role'),
      rect:[Math.round(r.width),Math.round(r.height)],text:(e.textContent||'').trim().slice(0,90),html:e.outerHTML.slice(0,300)});
    if(a.length>=25)break;}
  return a;})()`)

// 6) 文本命中
out.textHits = await ev(`(function(){
  var re=/深度求索中|Deep diving|深度思考|深入思考|用时\\s*\\d+/i; var out=[];
  var all=document.querySelectorAll('body *');
  for(var i=0;i<all.length;i++){var e=all[i];var txt=(e.textContent||'').trim();
    if(!re.test(txt)) continue;
    var inner=true; for(var k=0;k<e.children.length;k++){ if(re.test((e.children[k].textContent||''))){inner=false;break} }
    if(!inner) continue;
    var r=e.getBoundingClientRect();
    var chain=[];var n=e;while(n&&n!==document.documentElement){chain.push(n.tagName+(typeof n.className==='string'&&n.className?'.'+n.className.replace(/\\s+/g,'.').slice(0,60):''));n=n.parentElement}
    out.push({tag:e.tagName,cls:typeof e.className==='string'?e.className.slice(0,90):'',live:e.getAttribute('aria-live'),
      role:e.getAttribute('role'),rect:[Math.round(r.width),Math.round(r.height)],y:Math.round(r.y),
      text:txt.slice(0,120),chain:chain.slice(0,10),html:e.outerHTML.slice(0,500)});
    if(out.length>=8)break;}
  return out;})()`)

out.tailText = await ev(`(document.body.innerText||'').slice(-1200)`)
const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(`${DIR}\\real-dom2-screenshot.png`, Buffer.from(shot.data, 'base64'))
ws.close()
writeFileSync(`${DIR}\\real-dom2.json`, JSON.stringify(out, null, 2))
console.log(JSON.stringify({ gate: out.gate, open: out.openSession, ariaLive: out.ariaLive?.length, roleStatus: out.roleStatus?.length, clsStatus: out.clsStatus?.length, textHits: out.textHits?.length }))
console.log('--- ariaLive ---'); console.log(JSON.stringify(out.ariaLive, null, 1).slice(0, 2500))
console.log('--- roleStatus ---'); console.log(JSON.stringify(out.roleStatus, null, 1).slice(0, 1200))
console.log('--- clsStatus ---'); console.log(JSON.stringify(out.clsStatus, null, 1).slice(0, 2000))
console.log('--- textHits ---'); console.log(JSON.stringify(out.textHits, null, 1).slice(0, 2000))
console.log('--- tail ---'); console.log(String(out.tailText).slice(-600))
