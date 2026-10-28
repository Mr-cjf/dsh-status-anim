/**
 * 根因取证：在页面内先造与截图同形的诱饵（侧边栏会话条目 / 思考块 / class 含 Status），
 * 再用**旧版** SELECTORS 逐路 querySelectorAll，输出命中的 tagName+className+祖先链，
 * 证明是哪一路把图插进了侧边栏与思考块。
 *
 * 用法：node test/verify-rootcause.mjs <guiUrl> [cdpPort]
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

await send('Runtime.enable')
await send('Page.enable')
await send('Network.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Network.setCookie', { name: cname, value: cval, url: guiUrl, path: '/', httpOnly: true, sameSite: 'Strict' })
await send('Page.navigate', { url: guiUrl })
await send('Page.bringToFront')
await sleep(11000)

const out = await ev(`(async function(){
  // ---- 造与截图同形的诱饵 ----
  var side=document.createElement('div'); side.setAttribute('data-test','rc-sidebar'); side.className='XyZ_sidebar';
  side.style.cssText='width:260px;padding:6px';
  ['合并 opencode/swift-wolf 分支','合并一下主分支代码','了解 dsh soul-0.9 插件','任务状态更新问题'].forEach(function(t){
    var item=document.createElement('div'); item.className='XyZ_sessionItem';
    item.style.cssText='display:flex;align-items:center;gap:6px;height:32px;width:250px';
    var st=document.createElement('span'); st.setAttribute('role','status'); st.setAttribute('aria-live','polite'); st.textContent=t;
    item.appendChild(st); side.appendChild(item);
  });
  document.body.appendChild(side);

  var think=document.createElement('div'); think.setAttribute('data-test','rc-think'); think.className='XyZ_turnStatus';
  think.style.cssText='width:520px;padding:10px';
  var head=document.createElement('div'); head.setAttribute('role','status'); head.textContent='思考 · Let me delegate';
  var bodyEl=document.createElement('div'); bodyEl.style.cssText='height:40px;width:500px'; bodyEl.textContent='Let me delegate this to a subagent.';
  think.appendChild(head); think.appendChild(bodyEl); document.body.appendChild(think);

  var st2=document.createElement('div'); st2.setAttribute('data-test','rc-status'); st2.className='Abc_StatusBar';
  st2.style.cssText='width:480px;height:28px'; st2.textContent='一些与状态行无关的文字内容'; document.body.appendChild(st2);

  var flow=document.createElement('div'); flow.setAttribute('data-chat-flow','1'); flow.id='rc-flow';
  var row=document.createElement('div'); row.setAttribute('data-chat-running','1'); row.className='V4vHZW_running';
  row.style.cssText='display:flex;align-items:center;gap:6px;height:24px;width:420px';
  var hid=document.createElement('span'); hid.setAttribute('role','status'); hid.setAttribute('aria-live','polite'); hid.textContent='深度求索中';
  var ct=document.createElement('span'); ct.className='V4vHZW_runningContent'; ct.textContent='深度求索中，用时 20 秒 ···';
  row.appendChild(hid); row.appendChild(ct); flow.appendChild(row); document.body.appendChild(flow);

  await new Promise(function(r){setTimeout(r,800)});

  // ---- 旧版逻辑复现（与修复前 lib/client.js 完全一致）----
  var OLD=[
    '[data-chat-flow] [data-chat-running]',
    '[data-chat-running]',
    '[role="status"][aria-live="polite"]',
    '[role="status"]',
    '[class*="_runningContent"]',
    '[class*="_turnStatus"]',
    '[class*="Status"]',
  ];
  function chain(el){var c=[],n=el;for(var i=0;n&&c.length<6;i++){c.push(n.tagName+(typeof n.className==='string'&&n.className?'.'+n.className.trim().split(/\\s+/).join('.').slice(0,50):''));n=n.parentElement}return c}
  function visible(el){var r=el.getBoundingClientRect();if(r.width<100)return false;if(r.height<=0||r.height>120)return false;return (el.textContent||'').trim().length>0}
  function findHost(hit){var n=hit;for(var d=0;n&&d<8;d++){if(n===document.body||n===document.documentElement)return null;if(visible(n))return n;n=n.parentElement}return null}
  function zone(el){return el.closest('[data-test="rc-sidebar"]')!==null?'sidebar':(el.closest('[data-test="rc-think"]')!==null?'thinkblock':(el.closest('[data-test="rc-status"]')!==null?'statusclass':'other'))}

  var report=[];
  for(var i=0;i<OLD.length;i++){
    var hits=[],els=document.querySelectorAll(OLD[i]);
    for(var k=0;k<els.length;k++){
      var host=findHost(els[k]); if(host===null) continue;
      hits.push({hit:els[k].tagName+'.'+String(els[k].className||'').slice(0,40),
                 hitAttrs:(els[k].getAttribute('role')||'')+'/'+(els[k].getAttribute('aria-live')||''),
                 host:host.tagName+'.'+String(host.className||'').slice(0,40),
                 hostRect:(function(r){return Math.round(r.width)+'x'+Math.round(r.height)})(host.getBoundingClientRect()),
                 zone:zone(host), hostChain:chain(host)});
    }
    report.push({sel:OLD[i], hitCount:hits.length, sample:hits.slice(0,3)});
  }
  return {old:report, legitRowWouldMatch: report[0].hitCount};
})()`)

ws.close()
writeFileSync(`${DIR}\\verify-rootcause.json`, JSON.stringify(out, null, 2))
console.log(JSON.stringify(out, null, 2).slice(0, 6000))
