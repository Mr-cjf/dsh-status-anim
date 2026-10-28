/**
 * dsh-status-anim — Web 客户端半边（CJS 工厂，由 dsh-client-modules 装载）
 *
 * 载体格式对齐 DSH 0.2.1-rc.3 的 client bundle 契约
 * （见 dsh-client-ui-chat/lib/client.js）：`window.__ModuleLoader__.load({ id, factory })`，
 * id 必须等于包名（dsh-client-modules/lib/index.js:903 graphRow(packageName, ...)）。
 *
 * inject 只声明 `slots`：设置入口是「设置页 → 状态动画」槽位（React 面板）。
 * 核心动画仍不依赖任何服务——slots 缺失时 apply() 直接跳过注册，路径 A 照常工作。
 *
 * 【两条完全隔离的执行路径】
 *   路径 A（核心，必须永远工作）：素材列表 + MutationObserver + prepend <img>。
 *     零服务依赖，任何设置界面的故障都不可能波及它。
 *   路径 B（设置 UI，允许失败）：`ctx.slots.register('settings.section', …)` 的 React 面板。
 *     带 ctx.slots 守卫 + try/catch + 延后一拍，所以 B 抛错时 A 早已在观察 DOM。
 *
 * 为什么不用 `plugins.item` 槽位（调研结论见 README）：
 *   1. 该形状要求 `ctx.configForms.whileServed(...)` + `ctx.slots.inject("plugins.item", ...)`
 *      （dsh-client-ui-settings-shell/lib/client.js:182-189），依赖额外的 configForms/locale 服务；
 *   2. cordis 的 fiber 依赖是「全有或全无」——多 inject 一个服务，就多一条整条 fiber 不 apply 的路径。
 *   3. 故只 inject `slots`，用轻量的 `settings.section` 槽位（与 dsh-boot-suite 同款写法）。
 *
 * 行为：
 *  1. 从 /status-anim/list 拉素材名列表（用户选中优先，否则随机）；
 *  2. MutationObserver(childList + subtree) 盯住 document.body；
 *  3. 回调里先 disconnect、处理完再 observe（防止自己 prepend 的元素把观察器打成死循环）；
 *  4. 多路候选选择器 → 向上找到「可见宿主」→ 在文本容器里 prepend(<img>)（幂等）；
 *     真实宿主见 MULTI_SELECTORS 上方注释（旧的单条选择器命中的是 1px 隐藏 span）；
 *  5. 元素脱离文档后从内部集合移出（避免内存泄漏）；
 *  6. 设置改动经 flush() 就地改已有 img 的尺寸/图源，无需刷新页面；
 *  7. 一切失败静默降级，绝不抛错污染宿主。
 */
window.__ModuleLoader__.load({
  id: 'dsh-status-anim',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    /**
     * 状态条候选选择器（多路回退，按「最精确 → 最宽松」排序）。
     *
     * 真实 DOM（从运行中的 app.asar 里 @deepseek-ai/dsh-client-ui-chat/lib/client.js 读出的
     * RunningStatus 组件，:273444 附近）：
     *
     *   <div class="V4vHZW_running" data-chat-running>
     *     <span class="BpRApG_visuallyHidden" role="status" aria-live="polite" aria-atomic="true">
     *       深度求索中                      ← 1px×1px，clip:rect(0 0 0 0)，看不见
     *     </span>
     *     <span class="V4vHZW_runningDivider" aria-hidden="true"></span>
     *     <span class="V4vHZW_runningContent">
     *       <RunningWhaleTail/>            ← 鲸鱼尾巴（runningIcon）
     *       <TextShimmer>深度求索中，用时 52 秒 ···</TextShimmer>  ← 用户真正看到的那行
     *     </span>
     *   </div>
     *
     * 旧选择器 `[data-chat-flow] [role="status"][aria-live="polite"]` 其实「能命中」，
     * 但命中的是这个 visuallyHidden 的 1px span —— 图插进去了却不可见，
     * 所以用户截图里「深度求索中，用时 52 秒…」左侧始终是空的。
     * 修复要点：命中后必须向「可见宿主」上浮，再插到 runningContent 的文本前面。
     */
    var SELECTORS = [
      // 1) 最精确：真实宿主容器（aria-live 的 1px span 的父级）。rc.3 起的主路径。
      '[data-chat-flow] [data-chat-running]',
      // 2) 去掉 data-chat-flow 限制（有的部署里 chat flow 在别的容器下），
      //    但仍要求 `data-chat-running`：这是状态行专属语义属性，
      //    不会出现在侧边栏会话条目、思考块、动作行上。
      '[data-chat-running]',
    ]

    /**
     * 已删除的宽泛回退（历史 bug 根因，务必别再恢复）：
     *
     *   '[role="status"][aria-live="polite"]' / '[role="status"]'
     *     → 侧边栏每个会话条目都有自己的「运行中」live region，思考块标题、
     *       动作行状态也带 role=status；这些元素经 findHost() 上浮后落在
     *       「宽而矮」的列表行上（width≫100、height≤120，尺寸过滤全通过），
     *       于是同一张图被插到每个会话条目左侧和每个思考块里。
     *   '[class*="Status"]' / '[class*="_turnStatus"]'
     *     → *Contains* 匹配任意含 Status 的 class，命中面更不可控。
     *
     * 原则：宁可少插，不可错插 —— 宽泛回退整体删除，只保留带三重过滤的文本兜底。
     */

    /** 禁止区域：命中这些祖先的元素一律不插图（侧边栏 / 会话列表 / 主导航 / 旁栏）。 */
    var FORBIDDEN_ANCESTOR = [
      '[class*="sidebar" i]',
      '[class*="Session" i]',
      '[class*="session-list" i]',
      '[class*="threadList" i]',
      'nav',
      'aside',
    ]

    /** 合并成一次 closest() 查询。 */
    var FORBIDDEN_SELECTOR = FORBIDDEN_ANCESTOR.join(',')

    /** 旧选择器保留导出（离线自检还在断言它），运行时已改用 SELECTORS。 */
    var SELECTOR = '[data-chat-flow] [role="status"][aria-live="polite"]'

    /**
     * 动作行轮换映射表：变体 → 选择器。
     *
     * 顺序即轮换顺序，第 i 类动作固定取「排序后素材名单」的第 i 张（names[i % N]）：
     * 当前 ~/.dsh/status-anim/ 有 11 张图 > 7+1 类动作，所以每类动作拿到的都是不同的图，
     * 且同一屏内的映射是稳定的（重扫/换会话都不会跳图）。
     *
     * 选择器一律用 data-* 属性：宿主 CSS Modules 类名带构建哈希，不可作为选择器使用。
     * 不加 [data-state] 限制 —— running / ok / error / stopped 四种状态都挂动图。
     * 最后一条 others 是命令卡 / 未知变体的兜底槽位。
     */
    var ACTION_SELECTORS = [
      { variant: 'write', selector: '[data-variant="write"]' },
      { variant: 'think', selector: '[data-variant="think"]' },
      { variant: 'bash', selector: '[data-variant="bash"]' },
      { variant: 'search', selector: '[data-variant="search"]' },
      { variant: 'read', selector: '[data-variant="read"]' },
      { variant: 'edit', selector: '[data-variant="edit"]' },
      { variant: 'code', selector: '[data-variant="code"]' },
      { variant: 'others', selector: '[data-variant="others"]' },
    ]

    /** 动作行去重属性：值为 variant。与 MARK（data-status-anim）不同名，互不干扰。 */
    var ROW_MARK = 'data-status-anim-row'

    /**
     * 动作变体 → 固定素材基名（不含扩展名）。按 dsh-dafeiyu 素材目录语义命名，
     * 缺图时回退到轮换映射。others 是命令卡 / 未知变体的兜底。
     */
    var ACTION_ASSET = {
      think: 'thinking',
      bash: 'working_command',
      search: 'working_search',
      write: 'working',
      read: 'working',
      edit: 'working_command',
      code: 'working',
      others: 'working',
    }

    /** 基名找图时的扩展名优先级（客户端只能看名字，真动图校验在 host 侧）。 */
    var ACTION_ASSET_EXTS = ['.webp', '.apng', '.png']

    /** 客户端素材扩展名白名单：与 host 的 MIME 表逐项对齐（旧格式已下线）。 */
    var CLIENT_EXTS = ['.apng', '.png', '.webp']

    /**
     * 模块级 URL stamp 表：素材名 → 当前 `?t=` 时间戳串。
     *
     * 为什么必须有它：ACTION_ASSET 把 8 类动作压到 4 个基名，几十行历史里同一张
     * `working.webp` 会出现几十次。若每插一次就打一个 Date.now()，同一张图就是几十个
     * 不同 URL —— 浏览器既不共享 HTTP 缓存也不共享解码图（562–692KB × 200+ 帧 ≈ 12MB
     * 原始帧 × N 行），内存与解码线程双爆。
     * 现在同一名字在整页生命周期内只用一个 stamp，只有「名单变化」与「用户手动换图」
     * 才 invalidate，所以换图依然即时。
     */
    var urlStamps = Object.create(null)

    /** @param {string} name 素材名 @returns {string} 该名字当前的时间戳串（首次现打） */
    function stampOf(name) {
      var stamp = urlStamps[name]
      if (stamp === undefined) {
        stamp = String(Date.now())
        urlStamps[name] = stamp
      }
      return stamp
    }

    /** 作废某个名字的 stamp：下次取用会重新打时间戳（同名换图即时生效靠它）。 */
    function invalidateStamp(name) {
      delete urlStamps[name]
    }

    /** @param {string} name 素材名 @returns {string} 带统一 stamp 的图片 URL */
    function fileUrl(name) {
      return FILE_URL + encodeURIComponent(name) + '?t=' + stampOf(name)
    }

    /** @param {string} name @returns {boolean} 扩展名是否在客户端白名单内 */
    function hasClientExt(name) {
      var lower = name.toLowerCase()
      for (var i = 0; i < CLIENT_EXTS.length; i += 1) {
        if (lower.length > CLIENT_EXTS[i].length && lower.slice(-CLIENT_EXTS[i].length) === CLIENT_EXTS[i]) {
          return true
        }
      }
      return false
    }

    /**
     * 按 CLIENT_EXTS 过滤素材名单（保持原顺序）。
     *
     * 两条取名单通道（refreshList 与 fetchNames）**必须共用**：只过滤下拉、不过滤
     * state.names 时，host/client 版本错配会「下拉干净、状态行拿到 .gif → 404 → 空白破图」。
     * @param {unknown} list
     * @returns {string[]}
     */
    function sanitizeNames(list) {
      if (!Array.isArray(list)) return []
      var out = []
      for (var i = 0; i < list.length; i += 1) {
        var item = list[i]
        if (typeof item !== 'string' || item.length === 0) continue
        if (!hasClientExt(item)) continue
        out.push(item)
      }
      return out
    }

    /** @param {string[]} a @param {string[]} b @returns {boolean} 两份名单是否逐项相同 */
    function sameNames(a, b) {
      if (a.length !== b.length) return false
      for (var i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) return false
      }
      return true
    }

    /**
     * 名单变化后只作废「变了的那几个名字」的 stamp：未变化的继续命中浏览器缓存。
     * @param {string[]} prev 上一轮名单
     * @param {string[]} next 本轮名单
     */
    function invalidateChanged(prev, next) {
      var inPrev = Object.create(null)
      for (var i = 0; i < prev.length; i += 1) inPrev[prev[i]] = true
      var inNext = Object.create(null)
      for (var j = 0; j < next.length; j += 1) inNext[next[j]] = true
      // 新出现的名字（含「删掉再放进来」的同名新文件）。
      for (var a = 0; a < next.length; a += 1) {
        if (inPrev[next[a]] !== true) invalidateStamp(next[a])
      }
      // 已消失的名字：连表项一起清掉，避免 stamp 表随历史无限增长。
      for (var b = 0; b < prev.length; b += 1) {
        if (inNext[prev[b]] !== true) invalidateStamp(prev[b])
      }
    }

    /** 动作行图片的角色 / 变体标记（refreshInserted 靠它区分「轮换图」与「状态条图」）。 */
    var ROLE_ATTR = 'data-status-anim-role'
    var VARIANT_ATTR = 'data-status-anim-variant'

    /** 文本兜底正则：真实文案「深度求索中，用时 52 秒 ···」/「Deep diving…」。 */
    var TEXT_RE = /深度求索中|Deep\s*diving|深度思考|深入思考/i

    /** 可见宿主的尺寸上限：状态行是一行文本，超过这个尺寸的是别的东西。 */
    var MAX_HOST_HEIGHT = 120

    /** 可见宿主的最小宽度：排除侧边栏 / 图标按钮一类的窄元素。 */
    var MIN_HOST_WIDTH = 100

    /** 素材清单接口。 */
    var LIST_URL = '/status-anim/list'

    /** 图片本体接口前缀。 */
    var FILE_URL = '/status-anim/file/'

    /** 自己元素的标记属性，用于幂等判定与清理。 */
    var MARK = 'data-status-anim'

    /** 设置 UI 全部 DOM 的标记属性（与 MARK 区分：这个不对动画生效）。 */
    var UI_MARK = 'data-status-anim-ui'

    /** 默认尺寸（px）。 */
    var DEFAULT_SIZE = 18

    /** 尺寸合法区间。 */
    var MIN_SIZE = 8
    var MAX_SIZE = 96

    /** 列表最长缓存时长；到点后下一次扫描会重新拉取，实现「放文件即换图」。 */
    var LIST_TTL_MS = 2000

    /** 轮询兜底间隔（MutationObserver 之外的保险）。 */
    var POLL_MS = 1500

    /** localStorage 键（向前兼容：沿用既有三个键，新增一个 picked）。 */
    var KEY_SIZE = 'dsh-status-anim.size'
    var KEY_ENABLED = 'dsh-status-anim.enabled'
    var KEY_MOTION = 'dsh-status-anim.motion'
    var KEY_PICKED = 'dsh-status-anim.picked'

    /** 「随机」素材的取值（空串 = 由插件随机挑）。 */
    var PICK_RANDOM = ''

    /** @returns {Storage|undefined} 可用的 localStorage（隐私模式下可能抛错） */
    function storage() {
      try {
        return window.localStorage
      } catch {
        return undefined
      }
    }

    /** @param {string} key @returns {string|undefined} */
    function readSetting(key) {
      var store = storage()
      if (store === undefined) return undefined
      try {
        var value = store.getItem(key)
        return value === null ? undefined : value
      } catch {
        return undefined
      }
    }

    /** @param {string} key @param {string} value 写设置；失败静默（不影响动画） */
    function writeSetting(key, value) {
      var store = storage()
      if (store === undefined) return
      try {
        store.setItem(key, value)
      } catch {
        // 隐私模式 / 配额满：只丢设置，动画继续用旧值。
      }
    }

    /** 尺寸：localStorage 覆盖 → 默认 18px，合法区间 8..96。 */
    function readSize() {
      var raw = readSetting(KEY_SIZE)
      if (raw === undefined) return DEFAULT_SIZE
      var parsed = Number.parseFloat(raw)
      if (!Number.isFinite(parsed) || parsed < MIN_SIZE || parsed > MAX_SIZE) return DEFAULT_SIZE
      return Math.round(parsed)
    }

    /** 开关：`0` / `false` / `off` 视为关闭。 */
    function isEnabled() {
      var raw = readSetting(KEY_ENABLED)
      if (raw === undefined) return true
      var value = String(raw).trim().toLowerCase()
      return !(value === '0' || value === 'false' || value === 'off' || value === 'no')
    }

    /** 用户选中的素材名；空串表示随机。 */
    function readPicked() {
      var raw = readSetting(KEY_PICKED)
      return raw === undefined ? PICK_RANDOM : raw
    }

    /** 系统是否要求减少动效。 */
    function prefersReducedMotion() {
      try {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches
      } catch {
        return false
      }
    }

    /** 在 reduced-motion 下是否仍然播放动图（显式 opt-in）。 */
    function motionForced() {
      var raw = readSetting(KEY_MOTION)
      return raw !== undefined && String(raw).trim().toLowerCase() === 'force'
    }

    /**
     * 取第一帧转成静态 data URL（reduced-motion 降级用）。
     * 任一环节不支持 → 返回 undefined，由调用方退回直接插动图。
     * @param {string} url
     * @returns {Promise<string|undefined>}
     */
    async function freezeFirstFrame(url) {
      try {
        if (typeof window.createImageBitmap !== 'function') return undefined
        var blob = await (await fetch(url, { cache: 'no-store' })).blob()
        var bitmap = await window.createImageBitmap(blob)
        var canvas = document.createElement('canvas')
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        var ctx = canvas.getContext('2d')
        if (ctx === null) return undefined
        ctx.drawImage(bitmap, 0, 0)
        if (typeof bitmap.close === 'function') bitmap.close()
        return canvas.toDataURL('image/png')
      } catch {
        return undefined
      }
    }

    /** 插件状态。 */
    function createState() {
      return {
        /** @type {string[]} 上次拉到的素材名 */
        names: [],
        /** @type {number} 上次成功拉取的时间戳 */
        fetchedAt: 0,
        /** @type {boolean} 是否有一次请求在飞行中 */
        inflight: false,
        /** @type {Set<Element>} 已插入的图片元素（用于清理与泄漏检测） */
        inserted: new Set(),
        /** @type {MutationObserver|null} */
        observer: null,
        /** @type {number|null} */
        timer: null,
        /** @type {(() => void)|null} 解绑 resize/dpr 之类监听（保留位） */
        disposeExtra: null,
        stopped: false,
      }
    }

    /**
     * 当前正在运行的 state（路径 B 通过它即时改动画）。
     * 路径 B 失败时这里保持 null，路径 A 照常工作。
     * @type {{state: ReturnType<typeof createState>|null}}
     */
    var live = { state: null }

    /** @param {ReturnType<typeof createState>} state 拉取素材清单（节流 + 失败静默） */
    function refreshList(state) {
      if (state.inflight) return
      var now = Date.now()
      if (state.fetchedAt !== 0 && now - state.fetchedAt < LIST_TTL_MS) return
      state.inflight = true
      fetch(LIST_URL, { cache: 'no-store' })
        .then(function (res) {
          if (!res.ok) throw new Error('status-anim: list ' + String(res.status))
          return res.json()
        })
        .then(function (value) {
          var next = sanitizeNames(value)
          // 名单变化 → 只作废变化项的 stamp：未变的同张图继续共享浏览器缓存/解码图。
          if (!sameNames(state.names, next)) invalidateChanged(state.names, next)
          state.names = next
          state.fetchedAt = Date.now()
          // 首次拿到素材后补一轮扫描：否则要等下一次轮询才插图。
          if (state.names.length > 0 && !state.stopped) {
            window.setTimeout(function () {
              flush({ retarget: false })
            }, 0)
          }
        })
        .catch(function () {
          // 服务没起来 / 目录不存在：保留旧列表，静默。
          state.fetchedAt = Date.now()
        })
        .then(function () {
          state.inflight = false
        })
    }

    /** @param {string[]} names @returns {string|undefined} 随机取一张 */
    function pick(names) {
      if (names.length === 0) return undefined
      var index = Math.floor(Math.random() * names.length)
      if (index < 0 || index >= names.length) index = 0
      return names[index]
    }

    /**
     * 当前该用哪张素材：用户选中的（若仍存在）优先，否则随机。
     * @param {ReturnType<typeof createState>} state
     * @returns {string|undefined}
     */
    function currentName(state) {
      if (state.names.length === 0) return undefined
      var wanted = readPicked()
      if (wanted !== PICK_RANDOM && state.names.indexOf(wanted) >= 0) return wanted
      return pick(state.names)
    }

    /**
     * 判断一个元素是否是「可见的状态行宿主」：状态行只有一行文本，
     * 所以高度必须很小；同时排除 1px 的 visuallyHidden span 与窄侧栏条目。
     * @param {Element} el
     * @returns {boolean}
     */
    function isVisibleHost(el) {
      if (el === null || el === undefined) return false
      var rect
      try {
        rect = el.getBoundingClientRect()
      } catch {
        return false
      }
      if (rect === undefined || rect === null) return false
      if (rect.width < MIN_HOST_WIDTH) return false
      if (rect.height <= 0 || rect.height > MAX_HOST_HEIGHT) return false
      // display:none / visibility:hidden 的祖先链会给出 0 尺寸，上面已排除。
      var style
      try {
        style = window.getComputedStyle(el)
      } catch {
        style = null
      }
      if (style !== null) {
        if (style.visibility === 'hidden' || style.display === 'none') return false
        if (style.clip !== 'auto' || style.clipPath === 'inset(50%)') return false
      }
      var text = (el.textContent || '').trim()
      return text.length > 0
    }

    /**
     * 从命中的元素向上找「可见宿主」。
     * 旧选择器命中的是 1px visuallyHidden 的 span，必须一路上浮到 running 容器。
     * @param {Element} hit
     * @returns {Element|null}
     */
    function findHost(hit) {
      var node = hit
      for (var depth = 0; node !== null && node !== undefined && depth < 8; depth += 1) {
        if (node === document.body || node === document.documentElement) return null
        if (isVisibleHost(node)) return node
        node = node.parentElement
      }
      return null
    }

    /**
     * 在宿主内部找真正的「插图挂点」：
     * 真实 DOM 里文字在 `<span class="..._runningContent">`（inline-flex，内含鲸鱼尾 + 文本），
     * 而宿主 `..._running` 是 flex-direction: column —— 直接 prepend 到宿主会另起一行，
     * 所以优先挂到 runningContent 上，紧贴文字左侧。
     * @param {Element} host
     * @returns {Element}
     */
    function findMount(host) {
      try {
        var content = host.querySelector('[class*="_runningContent"]')
        // 只要求挂点可见且仍在本宿主内；不再用 isVisibleHost 的宽高阈值卡它
        // （runningContent 是 inline-flex，窄于 100px 时会被误判而退回宿主）。
        if (content !== null && !inForbiddenZone(content)) {
          var rect = content.getBoundingClientRect()
          if (rect.width > 0 && rect.height > 0) return content
        }
      } catch {
        // ignore
      }
      return host
    }

    /**
     * 是否位于「禁止区域」内（侧边栏 / 会话列表 / nav / aside）。
     * 祖先链上任意一层命中就否决 —— 这是挡掉侧边栏误插的最后一道闸。
     * @param {Element} el
     * @returns {boolean}
     */
    function inForbiddenZone(el) {
      if (el === null || el === undefined) return true
      try {
        if (el.closest(FORBIDDEN_SELECTOR) !== null) return true
        var active = document.activeElement
        if (active !== null && active !== el && el === active) return true
      } catch {
        return true // 查询失败一律否决（宁可少插）
      }
      return false
    }

    /**
     * 严格判定「这确实是聊天主区里的状态行」：
     *   1) 含状态行文案（TEXT_RE）—— 没有「深度求索中 / Deep diving」的绝不插；
     *   2) 在聊天主区内：祖先命中 `[data-chat-flow]`，或自身带 `data-chat-running`；
     *   3) 祖先链不含禁止区域；
     *   4) 尺寸像状态行：宽 ≥ 200、高 20..60。
     * @param {Element} el
     * @returns {boolean}
     */
    function isStrictStatusRow(el) {
      if (el === null || el === undefined) return false
      if (inForbiddenZone(el)) return false
      var text = (el.textContent || '').trim()
      if (text.length === 0 || !TEXT_RE.test(text)) return false
      // 文案之外不能夹带大段内容（会话条目会有标题+时间戳+预览，长度远超状态行）。
      if (text.length > 80) return false

      var own = false
      try {
        own = el.getAttribute('data-chat-running') !== null
      } catch {
        own = false
      }
      var inFlow = false
      try {
        inFlow = el.closest('[data-chat-flow]') !== null
      } catch {
        inFlow = false
      }
      if (!own && !inFlow) return false

      var rect
      try {
        rect = el.getBoundingClientRect()
      } catch {
        return false
      }
      if (rect === undefined || rect === null) return false
      if (rect.width < 200) return false
      if (rect.height < 20 || rect.height > 60) return false

      var style
      try {
        style = window.getComputedStyle(el)
      } catch {
        style = null
      }
      if (style !== null && (style.visibility === 'hidden' || style.display === 'none')) return false
      return true
    }

    /**
     * 收集所有「该插图的状态行宿主」（去重，全部经过严格三重过滤）。
     * 精确优先：`[data-chat-flow] [data-chat-running]` 命中即返回，不命中才走受限兜底。
     * @returns {Element[]}
     */
    function collectHosts() {
      var hosts = []
      var push = function (el) {
        if (el === null || el === undefined) return
        if (hosts.indexOf(el) >= 0) return
        if (!isStrictStatusRow(el)) return
        hosts.push(el)
      }

      // 1) 精确路径：真实状态行容器。命中就用，不看别的候选。
      var exact
      try {
        exact = document.querySelectorAll(SELECTORS[0])
      } catch {
        exact = []
      }
      for (var a = 0; a < exact.length; a += 1) push(exact[a])
      if (hosts.length > 0) return hosts

      // 2) 受限兜底：只有 data-chat-running、但没有 data-chat-flow 祖先的部署。
      var relaxed
      try {
        relaxed = document.querySelectorAll(SELECTORS[1])
      } catch {
        relaxed = []
      }
      for (var b = 0; b < relaxed.length; b += 1) push(relaxed[b])
      if (hosts.length > 0) return hosts

      // 3) 文本兜底：构建哈希漂移时连 data-chat-running 都丢了 —
      //    只认「含状态行文案 + 在 data-chat-flow 内 + 尺寸像状态行」的元素，
      //    而且绝不走 findHost() 上浮（上浮是误插的主要放大器）。
      var all
      try {
        all = document.querySelectorAll('[data-chat-flow] *')
      } catch {
        return hosts
      }
      for (var c = 0; c < all.length; c += 1) {
        var el = all[c]
        if (el.children.length > 2) continue
        if (!TEXT_RE.test(el.textContent || '')) continue
        push(el)
        if (hosts.length >= 2) break
      }
      return hosts
    }

    /**
     * 清理误插：把已经不在合法状态行里的 `img[data-status-anim]`（状态条图，非动作行图）
     * 从 DOM 里删掉。刷新页面后即使有历史残留，也会在第一轮扫描被清干净。
     * @param {ReturnType<typeof createState>} state
     */
    function pruneStrayImages(state) {
      var strays
      try {
        strays = document.querySelectorAll('img[' + MARK + '="1"]')
      } catch {
        return
      }
      for (var i = 0; i < strays.length; i += 1) {
        var img = strays[i]
        // 动作行图（带 role=action）由 scanActions 自己的幂等逻辑管，这里不碰。
        if (img.getAttribute(ROLE_ATTR) === 'action') continue
        // 设置面板的实时预览图不是插图，跳过。
        if (img.closest('[data-status-anim-ui]') !== null) continue
        var parent = img.parentElement
        var legitimate = false
        // 插图挂在 runningContent（或其宿主）内部：向上 3 层内找到合法状态行即算合法。
        var node = parent
        for (var depth = 0; node !== null && node !== undefined && depth < 4; depth += 1) {
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
        if (typeof state.inserted.delete === 'function') state.inserted.delete(img)
      }
    }

    /**
     * 造一个自描述 img。
     * @param {string} name 素材文件名
     * @param {number} size 边长 px
     * @param {string} [variant] 动作行变体；省略表示状态条图
     * @returns {HTMLImageElement}
     */
    function createImage(name, size, variant) {
      var img = document.createElement('img')
      img.setAttribute(MARK, '1')
      if (variant !== undefined) {
        img.setAttribute(ROLE_ATTR, 'action')
        img.setAttribute(VARIANT_ATTR, variant)
      }
      img.setAttribute('alt', '')
      img.setAttribute('aria-hidden', 'true')
      img.setAttribute('draggable', 'false')
      img.dataset.statusAnimName = name
      // 同一素材名整页共用一个 stamp：同名换图靠 invalidateStamp() 即时生效，
      // 而不是每次插图都打新时间戳（否则每行一个 URL，缓存与解码图全不共享）。
      img.src = fileUrl(name)
      var px = String(size) + 'px'
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

    /**
     * reduced-motion 降级：把已插入的 img 就地替换为静态首帧。
     * @param {HTMLImageElement} img
     */
    function freezeInPlace(img) {
      var source = img.src
      freezeFirstFrame(source).then(function (dataUrl) {
        if (dataUrl !== undefined && img.isConnected) img.src = dataUrl
      })
    }

    /**
     * 清扫脱离文档的元素，返回仍存活的图片元素。
     * @param {ReturnType<typeof createState>} state
     * @returns {Element[]}
     */
    function sweep(state) {
      var alive = []
      state.inserted.forEach(function (el) {
        if (el.isConnected) alive.push(el)
        else state.inserted.delete(el)
      })
      return alive
    }

    /** 清掉所有已插入的图（禁用 / 清理时用）。 */
    function removeAllImages(state) {
      state.inserted.forEach(function (el) {
        try {
          if (el.parentNode !== null) el.parentNode.removeChild(el)
        } catch {
          // ignore
        }
      })
      state.inserted.clear()
      // 图被移除后必须清掉行上的 ROW_MARK，否则重新启用时会被幂等逻辑误跳过：
      // 此时所有图都已移除，全文残留标记一律作废。
      try {
        var leftover = document.querySelectorAll('[' + ROW_MARK + ']')
        for (var i = 0; i < leftover.length; i += 1) leftover[i].removeAttribute(ROW_MARK)
      } catch {
        // ignore
      }
    }

    /**
     * 把设置改动就地同步到「已经插在页面上的」图（尺寸 / 素材）。
     * 这是「改设置立即生效、无需刷新」的实现点：scan 的幂等逻辑会跳过已有图，
     * 所以必须显式改它们的 inline style 与 src。
     * @param {ReturnType<typeof createState>} state
     * @param {{retarget?: boolean}} [options] retarget=true 时强制换图源
     */
    function refreshInserted(state, options) {
      var opts = options === undefined ? {} : options
      if (!isEnabled()) {
        removeAllImages(state)
        return
      }
      // 手动换图（retarget）→ 作废当前素材名的 stamp，让新字节立刻生效。
      if (opts.retarget === true) {
        var retargeted = currentName(state)
        if (retargeted !== undefined) invalidateStamp(retargeted)
      }
      var px = String(readSize()) + 'px'
      var name = currentName(state)
      var names = state.names
      state.inserted.forEach(function (el) {
        if (!el.isConnected) return
        el.style.width = px
        el.style.height = px
        // 动作行图走「变体 → 素材下标」轮换映射，不能被状态条用的 name 覆盖，
        // 否则所有动作行会变成同一张图（丢失轮换效果）。
        var role = el.getAttribute(ROLE_ATTR)
        if (role === 'action') {
          // 动作行按「变体 → 具名素材」重新解析，不能被状态条的 currentName() 覆盖。
          var actionName = resolveActionName(names, el.getAttribute(VARIANT_ATTR))
          if (actionName === undefined) return
          if (actionName !== el.dataset.statusAnimName || opts.retarget === true) {
            if (opts.retarget === true) invalidateStamp(actionName)
            el.dataset.statusAnimName = actionName
            el.src = fileUrl(actionName)
          }
          return
        }
        // 只有「用户明确换了素材」或「这张图还没定过素材」才改 src；
        // 否则每轮刷新都会因随机挑到别的名字而换图。
        if (name !== undefined && (opts.retarget === true || !el.dataset.statusAnimName)) {
          el.dataset.statusAnimName = name
          el.src = fileUrl(name)
        }
      })
    }

    /**
     * 设置改动后的即时通道：就地更新已有图 → 全量重扫补齐新状态条。
     * @param {{retarget?: boolean}} [options]
     */
    function flush(options) {
      var state = live.state
      if (state === null || state.stopped) return
      try {
        refreshInserted(state, options)
      } catch {
        // 就地更新失败也不能挡住下面的重扫。
      }
      safeScan(state)
    }

    /**
     * 动作行的插入锚点：左侧图标位。
     *
     * 宿主 ToolRow 的左侧图标在 `[data-disclosure-row] > span:first-child` 里，
     * 但 bash / code 等变体可能走自绘 DOM，锚点不一定存在 —— 拿不到就返回 null，
     * 由调用方跳过该行（绝不抛错、不影响整页其它行）。
     * 优先插到图标 span 的「前一个兄弟」位置（不覆盖宿主图标），拿不到再退到图标 span 内部。
     * @param {Element} row 已命中的动作行根元素
     * @returns {{mount: Element, before: Element|null}|null}
     */
    function findActionMount(row) {
      var candidates = [
        '[data-disclosure-row] > span:first-child',
        '[data-disclosure-row]',
        'span:first-child',
      ]
      for (var i = 0; i < candidates.length; i += 1) {
        var anchor
        try {
          anchor = row.querySelector(candidates[i])
        } catch {
          continue
        }
        if (anchor === null || anchor === undefined) continue
        var parent = anchor.parentElement
        // 并列插入：insertBefore(img, anchor) —— 不破坏宿主图标，也不占 ::after。
        if (parent !== null && parent !== undefined && parent.isConnected) {
          return { mount: parent, before: anchor }
        }
      }
      // 结构不符合预期：退到整行行首（仍不改 ::after / sweep）。
      return { mount: row, before: null }
    }

    /**
     * 变体在 ACTION_SELECTORS 里的下标（轮换映射用）。
     * @param {string|null} variant
     * @returns {number} 找不到返回 -1
     */
    function indexOfVariant(variant) {
      if (variant === null || variant === undefined) return -1
      for (var i = 0; i < ACTION_SELECTORS.length; i += 1) {
        if (ACTION_SELECTORS[i].variant === variant) return i
      }
      return -1
    }

    /**
     * 该变体在素材名单里该用哪张图。
     *
     * 优先按 ACTION_ASSET 的固定基名找（扩展名按 ACTION_ASSET_EXTS 顺序），
     * 找不到就回退到老的轮换映射 names[index % N]，名单为空返回 undefined。
     * @param {string[]} names 素材名单（已排序）
     * @param {string|null} variant 动作变体
     * @returns {string|undefined}
     */
    function resolveActionName(names, variant) {
      if (names.length === 0) return undefined
      var base = variant === null || variant === undefined ? undefined : ACTION_ASSET[variant]
      if (base === undefined) base = ACTION_ASSET.others
      for (var e = 0; e < ACTION_ASSET_EXTS.length; e += 1) {
        var wanted = base + ACTION_ASSET_EXTS[e]
        if (names.indexOf(wanted) >= 0) return wanted
      }
      var index = indexOfVariant(variant)
      if (index < 0) index = ACTION_SELECTORS.length - 1
      return names[index % names.length]
    }

    /**
     * 多选择器扫描动作行并插图。
     *
     * 与状态条扫描完全隔离：用 ROW_MARK 在「行根元素」上打标记做幂等，
     * 因此同一行不会被反复插图；行的 DOM 被 React 重建后标记随之消失，会重新插一张。
     * @param {ReturnType<typeof createState>} state
     * @param {boolean} still reduced-motion 下是否走静态首帧
     */
    function scanActions(state, still) {
      var names = state.names
      if (names.length === 0) return // 没素材 → 静默跳过
      var size = readSize()
      var count = ACTION_SELECTORS.length

      // 一次性查全文 `[data-variant]` 再按属性值分桶：8 次全文档查询降为 1 次。
      // spec.selector 字符串仍保留在 ACTION_SELECTORS 里（离线自检 / 可读性），运行时不再逐条查询。
      var buckets = Object.create(null)
      var found
      try {
        found = document.querySelectorAll('[data-variant]')
      } catch {
        return
      }
      for (var n = 0; n < found.length; n += 1) {
        var key = found[n].getAttribute('data-variant')
        if (key === null) continue
        var bucket = buckets[key]
        if (bucket === undefined) {
          bucket = []
          buckets[key] = bucket
        }
        bucket.push(found[n])
      }

      for (var i = 0; i < count; i += 1) {
        var spec = ACTION_SELECTORS[i]
        // 具名映射优先（think→thinking.webp …），缺图时回退到第 i 张轮换。
        var name = resolveActionName(names, spec.variant)
        if (name === undefined) continue
        var hits = buckets[spec.variant]
        if (hits === undefined) continue
        for (var k = 0; k < hits.length; k += 1) {
          var row = hits[k]
          // 幂等：行根带标记 **且** 行内动作图还在 → 跳过。
          // 只判标记是不够的：React 复用行根、只替换子节点时 img 消失而标记留下，
          // 该行会永久失去插图（removeAllImages 的全局清理也覆盖不到这条路径）。
          if (row.getAttribute(ROW_MARK) !== null) {
            if (row.querySelector('img[' + MARK + '][' + ROLE_ATTR + '="action"]') !== null) continue
            row.removeAttribute(ROW_MARK)
          }
          // 已插过（含被子元素重扫命中的情况）→ 补标记后跳过。
          if (row.querySelector('img[' + MARK + '][' + ROLE_ATTR + '="action"]') !== null) {
            row.setAttribute(ROW_MARK, spec.variant)
            continue
          }
          var mount
          try {
            mount = findActionMount(row)
          } catch {
            continue
          }
          if (mount === null) continue
          var img = createImage(name, size, spec.variant)
          try {
            if (mount.before !== undefined && mount.before !== null) {
              mount.before.parentNode.insertBefore(img, mount.before)
            } else {
              mount.mount.prepend(img)
            }
          } catch {
            continue // 结构不符合预期 → 跳过该行，不抛错
          }
          row.setAttribute(ROW_MARK, spec.variant)
          state.inserted.add(img)
          if (still) freezeInPlace(img)
        }
      }
    }

    /**
     * 单轮扫描：给每个缺少标记的状态条 prepend 一张图，再扫动作行。
     * 调用方负责 observer 的 disconnect/observe。
     * @param {ReturnType<typeof createState>} state
     */
    function scan(state) {
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

      var still = prefersReducedMotion() && !motionForced()

      // —— 动作行（写/思考/命令/搜索/读/编辑/代码 + others 兜底）——
      // 放在状态条之前：动作行数量多，且任一行异常都被内部 try/catch 兜住。
      try {
        scanActions(state, still)
      } catch {
        // 动作行是增量功能：整体失败也不能挡住下面的状态条。
      }

      var rows
      try {
        rows = collectHosts()
      } catch {
        return
      }
      if (rows.length === 0) return

      var name = currentName(state)
      if (name === undefined) return // 没有素材 → 静默不插入

      var size = readSize()

      for (var i = 0; i < rows.length; i += 1) {
        var host = rows[i]
        // 幂等：宿主内部（含 runningContent 挂点）已有标记就跳过。
        // 注意不能往上查父链 —— 父链可能包着别的状态行，会误跳过。
        if (host.querySelector('[' + MARK + ']') !== null) continue
        var mount = findMount(host)
        var img = createImage(name, size)
        try {
          mount.prepend(img)
        } catch {
          continue
        }
        state.inserted.add(img)
        if (still) freezeInPlace(img)
      }
    }

    /**
     * 一轮安全扫描：disconnect → scan → observe（防自激）。
     * @param {ReturnType<typeof createState>} state
     */
    function safeScan(state) {
      var observer = state.observer
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

    /** 设置页面板样式：类名一律 `__sa_` 前缀，作用域仅限面板内部，不动聊天区任何样式。 */
    var PANEL_CSS = [
      '.__sa_root{display:flex;flex-direction:column;gap:12px;font-size:13px;line-height:1.5;',
      'color:var(--dsw-alias-label-primary,CanvasText)}',
      '.__sa_title{margin:0;font-size:13px;font-weight:600}',
      '.__sa_row{display:flex;align-items:center;gap:10px}',
      '.__sa_label{flex:0 0 auto;min-width:48px;opacity:.8}',
      '.__sa_row input[type=range]{flex:1;min-width:0}',
      '.__sa_row select{flex:1;min-width:0;background:Field;color:FieldText;',
      'border:1px solid rgba(127,127,127,.4);border-radius:6px;padding:3px 6px;font:inherit}',
      '.__sa_value{flex:0 0 auto;min-width:38px;text-align:right;opacity:.7;',
      'font-variant-numeric:tabular-nums}',
      '.__sa_hint{opacity:.55;font-size:11px}',
      '.__sa_caption{font-size:11px;opacity:.6}',
      '.__sa_preview{display:flex;align-items:center;justify-content:center;gap:10px;min-height:64px;',
      'padding:8px;border-radius:8px;border:1px dashed rgba(127,127,127,.45);',
      'background:rgba(127,127,127,.08)}',
      '.__sa_preview img{object-fit:contain;display:block}',
      '.__sa_previewText{font-size:12px;opacity:.75;white-space:nowrap}',
    ].join('')

    /** 注入面板样式（幂等）。 */
    function ensureStyle() {
      if (document.querySelector('style[' + UI_MARK + '="style"]') !== null) return
      var style = document.createElement('style')
      style.setAttribute(UI_MARK, 'style')
      style.textContent = PANEL_CSS
      var host = document.head === null ? document.documentElement : document.head
      if (host === null) return
      host.appendChild(style)
    }

    /**
     * 取 React：client 载体的 `factory(require)` 能解析平台 seed 词，
     * dsh-boot-suite/lib/client.js:28 就是 `var react = require('react')`
     * （同一个 `window.__ModuleLoader__.load({id, factory})` 契约）。
     * 解析失败不抛错：返回 null，调用方跳过设置页注册，动画本体不受影响。
     * @returns {object|null}
     */
    var reactRef = null
    function getReact() {
      if (reactRef !== null) return reactRef
      try {
        var mod = require('react')
        if (mod !== null && mod !== undefined && typeof mod.createElement === 'function') reactRef = mod
      } catch {
        reactRef = null
      }
      if (reactRef === null && typeof window !== 'undefined') {
        var fallback = window.React
        if (fallback && typeof fallback.createElement === 'function') reactRef = fallback
      }
      return reactRef
    }

    /** 当前素材名单（面板取值与预览共用）。 */
    function currentNames() {
      var state = live.state
      if (state === null || state.stopped) return []
      return state.names
    }

    /** 把面板拉到的新名单回写进 state，让动画侧立刻用上（旧面板的既有行为）。 */
    function adoptNames(names) {
      var state = live.state
      if (state === null || state.stopped) return
      state.names = names
      state.fetchedAt = Date.now()
    }

    /**
     * 造设置面板组件（React 函数组件，零 props）。
     * 状态读写全部复用既有 KEY_* 与 readSize/isEnabled/readPicked，
     * 改动后调 flush() —— 与旧的命令式面板走同一条即时通道。
     * @param {object} React
     * @returns {Function} 零参函数组件
     */
    function buildPanelComponent(React) {
      var h = React.createElement
      var useState = React.useState
      var useEffect = React.useEffect

      function Panel() {
        var sizeState = useState(readSize())
        var size = sizeState[0]
        var setSize = sizeState[1]

        var enabledState = useState(isEnabled())
        var enabled = enabledState[0]
        var setEnabled = enabledState[1]

        var pickedState = useState(readPicked())
        var picked = pickedState[0]
        var setPicked = pickedState[1]

        var namesState = useState(currentNames())
        var names = namesState[0]
        var setNames = namesState[1]

        // 一次性补拉真实名单；卸载后不再 setState（唯一的异步副作用，无定时器/监听）。
        useEffect(function () {
          var alive = true
          fetchNames()
            .then(function (next) {
              if (!alive || next.length === 0) return
              adoptNames(next)
              setNames(next)
            })
            .catch(function () {
              // 列表拉不到：下拉只留「随机」，动画侧不受影响。
            })
          return function () {
            alive = false
          }
        }, [])

        var keptPick = picked !== PICK_RANDOM && names.indexOf(picked) >= 0 ? picked : PICK_RANDOM
        var previewName = keptPick !== PICK_RANDOM ? keptPick : names[0]
        // 面板里放大到至少 32px，否则 18px 的动图肉眼难辨认（旧面板同款）。
        var shown = Math.max(32, size)

        var options = [h('option', { key: '__sa_random', value: PICK_RANDOM }, '随机')]
        for (var i = 0; i < names.length; i += 1) {
          options.push(h('option', { key: '__sa_' + names[i], value: names[i] }, names[i]))
        }

        var preview = h(
          'div',
          { className: '__sa_preview' },
          previewName === undefined
            ? null
            : h('img', {
                src: fileUrl(previewName),
                alt: '',
                draggable: false,
                style: { width: String(shown) + 'px', height: String(shown) + 'px' },
              }),
          h(
            'span',
            { className: '__sa_previewText' },
            previewName === undefined ? '（素材目录为空）' : '深度求索中，用时 52 秒 ···'
          )
        )

        return h(
          'div',
          { className: '__sa_root' },
          h('h4', { className: '__sa_title' }, '状态条动画'),
          h(
            'div',
            { className: '__sa_row' },
            h('span', { className: '__sa_label' }, '启用'),
            h('input', {
              type: 'checkbox',
              checked: enabled,
              onChange: function (event) {
                var next = event.target.checked === true
                writeSetting(KEY_ENABLED, next ? '1' : '0')
                setEnabled(next)
                flush({ retarget: false })
              },
            })
          ),
          h(
            'div',
            { className: '__sa_row' },
            h('span', { className: '__sa_label' }, '尺寸'),
            h('input', {
              type: 'range',
              min: String(MIN_SIZE),
              max: String(MAX_SIZE),
              step: '1',
              value: String(size),
              onChange: function (event) {
                var next = Math.round(Number.parseFloat(event.target.value))
                if (!Number.isFinite(next)) return
                writeSetting(KEY_SIZE, String(next))
                setSize(next)
                flush({ retarget: false })
              },
            }),
            h('span', { className: '__sa_value' }, String(size) + 'px')
          ),
          h(
            'div',
            { className: '__sa_row' },
            h('span', { className: '__sa_label' }, '素材'),
            h(
              'select',
              {
                value: keptPick,
                onChange: function (event) {
                  var next = event.target.value
                  writeSetting(KEY_PICKED, next)
                  setPicked(next)
                  flush({ retarget: true })
                },
              },
              options
            )
          ),
          h('div', { className: '__sa_caption' }, '实时预览（与状态行同尺寸）'),
          preview,
          h('div', { className: '__sa_hint' }, '素材来自 ~/.dsh/status-anim/，改动即时生效。')
        )
      }

      return Panel
    }

    /**
     * 注册「设置 → 状态动画」菜单项（React 面板）。
     * 守卫由调用方提供；本函数自身也整体 try/catch，失败只损失设置页。
     * @param {{slots?: any}} ctx
     */
    function registerSettings(ctx) {
      try {
        ensureStyle()
      } catch {
        // 样式失败不影响面板结构。
      }
      var React = getReact()
      if (React === null) return
      var h = React.createElement
      var Panel = buildPanelComponent(React)
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          { name: 'settings.section', id: 'status-anim', order: 29, label: '状态动画' },
          function () {
            return h(Panel, {})
          }
        )
      })
    }

    /** @returns {() => void} 启动，返回清理函数 */
    function start() {
      var state = createState()
      if (typeof document === 'undefined') return function () {}

      live.state = state

      // observer 触发的扫描节流句柄：流式输出时 DOM 变动可达每秒数十次，
      // 每轮都全文档扫描才是真正的掉帧源。16ms ≈ 一帧，合并同一帧内的多次变动。
      // 注意：只节流 observer 入口，flush()（设置即时生效）与轮询兜底仍然直通。
      var scanTimer = null

      // 首扫放在微任务后，避免与宿主首帧渲染抢时序。
      var kickoff = function () {
        if (state.stopped) return
        if (document.body === null) {
          window.setTimeout(kickoff, 50)
          return
        }
        try {
          var observer = new MutationObserver(function () {
            if (scanTimer !== null) return
            scanTimer = window.setTimeout(function () {
              scanTimer = null
              if (state.stopped) return
              safeScan(state)
            }, 16)
          })
          state.observer = observer
          observer.observe(document.body, { childList: true, subtree: true })
        } catch {
          state.observer = null
        }
        // 轮询兜底：某些状态下 React 只改文本、不增删节点，observer 可能不触发。
        state.timer = window.setInterval(function () {
          safeScan(state)
        }, POLL_MS)
        safeScan(state)
      }
      kickoff()

      return function cleanup() {
        state.stopped = true
        if (scanTimer !== null) {
          window.clearTimeout(scanTimer)
          scanTimer = null
        }
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
        if (typeof state.disposeExtra === 'function') {
          try {
            state.disposeExtra()
          } catch {
            // ignore
          }
          state.disposeExtra = null
        }
        removeAllImages(state)
        state.names = []
        if (live.state === state) live.state = null
      }
    }

    /**
     * 插件入口：零服务依赖，只用 effect 托住清理。
     * 先起路径 A（核心动画），再延后一拍尝试路径 B（设置 UI）。
     * @param {{ effect?: (fn: () => (() => void)) => void }} ctx
     */
    function apply(ctx) {
      if (ctx === undefined || ctx === null || typeof ctx.effect !== 'function') {
        // 缺失 effect 时仍尽力工作（不返回清理器），保持零崩溃。
        start()
      } else {
        ctx.effect(function () {
          return start()
        })
      }

      // 路径 B：注册「设置 → 状态动画」菜单项。
      // 此时路径 A 的 observer 与轮询已经在跑，B 无论怎样失败都碰不到 A。
      // 双重守卫：ctx.slots 缺失（老部署 / inject 未生效）时直接跳过，绝不抛错。
      if (ctx && ctx.slots && typeof ctx.slots.inject === 'function') {
        try {
          window.setTimeout(function () {
            try {
              registerSettings(ctx)
            } catch {
              // 设置页注册失败不是核心功能，静默降级。
            }
          }, 0)
        } catch {
          // ignore
        }
      }
    }

    exports.apply = apply
    exports.inject = ['slots']
    // 供离线自检断言（宿主不读）。
    exports.__internals = {
      SELECTOR: SELECTOR,
      MARK: MARK,
      UI_MARK: UI_MARK,
      readSize: readSize,
      isEnabled: isEnabled,
      readPicked: readPicked,
      flush: flush,
      registerSettings: registerSettings,
      buildPanelComponent: buildPanelComponent,
    }
    return module.exports
  },
})
