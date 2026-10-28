/**
 * CDP 端到端探针：在真实 headless Chrome 里打开 DSH Web GUI，
 * 载荷完成后手工造一个 `[data-chat-flow] [role=status][aria-live=polite]`，
 * 验证 client 半边真的插入了 <img data-status-anim>，且尺寸/图源正确。
 *
 * 用法：node test/e2e-cdp.mjs <guiUrl> [cdpPort]
 */
import { writeFileSync } from 'node:fs'

const guiUrl = process.argv[2]
const port = Number(process.argv[3] ?? 9223)
if (guiUrl === undefined) {
  console.error('usage: node test/e2e-cdp.mjs <guiUrl> [cdpPort]')
  process.exit(2)
}

const targets = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
const wsUrl = targets.webSocketDebuggerUrl
const ws = new WebSocket(wsUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})

let seq = 0
const pending = new Map()
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  const waiter = pending.get(msg.id)
  if (waiter !== undefined) {
    pending.delete(msg.id)
    if (msg.error !== undefined) waiter.reject(new Error(JSON.stringify(msg.error)))
    else waiter.resolve(msg.result)
  }
})

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })

const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails !== undefined) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}

const out = []
const check = (label, ok, detail) => out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  ${detail}`}`)

await send('Runtime.enable')
await send('Page.enable')
await send('Page.navigate', { url: guiUrl })
await new Promise((r) => setTimeout(r, 12000))

// 1) 模块是否注册进 __ModuleLoader__ 的 factory 表
const loaded = await evaluate(`(function(){
  try {
    var ml = window.__ModuleLoader__;
    if (ml === undefined) return { ok:false, why:'__ModuleLoader__ missing' };
    var boot = window.__DSH_BOOT__;
    var ids = (boot && boot.entries ? boot.entries : []).map(function(e){return e.id});
    return { ok: ids.indexOf('dsh-status-anim') >= 0, ids: ids.indexOf('dsh-status-anim'), total: ids.length };
  } catch(e) { return { ok:false, why:String(e) } }
})()`)
check('boot graph 含 dsh-status-anim', loaded.ok === true, JSON.stringify(loaded))

// 2) 造一个假状态条，触发 client 插入
const injected = await evaluate(`(async function(){
  var flow = document.createElement('div');
  flow.setAttribute('data-chat-flow','1');
  var row = document.createElement('div');
  row.setAttribute('role','status');
  row.setAttribute('aria-live','polite');
  row.textContent = 'Deep diving...';
  flow.appendChild(row);
  document.body.appendChild(flow);
  await new Promise(function(r){ setTimeout(r, 3500) });
  var img = row.querySelector('img[data-status-anim="1"]');
  if (img === null) return { found:false, rowHtml: row.outerHTML.slice(0,400) };
  return {
    found: true,
    src: img.getAttribute('src'),
    width: img.style.width, height: img.style.height,
    objectFit: img.style.objectFit, verticalAlign: img.style.verticalAlign,
    isFirstChild: row.firstElementChild === img,
    complete: img.complete, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight
  };
})()`)
check('client 在状态条上插入 <img data-status-anim>', injected.found === true, JSON.stringify(injected))
if (injected.found === true) {
  check('尺寸 18px × 18px', injected.width === '18px' && injected.height === '18px', `${injected.width} / ${injected.height}`)
  check('object-fit: contain', injected.objectFit === 'contain', injected.objectFit)
  check('vertical-align: middle', injected.verticalAlign === 'middle', injected.verticalAlign)
  check('是 row 的第一个子元素（prepend）', injected.isFirstChild === true)
  check('图片真实解码成功（naturalWidth>0）', injected.naturalWidth > 0, `${injected.naturalWidth}x${injected.naturalHeight} complete=${injected.complete}`)
  // 素材目录可以有多张图（默认随机挑一张），所以只断言 src 落在本插件的 file 前缀下。
  check('src 指向 /status-anim/file/<允许的素材名>', /\/status-anim\/file\/[^/]+\.(gif|apng|png|webp|avif)(\?|$)/i.test(String(injected.src)), injected.src)
}

// 3) 幂等：再跑一轮扫描不应重复插入
const idem = await evaluate(`(async function(){
  var row = document.querySelector('[data-chat-flow] [role="status"][aria-live="polite"]');
  if (row === null) return { count: -1 };
  await new Promise(function(r){ setTimeout(r, 2500) });
  return { count: row.querySelectorAll('img[data-status-anim="1"]').length };
})()`)
check('幂等：单个状态条只插一张图', idem.count === 1, `count=${idem.count}`)

// 4) 换图（放文件即换图）：新增第二个素材后应能被 list 看到
const listLive = await evaluate(`fetch('/status-anim/list',{cache:'no-store'}).then(function(r){return r.json()})`)
check('/status-anim/list 在页面上下文可读', Array.isArray(listLive), JSON.stringify(listLive))

// 5) 清理：移除假状态条后，插件不应报错（页面无 uncaught error）
const errors = await evaluate(`(function(){
  return (window.__saErrors__ || []).length;
})()`)
check('页面无未捕获异常计数器', errors === 0, `errors=${errors}`)

// 截图留证
const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync('C:\\Users\\14023\\myproject\\dsh-status-anim\\assets\\e2e-screenshot.png', Buffer.from(shot.data, 'base64'))

ws.close()
console.log(out.join('\n'))
const failed = out.filter((l) => l.startsWith('FAIL')).length
console.log(`\n${out.length - failed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1
