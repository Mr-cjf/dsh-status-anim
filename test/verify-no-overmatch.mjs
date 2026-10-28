/**
 * 过度匹配回归验证：在真实页面（侧边栏会话列表 + 思考块 + 状态行）上确认
 * `img[data-status-anim]` 只出现在合法状态行里。
 *
 * 用法：node test/verify-no-overmatch.mjs <guiUrl> [cdpPort]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash, createHmac } from 'node:crypto'

const guiUrl = process.argv[2] ?? 'http://127.0.0.1:54109'
const port = Number(process.argv[3] ?? 9334)
const DIR = 'C:\\Users\\14023\\myproject\\dsh-status-anim\\assets'

const b64u = (b) => Buffer.from(b).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
const lines = readFileSync('C:\\Users\\14023\\.dsh\\.credentials.yaml', 'utf8').split(/\r?\n/)
let sb
for (let i = 0; i < lines.length; i += 1) {
  if (lines[i].includes('client-connection/browser-session:')) {
    for (let j = i + 1; j <= i + 8; j += 1) {
      const m = /^\s+secret:\s*(.+?)\s*$/.exec(lines[j] ?? '')
      if (m) { sb = m[1].replace(/^['"]|['"]$/g, ''); break }
    }
    break
  }
}
const secret = Buffer.from(sb, 'base64url')
const authority = new URL(guiUrl).host
const now = Date.now()
const body = b64u(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt: now, expiresAt: now + 36e5 }), 'utf8'))
const cname = `dsh-auth-${b64u(createHash('sha256').update(authority).digest())}`
const cval = `v1.${body}.${b64u(createHmac('sha256', secret).update(body).digest())}`

const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
const ws = new WebSocket(t.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }) })
let seq = 0
const pend = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  const w = pend.get(m.id)
  if (w) { pend.delete(m.id); m.error ? w.reject(new Error(JSON.stringify(m.error))) : w.resolve(m.result) }
})
const send = (m, p = {}) => new Promise((res, rej) => { const id = ++seq; pend.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method: m, params: p })) })
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500))
  return r.result.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = {}
const check = (label, ok, detail) => out[label] = { ok, detail }

await send('Runtime.enable')
await send('Page.enable')
await send('Network.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Network.setCookie', { name: cname, value: cval, url: guiUrl, path: '/', httpOnly: true, sameSite: 'Strict' })
await send('Page.navigate', { url: guiUrl })
await send('Page.bringToFront')
await sleep(11000)

// 页面基础事实：确认这页确实有侧边栏会话条目 + role=status 元素（即旧 bug 的温床）
out.baseline = await ev(`(function(){
  var q=function(s){try{return document.querySelectorAll(s).length}catch(e){return -1}};
  return {
    sidebar: q('[class*="sidebar" i]'),
    aside: q('aside'), nav: q('nav'),
    roleStatus: q('[role="status"]'),
    ariaLive: q('[aria-live]'),
    chatRunning: q('[data-chat-running]'),
    chatFlow: q('[data-chat-flow]'),
    totalImg: q('img[data-status-anim="1"]'),
    sidebarImg: q('[class*="sidebar" i] img[data-status-anim="1"]'),
    asideImg: q('aside img[data-status-anim="1"]'),
    navImg: q('nav img[data-status-anim="1"]'),
  };
})()`)

// 造历史残留误插：模拟上一版把图插进侧边栏会话条目里，验证 prune 会清掉它
out.seed = await ev(`(function(){
  var host=document.querySelector('[class*="sidebar" i] *')||document.querySelector('aside *')||document.body;
  var row=document.querySelector('[class*="sidebar" i] [class*="item" i]')||document.querySelector('[class*="sidebar" i] div')||host;
  if(!row) return { noRow:true };
  var img=document.createElement('img');
  img.setAttribute('data-status-anim','1');
  img.setAttribute('src','/status-anim/file/diving.gif');
  row.insertBefore(img,row.firstChild);
  return { seededInto: row.tagName+'.'+(typeof row.className==='string'?row.className.slice(0,40):'') };
})()`)

// 造一个真实结构的合法状态行（不依赖用户在真实会话里发消息）
out.legit = await ev(`(async function(){
  var flow=document.createElement('div');
  flow.className='V4vHZW_column'; flow.setAttribute('data-chat-flow','1'); flow.id='sa-verify-flow';
  var row=document.createElement('div');
  row.className='V4vHZW_running'; row.setAttribute('data-chat-running','1'); row.id='sa-verify-row';
  var hidden=document.createElement('span');
  hidden.className='BpRApG_visuallyHidden';
  hidden.setAttribute('role','status'); hidden.setAttribute('aria-live','polite'); hidden.textContent='深度求索中';
  var div=document.createElement('span'); div.className='V4vHZW_runningDivider';
  var content=document.createElement('span'); content.className='V4vHZW_runningContent';
  content.textContent='深度求索中，用时 2 秒 ···';
  row.appendChild(hidden); row.appendChild(div); row.appendChild(content);
  flow.appendChild(row); document.body.appendChild(flow);
  await new Promise(function(r){setTimeout(r,4200)});
  var imgs=document.querySelectorAll('img[data-status-anim="1"]');
  return { inRow: row.querySelectorAll('img[data-status-anim="1"]').length,
           inContent: content.querySelectorAll('img[data-status-anim="1"]').length,
           allCount: imgs.length };
})()`)

await sleep(3000)

// 终检：全页遍历每个命中元素，输出祖先链与位置
out.final = await ev(`(function(){
  function chain(el){var c=[],n=el;for(var i=0;n&&c.length<8;i++){c.push(n.tagName+(n.id?'#'+n.id:'')+(typeof n.className==='string'&&n.className?'.'+n.className.trim().split(/\\s+/).join('.').slice(0,70):''));n=n.parentElement}return c}
  var imgs=[].slice.call(document.querySelectorAll('img[data-status-anim="1"]'));
  var stateImgs=imgs.filter(function(i){return i.getAttribute('data-status-anim-role')!=='action' && !i.closest('[data-status-anim-ui]')});
  var detail=stateImgs.map(function(img){
    var r=img.getBoundingClientRect();
    return { src:(img.getAttribute('src')||'').slice(0,60), w:img.style.width,
             rect:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)},
             chain:chain(img) };
  });
  return {
    stateImgTotal: stateImgs.length,
    allImgTotal: imgs.length,
    sidebarImg: document.querySelectorAll('[class*="sidebar" i] img[data-status-anim]').length,
    asideNavImg: document.querySelectorAll('aside img[data-status-anim], nav img[data-status-anim]').length,
    detail: detail,
  };
})()`)

const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(`${DIR}\\verify-no-overmatch.png`, Buffer.from(shot.data, 'base64'))
ws.close()
writeFileSync(`${DIR}\\verify-no-overmatch.json`, JSON.stringify(out, null, 2))
console.log(JSON.stringify(out, null, 2))
const ok = out.final.stateImgTotal <= 1 && out.final.sidebarImg === 0 && out.final.asideNavImg === 0 && out.legit.inContent === 1
process.exitCode = ok ? 0 : 1
