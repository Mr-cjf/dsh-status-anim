/**
 * 对照实验：在真实页面上造「旧 bug 温床」——侧边栏会话条目（role=status + aria-live）、
 * 思考块（role=status、文本 Let me delegate）、以及 class 含 Status 的容器，
 * 验证新版逻辑**一个都不插**。
 *
 * 用法：node test/verify-decoys.mjs <guiUrl> [cdpPort]
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

await send('Runtime.enable')
await send('Page.enable')
await send('Network.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Network.setCookie', { name: cname, value: cval, url: guiUrl, path: '/', httpOnly: true, sameSite: 'Strict' })
await send('Page.navigate', { url: guiUrl })
await send('Page.bringToFront')
await sleep(11000)

out.mk = await ev(`(async function(){
  var made={};
  // A) 侧边栏会话条目：class 含 sidebar + 内部 role=status/aria-live（旧 bug 会插图）
  var side=document.createElement('div');
  side.setAttribute('data-test','decoy-sidebar'); side.className='XyZ_sidebar';
  side.style.cssText='width:260px;padding:6px';
  for(var i=0;i<4;i++){
    var item=document.createElement('div');
    item.className='XyZ_sessionItem'; item.style.cssText='display:flex;align-items:center;gap:6px;height:32px;width:250px';
    var st=document.createElement('span');
    st.setAttribute('role','status'); st.setAttribute('aria-live','polite');
    st.textContent='合并 opencode/swift-wolf 分支';
    item.appendChild(st); side.appendChild(item);
  }
  document.body.appendChild(side); made.sidebarItems=4;

  // B) 思考块：role=status 标题 + 大段文本（旧 bug 会在下方插大图）
  var think=document.createElement('div');
  think.setAttribute('data-test','decoy-think');
  think.className='XyZ_turnStatus';
  think.style.cssText='width:520px;padding:10px';
  var head=document.createElement('div');
  head.setAttribute('role','status'); head.textContent='思考 · Let me delegate';
  var bodyEl=document.createElement('div'); bodyEl.style.cssText='height:40px;width:500px'; bodyEl.textContent='Let me delegate this to a subagent.';
  think.appendChild(head); think.appendChild(bodyEl); document.body.appendChild(think); made.think=1;

  // C) class 含 Status 的容器（旧 bug 第 5 路会命中）
  var c=document.createElement('div');
  c.setAttribute('data-test','decoy-status'); c.className='Abc_StatusBar';
  c.style.cssText='width:480px;height:28px'; c.textContent='一些与状态行无关的文字内容'; document.body.appendChild(c);
  made.status=1;

  // D) data-chat-flow 内、含状态行文案的合法状态行（对照组：必须插 1 张）
  var flow=document.createElement('div'); flow.setAttribute('data-chat-flow','1');
  var row=document.createElement('div');
  row.setAttribute('data-chat-running','1'); row.className='V4vHZW_running';
  row.style.cssText='display:flex;align-items:center;gap:6px;height:24px;width:420px';
  var hid=document.createElement('span'); hid.setAttribute('role','status'); hid.setAttribute('aria-live','polite'); hid.textContent='深度求索中';
  var content=document.createElement('span'); content.className='V4vHZW_runningContent'; content.textContent='深度求索中，用时 20 秒 ···';
  row.appendChild(hid); row.appendChild(content); flow.appendChild(row); document.body.appendChild(flow);

  await new Promise(function(r){setTimeout(r,5000)});

  function count(sel){try{return document.querySelectorAll(sel).length}catch(e){return -1}}
  return {
    total: count('img[data-status-anim="1"]'),
    inSidebarDecoy: count('[data-test="decoy-sidebar"] img[data-status-anim]'),
    inThinkDecoy: count('[data-test="decoy-think"] img[data-status-anim]'),
    inStatusDecoy: count('[data-test="decoy-status"] img[data-status-anim]'),
    inSidebarClass: count('[class*="sidebar" i] img[data-status-anim]'),
    inLegitRow: count('[data-chat-running] > [class*="_runningContent"] img[data-status-anim]'),
  };
})()`)

const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(`${DIR}\\verify-decoys.png`, Buffer.from(shot.data, 'base64'))
ws.close()
writeFileSync(`${DIR}\\verify-decoys.json`, JSON.stringify(out, null, 2))
console.log(JSON.stringify(out, null, 2))
const m = out.mk
const ok = m.total === 1 && m.inSidebarDecoy === 0 && m.inThinkDecoy === 0 && m.inStatusDecoy === 0 && m.inSidebarClass === 0 && m.inLegitRow === 1
console.log(ok ? 'RESULT PASS' : 'RESULT FAIL')
process.exitCode = ok ? 0 : 1
