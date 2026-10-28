/**
 * 真实结构验证（不改 profile）：在真实 GUI 页面里，把「修改后的 lib/client.js」注入运行，
 * 用复刻 app.asar 里 RunningStatus 的真实 DOM（data-chat-running > visuallyHidden[role=status] +
 * runningDivider + runningContent > runningText）验证修复是否命中并插到 runningContent。
 *
 * profile 里已部署的旧实例会往 1px 隐藏 span 里插图（这就是 bug），
 * 本脚本先记录这一事实作为 root-cause 实证，再用高频清理器移除隐藏 span 里的旧 img，
 * 保证新实例的幂等判定不被旧实例干扰。
 *
 * 用法：node test/verify-real-dom.mjs <guiUrl> <cdpPort>
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash, createHmac } from 'node:crypto'

const guiUrl = process.argv[2] ?? 'http://127.0.0.1:54109'
const port = Number(process.argv[3] ?? 9333)
const DIR = 'C:\\Users\\14023\\myproject\\dsh-status-anim\\assets'
const CLIENT_SRC = readFileSync('C:\\Users\\14023\\myproject\\dsh-status-anim\\lib\\client.js', 'utf8')

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
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 700)); return r.result.value }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Network.setCookie', { name: cname, value: cval, url: guiUrl, path: '/', httpOnly: true, sameSite: 'Strict' })
await send('Page.navigate', { url: guiUrl })
await send('Page.bringToFront')
await sleep(10000)
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
await sleep(8000)
await ev(`document.querySelectorAll('.dsu-root').forEach(function(e){e.remove()})`)
await sleep(500)

const out = {}
out.boot = await ev(`(function(){
  var ids=((window.__DSH_BOOT__||{}).entries||[]).map(function(e){return e.id});
  return { inGraph: ids.indexOf('dsh-status-anim')>=0, gears: document.querySelectorAll('[data-status-anim-ui="gear"]').length,
           deployedHasPreview: document.querySelectorAll('[data-status-anim-ui="preview"]').length };
})()`)

await ev(`(function(){
  localStorage.setItem('dsh-status-anim.size','30');
  localStorage.setItem('dsh-status-anim.picked','diving.gif');
  localStorage.setItem('dsh-status-anim.enabled','1');
})()`)

// A) 造真实结构状态行（逐字复刻 RunningStatus 的 DOM 与 CSS）
out.build = await ev(`(function(){
  var old=document.getElementById('sa-real'); if(old) old.remove();
  var oldSt=document.getElementById('sa-real-style'); if(oldSt) oldSt.remove();
  var st=document.createElement('style'); st.id='sa-real-style';
  st.textContent=[
    '.V4vHZW_running{--dsh-chat-flow-gap:12px;color:#6b86ff;font-size:13px;line-height:22px;flex-direction:column;align-items:flex-start;display:flex}',
    '.BpRApG_visuallyHidden{clip:rect(0 0 0 0);white-space:nowrap;width:1px;height:1px;position:absolute;overflow:hidden}',
    '.V4vHZW_runningDivider{background:#2a2f36;pointer-events:none;width:100%;height:.5px;margin:8px 0 10px;display:none}',
    '.V4vHZW_runningContent{align-items:center;gap:6px;min-width:0;display:inline-flex}',
    '.V4vHZW_runningText{font-variant-numeric:tabular-nums;min-width:0}',
    '.V4vHZW_runningIcon{width:14px;height:14px;flex:none;display:inline-flex;position:relative;overflow:hidden;background:#4d6bfe;border-radius:3px}',
    '#sa-real{position:fixed;left:90px;top:420px;width:720px;z-index:2147482000;background:#0e1216;color:#dfe3e8;border-radius:12px;padding:20px 24px;font:14px/1.6 system-ui,-apple-system,sans-serif}'
  ].join('');
  document.head.appendChild(st);

  var col=document.createElement('div'); col.className='V4vHZW_column'; col.setAttribute('data-chat-flow',''); col.id='sa-real';
  var run=document.createElement('div'); run.className='V4vHZW_running'; run.setAttribute('data-chat-running','');
  var hidden=document.createElement('span'); hidden.className='BpRApG_visuallyHidden';
  hidden.setAttribute('role','status'); hidden.setAttribute('aria-live','polite'); hidden.setAttribute('aria-atomic','true');
  hidden.textContent='深度求索中';
  var div=document.createElement('span'); div.className='V4vHZW_runningDivider'; div.setAttribute('aria-hidden','true');
  var content=document.createElement('span'); content.className='V4vHZW_runningContent';
  var icon=document.createElement('span'); icon.className='V4vHZW_runningIcon';
  var txt=document.createElement('span'); txt.className='V4vHZW_runningText'; txt.textContent='深度求索中，用时 52 秒 ···';
  content.appendChild(icon); content.appendChild(txt);
  run.appendChild(hidden); run.appendChild(div); run.appendChild(content);
  col.appendChild(run); document.body.appendChild(col);
  return {html: run.outerHTML.slice(0,480)};
})()`)

// B) root-cause 实证：等旧实例（profile 部署版）扫描一轮，看它插到哪
await sleep(3200)
out.oldBehaviour = await ev(`(function(){
  var host=document.querySelector('[data-chat-running]');
  var hidden=host.querySelector('[class*="_visuallyHidden"]');
  var content=host.querySelector('[class*="_runningContent"]');
  var hr=hidden.getBoundingClientRect();
  return {
    imgInHiddenSpan: hidden.querySelectorAll('img[data-status-anim]').length,
    imgInRunningContent: content.querySelectorAll('img[data-status-anim]').length,
    hiddenSpanRect: [Math.round(hr.width), Math.round(hr.height)],
    note: 'imgInHiddenSpan>0 且 rect=1x1 → 旧实例确实插进了不可见的 1px span'
  };
})()`)

// C) 注入修改后的 client.js（stub 住 ModuleLoader 取 factory，不注册第二次）
out.inject = await ev(`(function(){
  try{
    var out={};
    var orig = window.__ModuleLoader__.load;
    window.__ModuleLoader__.load = function(m){ window.__saTest={id:m.id, factory:m.factory}; };
    try {
      ${CLIENT_SRC}
    } finally {
      window.__ModuleLoader__.load = orig;
    }
    var f = window.__saTest && window.__saTest.factory;
    if(!f) return {ok:false, why:'factory not captured'};
    var ex = f(function(){ throw new Error('no require'); });
    out.exports = Object.keys(ex||{});
    out.hasInternals = !!(ex && ex.__internals);
    ex.apply({ effect: function(fn){ fn(); } });
    out.applied = true;
    return out;
  }catch(e){ return {ok:false, err: String(e && e.stack || e).slice(0,600)}; }
})()`)

// 清掉旧实例插在 1px hidden span 里的 img，避免干扰新实例的幂等判定
await ev(`(function(){
  window.__saClean = setInterval(function(){
    var h=document.querySelector('[data-chat-running] [class*="_visuallyHidden"]');
    if(h){ h.querySelectorAll('img[data-status-anim]').forEach(function(i){ i.remove(); }); }
  }, 80);
  return true;
})()`)

await sleep(5000)

out.result = await ev(`(function(){
  var host=document.querySelector('[data-chat-running]');
  var content=host.querySelector('[class*="_runningContent"]');
  var txt=host.querySelector('[class*="_runningText"]');
  var imgs=content.querySelectorAll('img[data-status-anim="1"]');
  var img=imgs[0]||null;
  var r=img?img.getBoundingClientRect():null;
  var tr=txt?txt.getBoundingClientRect():null;
  return {
    imgCountInRunningContent: imgs.length,
    imgCountInHost: host.querySelectorAll('img[data-status-anim="1"]').length,
    imgCountInHiddenSpan: host.querySelector('[class*="_visuallyHidden"]').querySelectorAll('img').length,
    src: img?img.getAttribute('src'):null,
    size: img?[img.style.width, img.style.height]:null,
    natural: img?[img.naturalWidth, img.naturalHeight]:null,
    rect: r?[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)]:null,
    textRect: tr?[Math.round(tr.x),Math.round(tr.y)]:null,
    isFirstChildOfContent: img? content.firstElementChild===img : false,
    hostHtml: host.outerHTML.slice(0,700)
  };
})()`)

out.idem = await ev(`(async function(){
  await new Promise(function(r){setTimeout(r,3600)});
  var host=document.querySelector('[data-chat-running]');
  var c=host.querySelector('[class*="_runningContent"]');
  return { count: c.querySelectorAll('img[data-status-anim="1"]').length };
})()`)

// D) 面板实时预览
out.panel = await ev(`(function(){
  var gears=document.querySelectorAll('[data-status-anim-ui="gear"]');
  if(gears.length===0) return {gear:false};
  gears[gears.length-1].click();
  var panels=document.querySelectorAll('[data-status-anim-ui="panel"]');
  var p=panels[panels.length-1];
  if(!p) return {panel:false, gears:gears.length};
  var img=p.querySelector('[data-status-anim-ui="preview"] img');
  var sl=p.querySelector('input[type=range]');
  if(sl){ sl.value='64'; sl.dispatchEvent(new Event('input',{bubbles:true})); }
  var img2=p.querySelector('[data-status-anim-ui="preview"] img');
  return { panel:true, gears:gears.length,
    previewImg: img?{src:img.getAttribute('src'), w:img.style.width, h:img.style.height}:null,
    afterSlider: img2?{w:img2.style.width, h:img2.style.height}:null,
    hasCaption: p.querySelector('[data-status-anim-ui="caption"]')!==null };
})()`)
await sleep(1500)

// 截图
const box = await ev(`(function(){var e=document.getElementById('sa-real');var r=e.getBoundingClientRect();
  return {x:Math.max(0,r.x-12),y:Math.max(0,r.y-12),width:Math.min(innerWidth-4,r.width+24),height:Math.min(innerHeight-4,r.height+24)}})()`)
const s1 = await send('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 3 } })
writeFileSync(`${DIR}\\fix-real-statusline-zoom.png`, Buffer.from(s1.data, 'base64'))
const s2 = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(`${DIR}\\fix-real-fullpage.png`, Buffer.from(s2.data, 'base64'))

await ev(`clearInterval(window.__saClean)`)
ws.close()
writeFileSync(`${DIR}\\fix-verify.json`, JSON.stringify(out, null, 2))
console.log(JSON.stringify(out, null, 2).slice(0, 6000))
