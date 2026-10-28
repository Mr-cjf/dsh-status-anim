/**
 * dsh-status-anim — Web 客户端半边（类型化参照源码）
 *
 * ⚠️ 本文件**不是构建输入**。运行产物是手写的 `lib/client.js`（见 README「开发说明」）。
 * 改行为请改 `lib/client.js`；本文件用于类型检查、IDE 跳转与阅读。
 *
 * 载体契约（对齐 DSH 0.2.1-rc.3）：
 *   window.__ModuleLoader__.load({ id: <包名>, factory })
 *   id 必须等于包名 —— dsh-client-modules 用包名作 boot graph 行 id。
 *
 * inject 为空数组：rc.3 无 settingsScope（实际叫 configForms），本插件不需要任何客户端服务。
 *
 * 【两条完全隔离的执行路径】
 *   路径 A（核心，必须永远工作）：素材列表 + MutationObserver + prepend <img>，零服务依赖。
 *   路径 B（设置 UI，允许失败）：自绘浮动面板（齿轮按钮 + 卡片），整体 try/catch + 延后一拍挂载。
 *
 * 为什么不用原生 `plugins.item` 槽位：
 *   dsh-client-ui-settings-shell/lib/client.js:182-189 要求
 *   `ctx.configForms.whileServed(...)` + `ctx.slots.inject("plugins.item", () => ctx.slots.register({...}, Card))`，
 *   卡片必须是 React 组件（require("react/jsx-runtime")，用 props.view / props.hooks 渲染）；
 *   而服务的声明是全模块唯一的 `exports.inject`（同文件 :161-165 `const inject = ["slots","locale","configForms"]`）。
 *   cordis 的 fiber 依赖是全有或全无：为设置 UI inject 服务，核心路径也会一起背上依赖，
 *   任一部署缺服务 → 整条 fiber 不 apply → 动画一起死。故改用自绘面板，`inject: []` 护城河不破。
 */

import type { Context } from '@deepseek-ai/cordis'

export const inject: string[] = []

/**
 * 状态条候选选择器（多路回退，从「最精确」到「最宽松」）。
 *
 * 真实 DOM（从运行中的 app.asar 里 @deepseek-ai/dsh-client-ui-chat/lib/client.js 的
 * RunningStatus 组件读出的）：
 *
 *   <div class="V4vHZW_running" data-chat-running>
 *     <span class="BpRApG_visuallyHidden" role="status" aria-live="polite" aria-atomic="true">
 *       深度求索中                      ← 1px×1px / clip:rect(0 0 0 0)，看不见
 *     </span>
 *     <span class="V4vHZW_runningDivider" aria-hidden="true"></span>
 *     <span class="V4vHZW_runningContent">
 *       <RunningWhaleTail/>            ← 鲸鱼尾巴
 *       <TextShimmer>深度求索中，用时 52 秒 ···</TextShimmer>  ← 用户看到的那行
 *     </span>
 *   </div>
 *
 * 旧选择器 `[data-chat-flow] [role="status"][aria-live="polite"]` 其实「能命中」，
 * 但命中的是那个 visuallyHidden 的 1px span —— 图插进去了却不可见，
 * 于是「深度求索中，用时 52 秒…」左侧永远空着。修复要点：命中后向可见宿主上浮，
 * 再插到 runningContent 的文本前面。
 */
const SELECTORS: string[] = [
  // 1) 最精确：真实宿主容器（aria-live 那个 1px span 的父级）
  '[data-chat-flow] [data-chat-running]',
  // 2) 去掉 data-chat-flow 限制，但仍要求 `data-chat-running` 这一状态行专属语义属性
  '[data-chat-running]',
]

/**
 * 已删除的宽泛回退（历史 bug 根因，务必别再恢复）：
 *
 *   '[role="status"][aria-live="polite"]' / '[role="status"]'
 *     → 侧边栏每个会话条目都有自己的「运行中」live region，思考块标题、动作行状态也带
 *       role=status；这些元素经 findHost() 上浮后落在「宽而矮」的列表行上
 *       （width≫100、height≤120，尺寸过滤全通过），
 *       于是同一张图被插到每个会话条目左侧和每个思考块里。
 *   '[class*="Status"]' / '[class*="_turnStatus"]'
 *     → *Contains* 匹配任意含 Status 的 class，命中面更不可控。
 *
 * 原则：宁可少插，不可错插 —— 宽泛回退整体删除，只保留带三重过滤的文本兜底。
 */

/** 禁止区域：命中这些祖先的元素一律不插图（侧边栏 / 会话列表 / 主导航 / 旁栏）。 */
const FORBIDDEN_ANCESTOR = [
  '[class*="sidebar" i]',
  '[class*="Session" i]',
  '[class*="session-list" i]',
  '[class*="threadList" i]',
  'nav',
  'aside',
]

/** 合并成一次 closest() 查询。 */
const FORBIDDEN_SELECTOR = FORBIDDEN_ANCESTOR.join(',')

/** 旧选择器保留（离线自检仍在断言它），运行时已改用 SELECTORS。 */
const SELECTOR = '[data-chat-flow] [role="status"][aria-live="polite"]'

/** 文本兜底正则：真实文案「深度求索中，用时 52 秒 ···」/「Deep diving…」。 */
const TEXT_RE = /深度求索中|Deep\s*diving|深度思考|深入思考/i

/** 可见宿主的尺寸上限：状态行只有一行文本。 */
const MAX_HOST_HEIGHT = 120

/** 可见宿主的最小宽度：排除侧栏窄条目。 */
const MIN_HOST_WIDTH = 100
const LIST_URL = '/status-anim/list'
const FILE_URL = '/status-anim/file/'
const MARK = 'data-status-anim'
const UI_MARK = 'data-status-anim-ui'
const DEFAULT_SIZE = 18
const MIN_SIZE = 8
const MAX_SIZE = 96
const LIST_TTL_MS = 2000
const POLL_MS = 1500

const KEY_SIZE = 'dsh-status-anim.size'
const KEY_ENABLED = 'dsh-status-anim.enabled'
const KEY_MOTION = 'dsh-status-anim.motion'
const KEY_PICKED = 'dsh-status-anim.picked'

/** 「随机」素材的取值（空串 = 由插件随机挑）。 */
const PICK_RANDOM = ''

function storage(): Storage | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

function readSetting(key: string): string | undefined {
  const store = storage()
  if (store === undefined) return undefined
  try {
    const value = store.getItem(key)
    return value === null ? undefined : value
  } catch {
    return undefined
  }
}

/** 写设置；失败静默（隐私模式 / 配额满时只丢设置，动画继续用旧值）。 */
function writeSetting(key: string, value: string): void {
  const store = storage()
  if (store === undefined) return
  try {
    store.setItem(key, value)
  } catch {
    // ignore
  }
}

/** 用户选中的素材名；空串表示随机。 */
export function readPicked(): string {
  const raw = readSetting(KEY_PICKED)
  return raw === undefined ? PICK_RANDOM : raw
}

export function readSize(): number {
  const raw = readSetting(KEY_SIZE)
  if (raw === undefined) return DEFAULT_SIZE
  const parsed = Number.parseFloat(raw)
  if (!Number.isFinite(parsed) || parsed < MIN_SIZE || parsed > MAX_SIZE) return DEFAULT_SIZE
  return Math.round(parsed)
}

export function isEnabled(): boolean {
  const raw = readSetting(KEY_ENABLED)
  if (raw === undefined) return true
  const value = raw.trim().toLowerCase()
  return !(value === '0' || value === 'false' || value === 'off' || value === 'no')
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

function motionForced(): boolean {
  const raw = readSetting(KEY_MOTION)
  return raw !== undefined && raw.trim().toLowerCase() === 'force'
}

interface State {
  names: string[]
  fetchedAt: number
  inflight: boolean
  inserted: Set<Element>
  observer: MutationObserver | null
  timer: number | null
  stopped: boolean
}

function createState(): State {
  return { names: [], fetchedAt: 0, inflight: false, inserted: new Set(), observer: null, timer: null, stopped: false }
}

/** 当前正在运行的 state（设置 UI 通过它即时改动画）；路径 B 失败时保持 null。 */
const live: { state: State | null } = { state: null }

async function freezeFirstFrame(url: string): Promise<string | undefined> {
  try {
    if (typeof window.createImageBitmap !== 'function') return undefined
    const blob = await (await fetch(url, { cache: 'no-store' })).blob()
    const bitmap = await window.createImageBitmap(blob)
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d')
    if (ctx === null) return undefined
    ctx.drawImage(bitmap, 0, 0)
    if (typeof bitmap.close === 'function') bitmap.close()
    return canvas.toDataURL('image/png')
  } catch {
    return undefined
  }
}

function refreshList(state: State): void {
  if (state.inflight) return
  const now = Date.now()
  if (state.fetchedAt !== 0 && now - state.fetchedAt < LIST_TTL_MS) return
  state.inflight = true
  fetch(LIST_URL, { cache: 'no-store' })
    .then((res) => {
      if (!res.ok) throw new Error(`status-anim: list ${String(res.status)}`)
      return res.json() as Promise<unknown>
    })
    .then((value) => {
      state.names = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : []
      state.fetchedAt = Date.now()
      // 首次拿到素材后补一轮扫描：否则要等下一次轮询才插图。
      if (state.names.length > 0 && !state.stopped) {
        window.setTimeout(() => {
          flush({ retarget: false })
        }, 0)
      }
    })
    .catch(() => {
      state.fetchedAt = Date.now()
    })
    .then(() => {
      state.inflight = false
    })
}

function pick(names: string[]): string | undefined {
  if (names.length === 0) return undefined
  const index = Math.floor(Math.random() * names.length)
  return names[index < 0 || index >= names.length ? 0 : index]
}

function createImage(name: string, size: number): HTMLImageElement {
  const img = document.createElement('img')
  img.setAttribute(MARK, '1')
  img.setAttribute('alt', '')
  img.setAttribute('aria-hidden', 'true')
  img.setAttribute('draggable', 'false')
  img.dataset.statusAnimName = name
  img.src = `${FILE_URL}${encodeURIComponent(name)}?t=${String(Date.now())}`
  const px = `${String(size)}px`
  img.style.width = px
  img.style.height = px
  img.style.objectFit = 'contain'
  img.style.verticalAlign = 'middle'
  img.style.flex = '0 0 auto'
  img.style.marginRight = '6px'
  img.style.display = 'inline-block'
  img.style.pointerEvents = 'none'
  img.style.userSelect = 'none'
  return img
}

function sweep(state: State): void {
  state.inserted.forEach((el) => {
    if (!el.isConnected) state.inserted.delete(el)
  })
}

/** 当前该用哪张素材：用户选中的（若仍存在）优先，否则随机。 */
function currentName(state: State): string | undefined {
  if (state.names.length === 0) return undefined
  const wanted = readPicked()
  if (wanted !== PICK_RANDOM && state.names.indexOf(wanted) >= 0) return wanted
  return pick(state.names)
}

/** 清掉所有已插入的图（禁用 / 清理时用）。 */
function removeAllImages(state: State): void {
  state.inserted.forEach((el) => {
    try {
      if (el.parentNode !== null) el.parentNode.removeChild(el)
    } catch {
      // ignore
    }
  })
  state.inserted.clear()
}

/**
 * 把设置改动就地同步到「已经插在页面上的」图（尺寸 / 素材）。
 * scan 的幂等逻辑会跳过已有图，所以必须显式改它们的 inline style 与 src。
 */
function refreshInserted(state: State, options?: { retarget?: boolean }): void {
  const opts = options ?? {}
  if (!isEnabled()) {
    removeAllImages(state)
    return
  }
  const px = `${String(readSize())}px`
  const name = currentName(state)
  state.inserted.forEach((el) => {
    if (!el.isConnected) return
    const img = el as HTMLImageElement
    img.style.width = px
    img.style.height = px
    // 只有「用户明确换了素材」或「这张图还没定过素材」才改 src；
    // 否则每轮刷新都会因随机挑到别的名字而换图。
    if (name !== undefined && (opts.retarget === true || !img.dataset.statusAnimName)) {
      img.dataset.statusAnimName = name
      img.src = `${FILE_URL}${encodeURIComponent(name)}?t=${String(Date.now())}`
    }
  })
}

/** 设置改动后的即时通道：就地更新已有图 → 全量重扫补齐新状态条。 */
function flush(options?: { retarget?: boolean }): void {
  const state = live.state
  if (state === null || state.stopped) return
  try {
    refreshInserted(state, options)
  } catch {
    // 就地更新失败也不能挡住下面的重扫。
  }
  safeScan(state)
}

/** 是否是「可见的状态行宿主」：一行文本、非 1px 的 visuallyHidden、非隐藏。 */
function isVisibleHost(el: Element | null): boolean {
  if (el === null) return false
  let rect: DOMRect
  try {
    rect = el.getBoundingClientRect()
  } catch {
    return false
  }
  if (rect.width < MIN_HOST_WIDTH) return false
  if (rect.height <= 0 || rect.height > MAX_HOST_HEIGHT) return false
  let style: CSSStyleDeclaration | null
  try {
    style = window.getComputedStyle(el)
  } catch {
    style = null
  }
  if (style !== null) {
    if (style.visibility === 'hidden' || style.display === 'none') return false
    if (style.clip !== 'auto' || style.clipPath === 'inset(50%)') return false
  }
  return (el.textContent ?? '').trim().length > 0
}

/** 从命中元素向上找可见宿主（旧选择器命中的是 1px 隐藏 span）。 */
function findHost(hit: Element): Element | null {
  let node: Element | null = hit
  for (let depth = 0; node !== null && depth < 8; depth += 1) {
    if (node === document.body || node === document.documentElement) return null
    if (isVisibleHost(node)) return node
    node = node.parentElement
  }
  return null
}

/** 是否位于禁止区域（侧边栏 / 会话列表 / nav / aside）。查询失败一律否决。 */
function inForbiddenZone(el: Element | null): boolean {
  if (el === null) return true
  try {
    return el.closest(FORBIDDEN_SELECTOR) !== null
  } catch {
    return true // 宁可少插
  }
}

/**
 * 严格判定「这确实是聊天主区里的状态行」：
 *   1) 含状态行文案（TEXT_RE），且文案长度 ≤ 80（排除会话标题+时间戳的条目）；
 *   2) 在聊天主区内：自身带 data-chat-running，或祖先命中 [data-chat-flow]；
 *   3) 祖先链不含禁止区域；
 *   4) 尺寸像状态行：宽 ≥ 200、高 20..60。
 */
function isStrictStatusRow(el: Element | null): boolean {
  if (el === null) return false
  if (inForbiddenZone(el)) return false
  const text = (el.textContent ?? '').trim()
  if (text.length === 0 || !TEXT_RE.test(text)) return false
  if (text.length > 80) return false
  const own = el.getAttribute('data-chat-running') !== null
  let inFlow = false
  try {
    inFlow = el.closest('[data-chat-flow]') !== null
  } catch {
    inFlow = false
  }
  if (!own && !inFlow) return false
  let rect: DOMRect
  try {
    rect = el.getBoundingClientRect()
  } catch {
    return false
  }
  if (rect.width < 200) return false
  if (rect.height < 20 || rect.height > 60) return false
  let style: CSSStyleDeclaration | null
  try {
    style = window.getComputedStyle(el)
  } catch {
    style = null
  }
  if (style !== null && (style.visibility === 'hidden' || style.display === 'none')) return false
  return true
}

/** 宿主内真正的插图挂点：优先 runningContent（inline-flex，紧贴文字左侧）。 */
function findMount(host: Element): Element {
  try {
    const content = host.querySelector('[class*="_runningContent"]')
    // 不再用 isVisibleHost 的宽高阈值卡挂点（inline-flex 窄于 100px 会被误判而退回宿主）。
    if (content !== null && !inForbiddenZone(content)) {
      const rect = content.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) return content
    }
  } catch {
    // ignore
  }
  return host
}

/**
 * 收集所有该插图的状态行宿主（精确优先 + 三重过滤）。
 * 精确路径命中即返回；不命中才走受限兜底；再不行才走文本兜底。
 * 任何一路都**不再做 findHost() 上浮** —— 上浮是误插的主要放大器。
 */
function collectHosts(): Element[] {
  const hosts: Element[] = []
  const push = (el: Element | null): void => {
    if (el === null || hosts.includes(el)) return
    if (!isStrictStatusRow(el)) return
    hosts.push(el)
  }

  const run = (selector: string): number => {
    let hits: NodeListOf<Element>
    try {
      hits = document.querySelectorAll(selector)
    } catch {
      return 0
    }
    const before = hosts.length
    for (const hit of Array.from(hits)) push(hit)
    return hosts.length - before
  }

  // 1) 精确：真实状态行容器。
  run(SELECTORS[0])
  if (hosts.length > 0) return hosts
  // 2) 受限兜底：丢了 data-chat-flow 祖先的部署。
  run(SELECTORS[1])
  if (hosts.length > 0) return hosts
  // 3) 文本兜底：只认 data-chat-flow 内、含状态行文案、尺寸像状态行的元素。
  let all: NodeListOf<Element>
  try {
    all = document.querySelectorAll('[data-chat-flow] *')
  } catch {
    return hosts
  }
  for (const el of Array.from(all)) {
    if (el.children.length > 2) continue
    if (!TEXT_RE.test(el.textContent ?? '')) continue
    push(el)
    if (hosts.length >= 2) break
  }
  return hosts
}

/**
 * 清理误插：把已经不在合法状态行内的 `img[data-status-anim]`（状态条图）从 DOM 删掉。
 * 刷新后即使有历史残留，也会在第一轮扫描被清干净。
 */
function pruneStrayImages(state: State): void {
  let strays: NodeListOf<Element>
  try {
    strays = document.querySelectorAll(`img[${MARK}="1"]`)
  } catch {
    return
  }
  for (const img of Array.from(strays)) {
    // 动作行图由 scanActions 的 ROW_MARK 幂等逻辑管；设置面板预览图不是插图。
    if (img.getAttribute(ROLE_ATTR) === 'action') continue
    if (img.closest(`[${UI_MARK}]`) !== null) continue
    let node: Element | null = img.parentElement
    let legitimate = false
    for (let depth = 0; node !== null && depth < 4; depth += 1) {
      if (isStrictStatusRow(node)) {
        legitimate = true
        break
      }
      node = node.parentElement
    }
    if (legitimate) continue
    try {
      if (img.parentNode !== null) img.parentNode.removeChild(img)
    } catch {
      // ignore
    }
    state.inserted.delete(img)
  }
}

function scan(state: State): void {
  if (state.stopped) return
  if (!isEnabled()) {
    // 关闭时把已插入的清掉，回到原生外观。
    removeAllImages(state)
    return
  }

  refreshList(state)
  sweep(state)

  // 每轮扫描先清理误插：历史残留 / React 重排后跑偏的图都会被删掉。
  try {
    pruneStrayImages(state)
  } catch {
    // 清理失败不能挡住正常插图。
  }

  let rows: Element[]
  try {
    rows = collectHosts()
  } catch {
    return
  }
  if (rows.length === 0) return

  const name = currentName(state)
  if (name === undefined) return

  const size = readSize()
  const still = prefersReducedMotion() && !motionForced()

  for (const host of rows) {
    // 幂等：只查宿主内部（含 runningContent 挂点）；不往上查父链，避免误跳过别处状态行。
    if (host.querySelector(`[${MARK}]`) !== null) continue
    const mount = findMount(host)
    const img = createImage(name, size)
    try {
      mount.prepend(img)
    } catch {
      continue
    }
    state.inserted.add(img)
    if (still) {
      void freezeFirstFrame(img.src).then((dataUrl) => {
        if (dataUrl !== undefined && img.isConnected) img.src = dataUrl
      })
    }
  }
}

function safeScan(state: State): void {
  const observer = state.observer
  if (observer !== null) observer.disconnect()
  try {
    scan(state)
  } catch {
    // 绝不把异常抛回宿主事件循环。
  }
  if (observer !== null && !state.stopped && document.body !== null) {
    try {
      observer.observe(document.body, { childList: true, subtree: true })
    } catch {
      // ignore
    }
  }
}

//#region 路径 B —— 设置 UI（自绘面板，可失败）
//
// 与路径 A 没有任何共享的可失败前置：不读 ctx 服务、不 require 宿主模块。
// 唯一耦合是 live.state；它为 null 时面板只是改不动动画，绝不会反过来影响路径 A。

/** 强制拉一次素材清单（设置 UI 用；不走 2s 节流，打开面板即最新）。 */
async function fetchNames(): Promise<string[]> {
  try {
    const res = await fetch(LIST_URL, { cache: 'no-store' })
    if (!res.ok) return []
    const value: unknown = await res.json()
    if (!Array.isArray(value)) return []
    return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  } catch {
    return []
  }
}

/** 面板样式（用 Canvas/Field 等系统色，天然适配深浅色主题）。 */
const PANEL_CSS = [
  '[data-status-anim-ui="gear"]{position:fixed;right:14px;bottom:96px;z-index:2147483000;',
  'width:28px;height:28px;padding:0;border-radius:50%;border:1px solid rgba(127,127,127,.45);',
  'background:rgba(127,127,127,.16);color:inherit;font-size:15px;line-height:1;cursor:pointer;',
  'opacity:.45;transition:opacity .15s}',
  '[data-status-anim-ui="gear"]:hover,[data-status-anim-ui="gear"][data-active="1"]{opacity:1}',
  '[data-status-anim-ui="panel"]{position:fixed;right:14px;bottom:132px;z-index:2147483001;',
  'width:250px;box-sizing:border-box;padding:12px 14px;border-radius:12px;',
  'border:1px solid rgba(127,127,127,.4);background:Canvas;color:CanvasText;',
  'font:12px/1.5 system-ui,-apple-system,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.28)}',
  '[data-status-anim-ui="title"]{margin:0 0 10px;font-size:13px;font-weight:600;',
  'display:flex;justify-content:space-between;align-items:center;gap:8px}',
  '[data-status-anim-ui="row"]{display:flex;align-items:center;gap:8px;margin:8px 0}',
  '[data-status-anim-ui="label"]{flex:0 0 auto;min-width:48px;opacity:.8}',
  '[data-status-anim-ui="row"] input[type=range]{flex:1;min-width:0}',
  '[data-status-anim-ui="row"] select{flex:1;min-width:0;background:Field;color:FieldText;',
  'border:1px solid rgba(127,127,127,.4);border-radius:6px;padding:2px 4px;font:inherit}',
  '[data-status-anim-ui="value"]{flex:0 0 auto;min-width:38px;text-align:right;opacity:.7;',
  'font-variant-numeric:tabular-nums}',
  '[data-status-anim-ui="close"]{border:0;background:transparent;color:inherit;cursor:pointer;',
  'font-size:14px;opacity:.6;padding:0 2px;line-height:1}',
  '[data-status-anim-ui="hint"]{opacity:.55;font-size:11px;margin-top:6px}',
  '[data-status-anim-ui="preview"]{display:flex;align-items:center;justify-content:center;',
  'gap:10px;min-height:64px;margin:8px 0 2px;padding:8px;border-radius:8px;',
  'border:1px dashed rgba(127,127,127,.45);background:rgba(127,127,127,.08)}',
  '[data-status-anim-ui="preview"] img{object-fit:contain;display:block}',
  '[data-status-anim-ui="previewText"]{font-size:12px;opacity:.75;white-space:nowrap}',
  '[data-status-anim-ui="caption"]{opacity:.5;font-size:10px;text-align:center;margin-bottom:4px}',
].join('')

/** 注入面板样式（幂等）。 */
function ensureStyle(): void {
  if (document.querySelector(`style[${UI_MARK}="style"]`) !== null) return
  const style = document.createElement('style')
  style.setAttribute(UI_MARK, 'style')
  style.textContent = PANEL_CSS
  const host = document.head === null ? document.documentElement : document.head
  if (host === null) return
  host.appendChild(style)
}

/** 造一行「标签 + 控件」。 */
function makeRow(text: string): { row: HTMLDivElement; label: HTMLSpanElement } {
  const row = document.createElement('div')
  row.setAttribute(UI_MARK, 'row')
  const label = document.createElement('span')
  label.setAttribute(UI_MARK, 'label')
  label.textContent = text
  row.appendChild(label)
  return { row, label }
}

/** 面板依赖的回调。 */
interface PanelOptions {
  onChange: (options: { retarget?: boolean }) => void
  onClose: () => void
}

/** 造面板内容（每次打开都重建，保证读到最新 localStorage）。 */
function buildPanel(options: PanelOptions): HTMLDivElement {
  const onChange = options.onChange
  const box = document.createElement('div')
  box.setAttribute(UI_MARK, 'panel')

  const title = document.createElement('h4')
  title.setAttribute(UI_MARK, 'title')
  const titleText = document.createElement('span')
  titleText.textContent = '状态条动画'
  const close = document.createElement('button')
  close.type = 'button'
  close.setAttribute(UI_MARK, 'close')
  close.title = '关闭'
  close.textContent = '×'
  close.addEventListener('click', () => {
    try {
      options.onClose()
    } catch {
      // ignore
    }
  })
  title.appendChild(titleText)
  title.appendChild(close)
  box.appendChild(title)

  // 1) 启用开关
  const enable = makeRow('启用')
  const checkbox = document.createElement('input')
  checkbox.type = 'checkbox'
  checkbox.checked = isEnabled()
  checkbox.addEventListener('change', () => {
    writeSetting(KEY_ENABLED, checkbox.checked ? '1' : '0')
    onChange({ retarget: false })
  })
  enable.row.appendChild(checkbox)
  box.appendChild(enable.row)

  /** 实时预览重绘（尺寸滑块 / 素材下拉共用；fill 里赋值）。 */
  let renderPreview: (names: string[]) => void = () => {}

  // 2) 尺寸滑块 8..96
  const size = makeRow('尺寸')
  const slider = document.createElement('input')
  slider.type = 'range'
  slider.min = String(MIN_SIZE)
  slider.max = String(MAX_SIZE)
  slider.step = '1'
  slider.value = String(readSize())
  const value = document.createElement('span')
  value.setAttribute(UI_MARK, 'value')
  value.textContent = `${String(readSize())}px`
  slider.addEventListener('input', () => {
    const next = Math.round(Number.parseFloat(slider.value))
    if (!Number.isFinite(next)) return
    writeSetting(KEY_SIZE, String(next))
    value.textContent = `${String(next)}px`
    renderPreview(live.state === null ? [] : live.state.names)
    onChange({ retarget: false })
  })
  size.row.appendChild(slider)
  size.row.appendChild(value)
  box.appendChild(size.row)

  // 3) 素材下拉（随机 + /status-anim/list 的文件名）
  const asset = makeRow('素材')
  const select = document.createElement('select')

  // 3.5) 实时预览：即使不发消息、页面上没有活跃状态行，也能直接看到动图。
  const caption = document.createElement('div')
  caption.setAttribute(UI_MARK, 'caption')
  caption.textContent = '实时预览（与状态行同尺寸）'
  const preview = document.createElement('div')
  preview.setAttribute(UI_MARK, 'preview')
  const previewImg = document.createElement('img')
  previewImg.setAttribute(UI_MARK, 'previewImg')
  previewImg.setAttribute('alt', '')
  previewImg.setAttribute('draggable', 'false')
  const previewText = document.createElement('span')
  previewText.setAttribute(UI_MARK, 'previewText')
  previewText.textContent = '深度求索中，用时 52 秒 ···'
  preview.appendChild(previewImg)
  preview.appendChild(previewText)

  renderPreview = (names: string[]): void => {
    // 面板里放大到至少 32px，否则 18px 的动图肉眼难辨认。
    const shown = Math.max(32, readSize())
    previewImg.style.width = `${String(shown)}px`
    previewImg.style.height = `${String(shown)}px`
    const wanted = readPicked()
    const name = wanted !== PICK_RANDOM && names.indexOf(wanted) >= 0 ? wanted : names[0]
    if (name === undefined) {
      previewImg.removeAttribute('src')
      previewText.textContent = '（素材目录为空）'
      return
    }
    previewImg.src = `${FILE_URL}${encodeURIComponent(name)}?t=${String(Date.now())}`
    previewText.textContent = '深度求索中，用时 52 秒 ···'
  }

  const fill = (names: string[]): void => {
    select.textContent = ''
    const randomOption = document.createElement('option')
    randomOption.value = PICK_RANDOM
    randomOption.textContent = '随机'
    select.appendChild(randomOption)
    for (const name of names) {
      const option = document.createElement('option')
      option.value = name
      option.textContent = name
      select.appendChild(option)
    }
    const wanted = readPicked()
    // 选中的文件被删掉了 → 退回「随机」，避免下拉显示空白。
    select.value = wanted !== PICK_RANDOM && names.indexOf(wanted) >= 0 ? wanted : PICK_RANDOM
    renderPreview(names)
  }
  select.addEventListener('change', () => {
    writeSetting(KEY_PICKED, select.value)
    renderPreview(live.state === null ? [] : live.state.names)
    onChange({ retarget: true })
  })
  fill(live.state === null ? [] : live.state.names)
  asset.row.appendChild(select)
  box.appendChild(asset.row)
  box.appendChild(caption)
  box.appendChild(preview)

  const hint = document.createElement('div')
  hint.setAttribute(UI_MARK, 'hint')
  hint.textContent = '素材来自 ~/.dsh/status-anim/，改动即时生效。'
  box.appendChild(hint)

  // 异步补一次真实列表（打开面板即最新，顺带把结果回写进 state）。
  void fetchNames()
    .then((names) => {
      if (names.length === 0) return
      const state = live.state
      if (state !== null && !state.stopped) {
        state.names = names
        state.fetchedAt = Date.now()
      }
      fill(names)
    })
    .catch(() => {
      // 列表拉不到：下拉只留「随机」，动画侧不受影响。
    })

  return box
}

/**
 * 挂载设置 UI（齿轮 + 浮动面板）。
 * 整个函数被 apply() 用 try/catch + setTimeout 包住：它失败只损失设置界面。
 */
export function mountSettings(): () => void {
  if (document.body === null) {
    // DOM 还没就绪：稍后再试一次，不抛错。
    window.setTimeout(() => {
      try {
        mountSettings()
      } catch {
        // ignore
      }
    }, 200)
    return () => {}
  }
  ensureStyle()

  const gear = document.createElement('button')
  gear.type = 'button'
  gear.setAttribute(UI_MARK, 'gear')
  gear.title = '状态条动画设置'
  gear.setAttribute('aria-label', '状态条动画设置')
  gear.textContent = '⚙'

  let panel: HTMLElement | null = null
  let removed = false

  const closePanel = (): void => {
    if (panel !== null && panel.parentNode !== null) panel.parentNode.removeChild(panel)
    panel = null
    gear.removeAttribute('data-active')
  }

  const unmount = (): void => {
    if (removed) return
    removed = true
    closePanel()
    if (gear.parentNode !== null) gear.parentNode.removeChild(gear)
  }

  gear.addEventListener('click', () => {
    try {
      if (panel !== null && panel.parentNode !== null) {
        closePanel()
        return
      }
      panel = buildPanel({
        onChange: (next) => {
          flush(next)
        },
        onClose: closePanel,
      })
      document.body.appendChild(panel)
      gear.setAttribute('data-active', '1')
    } catch {
      // 面板构建失败：收起状态，路径 A 不受影响。
      closePanel()
    }
  })

  document.body.appendChild(gear)
  return unmount
}
//#endregion

function start(): () => void {
  const state = createState()
  if (typeof document === 'undefined') return () => {}

  live.state = state

  const kickoff = (): void => {
    if (state.stopped) return
    if (document.body === null) {
      window.setTimeout(kickoff, 50)
      return
    }
    try {
      const observer = new MutationObserver(() => {
        safeScan(state)
      })
      state.observer = observer
      observer.observe(document.body, { childList: true, subtree: true })
    } catch {
      state.observer = null
    }
    state.timer = window.setInterval(() => {
      safeScan(state)
    }, POLL_MS)
    safeScan(state)
  }
  kickoff()

  return () => {
    state.stopped = true
    if (state.timer !== null) {
      window.clearInterval(state.timer)
      state.timer = null
    }
    if (state.observer !== null) {
      try {
        state.observer.disconnect()
      } catch {
        // ignore
      }
      state.observer = null
    }
    state.inserted.forEach((el) => {
      try {
        if (el.parentNode !== null) el.parentNode.removeChild(el)
      } catch {
        // ignore
      }
    })
    state.inserted.clear()
    state.names = []
    if (live.state === state) live.state = null
  }
}

interface ClientCtx {
  effect?: (fn: () => () => void) => void
}

export function apply(ctx: Context | ClientCtx | undefined): void {
  const anyCtx = ctx as ClientCtx | undefined
  if (anyCtx === undefined || typeof anyCtx.effect !== 'function') {
    // 缺失 effect 时仍尽力工作（不返回清理器），保持零崩溃。
    start()
  } else {
    anyCtx.effect(() => start())
  }

  // 路径 B：延后一拍异步挂载 + 双层 try/catch。
  // 此时路径 A 的 observer 与轮询已经在跑，B 无论怎样失败都碰不到 A。
  try {
    window.setTimeout(() => {
      try {
        mountSettings()
      } catch {
        // 设置界面不是核心功能，失败即静默降级。
      }
    }, 0)
  } catch {
    // ignore
  }
}
