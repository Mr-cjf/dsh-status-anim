/** 决定性对照：独立 <img> 加载同一 GIF 是否动画 + pointer-events 检查。 */
import { writeFileSync } from 'node:fs'

const t = await (await fetch('http://127.0.0.1:9333/json/new?about:blank', { method: 'PUT' })).json()
const ws = new WebSocket(t.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }) })
let seq = 0; const pend = new Map()
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); const w = pend.get(m.id); if (w) { pend.delete(m.id); m.error ? w.reject(new Error(JSON.stringify(m.error))) : w.resolve(m.result) } })
const send = (m, p = {}) => new Promise((res, rej) => { const id = ++seq; pend.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method: m, params: p })) })
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value }

await send('Runtime.enable'); await send('Page.enable')
await send('Page.navigate', { url: 'http://127.0.0.1:62811/status-anim/file/diving.gif' })
await new Promise((r) => setTimeout(r, 4000))
const out = await ev(`(async function(){
  var img = document.querySelector('img');
  if (img === null) return { noImg: true, html: document.documentElement.outerHTML.slice(0,200) };
  var c=document.createElement('canvas'); c.width=72; c.height=72; var ctx=c.getContext('2d');
  function snap(){ ctx.clearRect(0,0,72,72); ctx.drawImage(img,0,0,72,72); return Array.from(ctx.getImageData(0,0,72,72).data) }
  var f=[]; for(var k=0;k<6;k++){ f.push(snap()); await new Promise(function(r){setTimeout(r,220)}); }
  function diff(a,b){var d=0;for(var i=0;i<a.length;i++){if(a[i]!==b[i])d++}return d}
  var ds=[]; for(var k=1;k<f.length;k++) ds.push(diff(f[k-1],f[k]));
  var r=img.getBoundingClientRect();
  return { standalone:true, rect:{w:r.width,h:r.height}, natural: img.naturalWidth+'x'+img.naturalHeight, frameDiffs: ds, animated: ds.some(function(d){return d>50}) };
})()`)
console.log(JSON.stringify(out, null, 2))
ws.close()
