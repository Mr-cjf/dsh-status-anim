/**
 * CDP 探针二：验证 localStorage 配置项 dsh-status-anim.size / enabled 生效。
 * 用法：node test/e2e-settings.mjs <guiUrl> [cdpPort]
 */
const guiUrl = process.argv[2]
const port = Number(process.argv[3] ?? 9223)

const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', rej, { once: true })
})

let seq = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  const w = pending.get(m.id)
  if (w !== undefined) {
    pending.delete(m.id)
    m.error === undefined ? w.resolve(m.result) : w.reject(new Error(JSON.stringify(m.error)))
  }
})
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails !== undefined) throw new Error(JSON.stringify(r.exceptionDetails))
  return r.result.value
}

const out = []
const check = (label, ok, detail) => out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)

await send('Runtime.enable')
await send('Page.enable')
await send('Page.navigate', { url: guiUrl })
await new Promise((r) => setTimeout(r, 9000))

// 设 size=32 后刷新，图片应按 32px 渲染
await evaluate(`localStorage.setItem('dsh-status-anim.size','32')`)
await send('Page.reload')
await new Promise((r) => setTimeout(r, 9000))

const sized = await evaluate(`(async function(){
  var flow=document.createElement('div'); flow.setAttribute('data-chat-flow','1');
  var row=document.createElement('div'); row.setAttribute('role','status'); row.setAttribute('aria-live','polite');
  row.textContent='Deep diving...'; flow.appendChild(row); document.body.appendChild(flow);
  await new Promise(function(r){setTimeout(r,3500)});
  var img=row.querySelector('img[data-status-anim="1"]');
  return img===null?{found:false}:{found:true,width:img.style.width,height:img.style.height};
})()`)
check('size=32 生效', sized.found === true && sized.width === '32px', JSON.stringify(sized))

// enabled=0 后刷新，不应插入
await evaluate(`localStorage.setItem('dsh-status-anim.enabled','0')`)
await send('Page.reload')
await new Promise((r) => setTimeout(r, 9000))
const disabled = await evaluate(`(async function(){
  var flow=document.createElement('div'); flow.setAttribute('data-chat-flow','1');
  var row=document.createElement('div'); row.setAttribute('role','status'); row.setAttribute('aria-live','polite');
  row.textContent='Deep diving...'; flow.appendChild(row); document.body.appendChild(flow);
  await new Promise(function(r){setTimeout(r,4000)});
  return { count: row.querySelectorAll('img[data-status-anim="1"]').length };
})()`)
check('enabled=0 时不插入', disabled.count === 0, `count=${disabled.count}`)

// 复位
await evaluate(`localStorage.removeItem('dsh-status-anim.size'); localStorage.removeItem('dsh-status-anim.enabled')`)

ws.close()
console.log(out.join('\n'))
const failed = out.filter((l) => l.startsWith('FAIL')).length
console.log(`\n${out.length - failed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1
