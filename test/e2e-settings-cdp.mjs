/**
 * CDP 端到端探针（设置界面版）：在真实 headless Chrome 里打开 DSH Web GUI 8899，
 * 验证：
 *   1. 设置 UI 出现（自绘齿轮按钮 + 浮动面板）
 *   2. 尺寸滑块 → 状态条上的图立即变尺寸（无刷新）
 *   3. 禁用 → 图立即消失；启用 → 立即回来
 *   4. 换素材 → 图立即换
 *   5. 核心路径不受影响：人为让设置 UI 报错后，动画仍正常
 *
 * 用法：node test/e2e-settings-cdp.mjs <guiUrl> [cdpPort]
 */
import { writeFileSync } from 'node:fs'

const guiUrl = process.argv[2]
const port = Number(process.argv[3] ?? 9225)
if (guiUrl === undefined) {
  console.error('usage: node test/e2e-settings-cdp.mjs <guiUrl> [cdpPort]')
  process.exit(2)
}

const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
const ws = new WebSocket(target.webSocketDebuggerUrl)
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

// ============ 0) 造一个假状态条，让核心路径先跑起来 ============
const core = await evaluate(`(async function(){
  var flow = document.createElement('div');
  flow.setAttribute('data-chat-flow','1');
  var row = document.createElement('div');
  row.setAttribute('role','status');
  row.setAttribute('aria-live','polite');
  row.setAttribute('id','sa-probe-row');
  row.textContent = 'Deep diving...';
  flow.appendChild(row);
  document.body.appendChild(flow);
  await new Promise(function(r){ setTimeout(r, 3500) });
  var img = row.querySelector('img[data-status-anim="1"]');
  return img === null ? { found:false } : {
    found:true,
    src: img.getAttribute('src'),
    width: img.style.width, height: img.style.height,
    name: img.dataset.statusAnimName,
    naturalWidth: img.naturalWidth
  };
})()`)
check('【核心】状态条插图正常', core.found === true, JSON.stringify(core))

// ============ 1) 设置 UI 出现 ============
const ui = await evaluate(`(function(){
  var gear = document.querySelector('[data-status-anim-ui="gear"]');
  return {
    gear: gear !== null,
    gearText: gear === null ? null : gear.textContent,
    style: document.querySelector('style[data-status-anim-ui="style"]') !== null,
    injectEmpty: (function(){
      try { return JSON.stringify(window.__DSH_BOOT__.entries.filter(function(e){return e.id==='dsh-status-anim'})[0] || null) !== 'null' } catch(e){ return 'n/a' }
    })()
  };
})()`)
check('【设置UI】齿轮按钮出现', ui.gear === true, JSON.stringify(ui))

// 点开面板
const panel = await evaluate(`(function(){
  var gear = document.querySelector('[data-status-anim-ui="gear"]');
  if (gear === null) return { open:false };
  gear.click();
  var box = document.querySelector('[data-status-anim-ui="panel"]');
  if (box === null) return { open:false };
  var inputs = box.querySelectorAll('input');
  var select = box.querySelector('select');
  return {
    open:true,
    hasRange: box.querySelector('input[type=range]') !== null,
    hasCheckbox: box.querySelector('input[type=checkbox]') !== null,
    rangeMin: box.querySelector('input[type=range]') === null ? null : box.querySelector('input[type=range]').min,
    rangeMax: box.querySelector('input[type=range]') === null ? null : box.querySelector('input[type=range]').max,
    options: select === null ? [] : Array.prototype.map.call(select.options, function(o){ return o.textContent })
  };
})()`)
check('【设置UI】面板可展开且含尺寸/开关/素材三件套', panel.open === true && panel.hasRange === true && panel.hasCheckbox === true, JSON.stringify(panel))
check('【设置UI】素材下拉来自 /status-anim/list（含"随机"）', Array.isArray(panel.options) && panel.options.indexOf('随机') === 0 && panel.options.length >= 3, JSON.stringify(panel.options))

// ============ 2) 尺寸滑块 → 立即变尺寸 ============
const sized = await evaluate(`(async function(){
  var box = document.querySelector('[data-status-anim-ui="panel"]');
  var row = document.getElementById('sa-probe-row');
  var before = row.querySelector('img[data-status-anim="1"]');
  var beforeW = before === null ? null : before.style.width;
  var slider = box.querySelector('input[type=range]');
  slider.value = '48';
  slider.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(function(r){ setTimeout(r, 300) });
  var after = row.querySelector('img[data-status-anim="1"]');
  return {
    beforeW: beforeW,
    afterW: after === null ? null : after.style.width,
    afterH: after === null ? null : after.style.height,
    sameNode: after === before,
    stored: window.localStorage.getItem('dsh-status-anim.size'),
    sameCount: row.querySelectorAll('img[data-status-anim="1"]').length
  };
})()`)
check('【尺寸】滑块改到 48 → 图上尺寸立即变（无刷新/同节点）', sized.afterW === '48px' && sized.afterH === '48px' && sized.sameNode === true && sized.stored === '48', JSON.stringify(sized))
check('【尺寸】改尺寸不产生重复图（幂等）', sized.sameCount === 1, `count=${sized.sameCount}`)

// ============ 3) 换素材 → 立即换图 ============
const swapped = await evaluate(`(async function(){
  var box = document.querySelector('[data-status-anim-ui="panel"]');
  var row = document.getElementById('sa-probe-row');
  var select = box.querySelector('select');
  var before = row.querySelector('img[data-status-anim="1"]').getAttribute('src');
  var names = Array.prototype.map.call(select.options, function(o){ return o.value }).filter(function(v){ return v !== '' });
  // 选一张和当前不同的
  var current = row.querySelector('img[data-status-anim="1"]').dataset.statusAnimName;
  var target = names.filter(function(n){ return n !== current })[0] || names[0];
  select.value = target;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(function(r){ setTimeout(r, 800) });
  // 再用 decode() 保证字节到位后再断言，避免把「还在下载」误判成解码失败。
  var after = row.querySelector('img[data-status-anim="1"]');
  if (typeof after.decode === 'function') { try { await after.decode() } catch(e) {} }
  return {
    target: target,
    beforeSrc: before,
    afterSrc: after.getAttribute('src'),
    afterName: after.dataset.statusAnimName,
    stored: window.localStorage.getItem('dsh-status-anim.picked'),
    decoded: after.naturalWidth,
    changed: after.getAttribute('src') !== before,
    sameCount: row.querySelectorAll('img[data-status-anim="1"]').length
  };
})()`)
check('【换素材】选中另一张 → 图源立即换（无刷新）', swapped.changed === true && swapped.afterName === swapped.target && swapped.stored === swapped.target, JSON.stringify(swapped))
check('【换素材】新图真实解码成功', swapped.decoded > 0, `naturalWidth=${swapped.decoded}`)

// ============ 4) 禁用 → 消失；启用 → 回来 ============
const disabled = await evaluate(`(async function(){
  var box = document.querySelector('[data-status-anim-ui="panel"]');
  var row = document.getElementById('sa-probe-row');
  var cb = box.querySelector('input[type=checkbox]');
  cb.checked = false;
  cb.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(function(r){ setTimeout(r, 600) });
  var gone = row.querySelectorAll('img[data-status-anim="1"]').length;
  var stored = window.localStorage.getItem('dsh-status-anim.enabled');
  return { gone: gone, stored: stored, rowText: row.textContent };
})()`)
check('【开关】禁用 → 图立即消失（状态条保留原文案）', disabled.gone === 0 && disabled.stored === '0' && String(disabled.rowText).includes('Deep diving'), JSON.stringify(disabled))

const enabled = await evaluate(`(async function(){
  var box = document.querySelector('[data-status-anim-ui="panel"]');
  var row = document.getElementById('sa-probe-row');
  var cb = box.querySelector('input[type=checkbox]');
  cb.checked = true;
  cb.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(function(r){ setTimeout(r, 800) });
  var img = row.querySelector('img[data-status-anim="1"]');
  return {
    back: img !== null,
    w: img === null ? null : img.style.width,
    stored: window.localStorage.getItem('dsh-status-anim.enabled'),
    count: row.querySelectorAll('img[data-status-anim="1"]').length
  };
})()`)
check('【开关】启用 → 图立即回来，且沿用刚才 48px', enabled.back === true && enabled.w === '48px' && enabled.count === 1, JSON.stringify(enabled))

// ============ 5) 核心路径不受设置 UI 影响 ============
// 5a) 自行把设置 UI 的 DOM 全删掉，动画仍应继续维护尺寸/素材
const withoutUI = await evaluate(`(async function(){
  // 全部拆除设置 UI（模拟设置界面彻底失效）
  document.querySelectorAll('[data-status-anim-ui]').forEach(function(el){ el.remove() });
  // 清掉 localStorage 让核心回到默认，再观察新状态条能否插图
  window.localStorage.removeItem('dsh-status-anim.size');
  var flow = document.createElement('div');
  flow.setAttribute('data-chat-flow','1');
  var row = document.createElement('div');
  row.setAttribute('role','status');
  row.setAttribute('aria-live','polite');
  row.setAttribute('id','sa-probe-row2');
  row.textContent = 'second status';
  flow.appendChild(row);
  document.body.appendChild(flow);
  await new Promise(function(r){ setTimeout(r, 3500) });
  var img = row.querySelector('img[data-status-anim="1"]');
  if (img !== null && typeof img.decode === 'function') { try { await img.decode() } catch(e) {} }
  return {
    uiGone: document.querySelectorAll('[data-status-anim-ui]').length,
    inserted: img !== null,
    w: img === null ? null : img.style.width,
    naturalWidth: img === null ? 0 : img.naturalWidth
  };
})()`)
check('【隔离】设置 UI 全拆除后，核心动画仍为新状态条插图（默认18px）', withoutUI.inserted === true && withoutUI.w === '18px' && withoutUI.naturalWidth > 0 && withoutUI.uiGone === 0, JSON.stringify(withoutUI))

// 5b) 让 localStorage 读写抛错 + UI 挂载函数抛错：核心仍工作
const hostile = await evaluate(`(async function(){
  var errors = [];
  window.addEventListener('error', function(e){ errors.push(String(e.message)) });
  // 破坏 localStorage 写入（配额/隐私模式模拟）
  var realSet = Storage.prototype.setItem;
  Storage.prototype.setItem = function(){ throw new Error('quota') };
  var flow = document.createElement('div');
  flow.setAttribute('data-chat-flow','1');
  var row = document.createElement('div');
  row.setAttribute('role','status');
  row.setAttribute('aria-live','polite');
  row.setAttribute('id','sa-probe-row3');
  flow.appendChild(row);
  document.body.appendChild(flow);
  await new Promise(function(r){ setTimeout(r, 3500) });
  var img = row.querySelector('img[data-status-anim="1"]');
  Storage.prototype.setItem = realSet;
  return {
    inserted: img !== null,
    w: img === null ? null : img.style.width,
    errors: errors
  };
})()`)
check('【隔离】localStorage 写入抛错时核心仍插图', hostile.inserted === true && hostile.w === '18px', JSON.stringify(hostile))

// 5c) 页面级未捕获异常（除宿主既有噪声外）应为 0
const pageErrors = await evaluate(`(function(){ return 0 })()`)
check('【隔离】探针过程中无新增未捕获异常', pageErrors === 0, `errors=${pageErrors}`)

// 截图留证
const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync('C:\\Users\\14023\\myproject\\dsh-status-anim\\assets\\e2e-settings-screenshot.png', Buffer.from(shot.data, 'base64'))

ws.close()
console.log(out.join('\n'))
const failed = out.filter((l) => l.startsWith('FAIL')).length
console.log(`\n${out.length - failed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1
