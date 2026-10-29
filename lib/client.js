/**
 * dsh-status-anim — Web 客户端半边（CJS 工厂，由 dsh-client-modules 装载）
 *
 * 载体格式对齐 DSH 0.2.1-rc.3 的 client bundle 契约
 * （见 dsh-client-ui-chat/lib/client.js）：`window.__ModuleLoader__.load({ id, factory })`，
 * id 必须等于包名（dsh-client-modules/lib/index.js:903 graphRow(packageName, ...)）。
 *
 * inject 为空（零服务依赖，动画本体不依赖任何服务）。
 * 设置面板通过 `ctx.get('slots')` 探测后注册到 settings.section 槽位；无 slots 时只保留动画，
 * 不显示面板。为什么不用 `ctx.slots`：cordis 的 inject 同时是「可访问性白名单」，未声明而直读
 * ctx.slots 会抛 `cannot get property "slots" without inject` 并令整条 fiber 不 apply；
 * 而 `ctx.get()` 不检查 inject，未提供时返回 undefined，故用它探测。
 *
 * 【两条完全隔离的执行路径】
 *   路径 A（核心）：素材列表 + MutationObserver + prepend <img>。
 *     代码只用 DOM/effect，不读任何服务，永远不被 slots 的缺席拖死。
 *   路径 B（设置 UI，允许失败）：经 `ctx.get('slots')` 探测到 slots 后，
 *     `slots.register('settings.section', …)` 的 React 面板；带 try/catch + 有限重试，
 *     所以 B 抛错或永不可用时 A 照常在观察 DOM。
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
     * 目录内可含多种格式（png / gif / webp），但只有 animated WebP / 真 APNG 会过宿主白名单
     * （当前实际可用 4 个 webp）。4 张 < 7+1 类动作时，多出来的动作槽位会按 names[i % N] 复用前面的图，
     * 同一屏内的映射始终稳定（重扫/换会话都不会跳图）。
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
    /** 逐动作素材映射（JSON 字符串）：「每类动作各选一张图」靠它。 */
    var KEY_MAP = 'dsh-status-anim.map'

    /** 「随机」素材的取值（空串 = 由插件随机挑）。 */
    var PICK_RANDOM = ''

    /**
     * 逐动作映射里「随机」的取值（与状态条的 PICK_RANDOM 空串不同源：
     * 空串在那里是随机、在 map 里却是「用默认映射」，所以随机必须另立哨兵值）。
     */
    var MAP_RANDOM = '__random__'

    /** 8 个合法动作变体（与 ACTION_SELECTORS 同序；map 只认这些键，多余键一律忽略）。 */
    var ACTION_VARIANTS = ACTION_SELECTORS.map(function (spec) {
      return spec.variant
    })

    /**
     * 读逐动作映射。
     *
     * 语义：缺键 / 空串 = 用默认映射（ACTION_ASSET）；`__random__` = 随机；其它 = 素材文件名。
     * 任何异常（JSON 非法 / 顶层不是对象 / 已知键的值不是字符串）一律返回空对象 ——
     * 存储被手改坏时宁可全走默认映射，也绝不抛错污染宿主事件循环。
     * @returns {Object<string, string>}
     */
    function readMap() {
      var raw = readSetting(KEY_MAP)
      if (raw === undefined || raw === '') return {}
      var parsed
      try {
        parsed = JSON.parse(raw)
      } catch {
        return {}
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      var out = {}
      for (var i = 0; i < ACTION_VARIANTS.length; i += 1) {
        var variant = ACTION_VARIANTS[i]
        if (!Object.prototype.hasOwnProperty.call(parsed, variant)) continue
        var value = parsed[variant]
        // 值类型不对 → 整份视为损坏（宁可全默认，也不要半套映射）。
        if (typeof value !== 'string') return {}
        // 空串 = 默认映射：不落盘、不返回，保持 map 稀疏。
        if (value === '') continue
        out[variant] = value
      }
      return out
    }

    /**
     * 写逐动作映射：只保留 8 个合法变体、跳过空串与非法值。
     * @param {Object<string, string>} obj
     */
    function writeMap(obj) {
      var clean = {}
      if (obj !== null && typeof obj === 'object') {
        for (var i = 0; i < ACTION_VARIANTS.length; i += 1) {
          var variant = ACTION_VARIANTS[i]
          var value = obj[variant]
          if (typeof value !== 'string' || value === '') continue
          clean[variant] = value
        }
      }
      writeSetting(KEY_MAP, JSON.stringify(clean))
    }

    /**
     * 取某变体的配置值。
     * @param {string|null} variant
     * @returns {string} `''`（默认映射）/ `'__random__'` / 素材文件名
     */
    function getActionPick(variant) {
      if (variant === null || variant === undefined) return ''
      var map = readMap()
      var value = map[variant]
      return typeof value === 'string' ? value : ''
    }

    /**
     * 改某变体的配置值（读-改-写回；传空串即删除该键，回到默认映射）。
     * @param {string} variant
     * @param {string} value
     */
    function setActionPick(variant, value) {
      if (variant === null || variant === undefined) return
      if (ACTION_VARIANTS.indexOf(variant) < 0) return
      var map = readMap()
      if (typeof value === 'string' && value !== '') map[variant] = value
      else delete map[variant]
      writeMap(map)
    }

    /** @param {string} key 删设置项（恢复默认用；失败静默） */
    function removeSetting(key) {
      var store = storage()
      if (store === undefined) return
      try {
        store.removeItem(key)
      } catch {
        // 隐私模式：只丢这一次重置，动画继续跑。
      }
    }

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
     * @param {boolean} [square] 是否按正方形定高；省略时由 variant 推断（状态条=方形，动作行=宽度主导）
     * @returns {HTMLImageElement}
     */
    function createImage(name, size, variant, square) {
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
      // 状态条图仍是正方形（宿主给的是 16px 方形位，方形语义不能变）；
      // 动作行图只控宽度、高度 auto：素材是 128×107 的非方图，硬定高等于裁切。
      var isSquare = square === true || (square === undefined && variant === undefined)
      img.style.width = px
      img.style.height = isSquare ? px : 'auto'
      img.style.objectFit = 'contain'
      img.style.verticalAlign = 'middle'
      // 动作行允许 flex 收缩（'0 1 auto'），避免超宽时撑破行；状态条保持不压缩。
      img.style.flex = isSquare ? '0 0 auto' : '0 1 auto'
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
      // 手动换图（retarget）→ 作废被改那一个的 stamp，让新字节立刻生效。
      // changedVariant：'*' = 全部重置（恢复默认），具体变体名 = 只动该动作行，
      // 不传 = 状态条自身（改「状态条素材」）。
      if (opts.retarget === true) {
        var changed = opts.changedVariant
        // 随机缓存只作废「被改的那个变体」；全清只留给恢复默认，避免改一行让其它行重掷骰子。
        if (changed === '*') randomPicks = Object.create(null)
        else if (typeof changed === 'string' && changed !== '') delete randomPicks[changed]
        if (typeof changed === 'string' && changed !== '' && changed !== '*') {
          var actionName = resolveActionName(state.names, changed)
          if (actionName !== undefined) invalidateStamp(actionName)
        } else {
          var retargeted = currentName(state)
          if (retargeted !== undefined) invalidateStamp(retargeted)
        }
      }
      var px = String(readSize()) + 'px'
      var name = currentName(state)
      var names = state.names
      state.inserted.forEach(function (el) {
        if (!el.isConnected) return
        el.style.width = px
        // 动作行（role=action）高度保持 auto，与 createImage 的方形判定保持一致；
        // 状态条图是正方形，继续同步高度。
        el.style.height = el.getAttribute(ROLE_ATTR) === 'action' ? 'auto' : px
        // 动作行图走「变体 → 素材下标」轮换映射，不能被状态条用的 name 覆盖，
        // 否则所有动作行会变成同一张图（丢失轮换效果）。
        var role = el.getAttribute(ROLE_ATTR)
        if (role === 'action') {
          // 动作行按「变体 → 具名素材」重新解析，不能被状态条的 currentName() 覆盖。
          var actionName = resolveActionName(names, el.getAttribute(VARIANT_ATTR))
          if (actionName === undefined) return
          // 只有该行素材真的变了才改 src：否则改「思考」会让窗口内 30 张动图
          // 全部重新下载解码（一次卡顿），并且与 P1-1 的重掷骰子叠加成突变。
          if (actionName !== el.dataset.statusAnimName) {
            invalidateStamp(actionName)
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
     * map 里配成 `__random__` 的变体 → 上次抽中的名字。
     *
     * 为什么必须缓存：refreshInserted 每轮拿新名字对比，若每次都真随机会让整片动作行
     * 每轮扫描都换图（几十行 × 每次重解码 = 白掉的 CPU）。抽中后固定，只有那张图被删
     * 才重抽 —— 用户看到的仍是「随机」，只是随机只在名单变化时才重新掷骰子。
     */
    var randomPicks = Object.create(null)

    /** @param {string} variant @param {string[]} names @returns {string|undefined} 稳定的随机图 */
    function randomFor(variant, names) {
      var cached = randomPicks[variant]
      if (typeof cached === 'string' && names.indexOf(cached) >= 0) return cached
      var next = pick(names)
      if (next !== undefined) randomPicks[variant] = next
      else delete randomPicks[variant]
      return next
    }

    /**
     * 该变体在素材名单里该用哪张图（唯一取图入口：状态条之外的 8 类动作都走这里）。
     *
     * 优先级严格自上而下（任一步命中即返回）：
     *   1) map 里指定的具体文件名 —— 文件已不在名单里（被删）则视为未配置，继续往下；
     *   2) map[variant] === '__random__' —— 从名单随机取一张；
     *   3) ACTION_ASSET 默认基名匹配（thinking.webp / working_command.webp …）；
     *   4) 老的轮换映射 names[index % N]；
     *   5) 名单为空 → undefined（调用方不插图）。
     * @param {string[]} names 素材名单（已排序）
     * @param {string|null} variant 动作变体
     * @returns {string|undefined}
     */
    function resolveActionName(names, variant) {
      if (names.length === 0) return undefined
      var chosen = variant === null || variant === undefined ? '' : getActionPick(variant)
      // 1) 用户指定且文件仍在 → 直接用。
      if (chosen !== '' && chosen !== MAP_RANDOM && names.indexOf(chosen) >= 0) return chosen
      // 2) 用户指定随机 → 随机（指定文件失效时**不**当作随机，往下走默认映射）。
      if (chosen === MAP_RANDOM) return randomFor(variant, names)
      var base = variant === null || variant === undefined ? undefined : ACTION_ASSET[variant]
      if (base === undefined) base = ACTION_ASSET.others
      // 3) 默认基名映射。
      for (var e = 0; e < ACTION_ASSET_EXTS.length; e += 1) {
        var wanted = base + ACTION_ASSET_EXTS[e]
        if (names.indexOf(wanted) >= 0) return wanted
      }
      // 4) 轮换回退。
      var index = indexOfVariant(variant)
      if (index < 0) index = ACTION_SELECTORS.length - 1
      return names[index % names.length]
    }

    /**
     * 同时在页面上挂动图的动作行上限。
     *
     * 为什么必须有：活动流没有虚拟化，长会话 100–1000+ 行动作行全留在 DOM 里，
     * 每张动图 180–353KB，解码后的原始帧还要再乘帧数 —— 几百行同时挂图 =
     * 数百 MB 解码缓冲 + 几十个并发解码线程，体积与 DOM 双双在涨，掉帧是必然的。
     * 因此只给「最新的 MAX_ACTION_ROWS 行」挂图，更早的行退化为纯文本。
     * 「最新」= DOM 中靠后的行（更靠近会话底部 / 当前时间）。
     * 窗口每轮扫描重新判定（不靠一次性标记），所以新消息进来后老行滑入窗口即可正常插图。
     */
    var MAX_ACTION_ROWS = 30

    /**
     * 回收单行上的动作图并清掉 ROW_MARK：让被裁掉的历史行回到纯文本，
     * 同时释放它的解码资源（图片元素脱离 DOM 后浏览器才会回收动画帧）。
     * @param {ReturnType<typeof createState>} state
     * @param {Element} row
     */
    function clearRowMark(row) {
      if (row === null || row === undefined) return
      // 1. 行根自身
      try {
        row.removeAttribute(ROW_MARK)
      } catch {
        // ignore
      }
      // 2. 行内所有后代（含行内 disclosure-row）：只清 row 会漏掉这套语义
      try {
        var inner = row.querySelectorAll('[' + ROW_MARK + ']')
        for (var i = 0; i < inner.length; i += 1) inner[i].removeAttribute(ROW_MARK)
      } catch {
        // ignore
      }
      // 3. 整条祖先链：标记现在打到多层（宿主 root 的 contain:size 会把行内容挡住），
      //    只清 row 自身会让「容器仍被撑高 / 仍被锁 24px」的中间层永远留着标记。
      try {
        var chain = rowChainOf(row)
        for (var c = 1; c < chain.length; c += 1) chain[c].removeAttribute(ROW_MARK)
      } catch {
        // ignore
      }
      // 4. 最近的祖先 disclosure-row：标记可能打在 row 子树之外的 holder 上
      try {
        var holder = row.closest('[data-disclosure-row]')
        if (holder !== null && holder !== row) holder.removeAttribute(ROW_MARK)
      } catch {
        // ignore
      }
    }

    /**
     * 需要放行高度的最大向上层数（含行根自身）。实测 size=96 的祖先链是
     * 行根 → disclosure-row → … → 宿主 `_root`(i=3, contain:size) → 无类名包装层(i=4)
     * → `_body`(i=5, 仍锁 24px)，即至少要标记到第 6 层（i=0..5 = 6 层）。
     * 5 层只能覆盖 i=0..4，i=5 漏掉后整层仍按 24px 排版 → 与后续 flowItem 重叠。
     * 故取 8 层，给不同部署再留两档余量；真正的扩散由 rowChainOf 的停止条件兜底。
     */
    var ROW_CHAIN_MAX = 8

    /** 该元素是否被定位成浮层（fixed/absolute）：浮层不该被行内容撑高。 */
    function isFloating(el) {
      try {
        var pos = window.getComputedStyle(el).position
        return pos === 'fixed' || pos === 'absolute'
      } catch {
        return false
      }
    }

    /**
     * 从动作行根向上的「放行链」：`[row, ...祖先]`，索引 0 恒为 row。
     *
     * 为什么必须向上多层：宿主 ToolRow 外层 `_root` 带 `contain:size layout`
     * + `height:calc(24px + delta)`，`contain:size` 让高度不依赖内容 ——
     * 只给行根/disclosure-row 放行时，容器依旧按 24px 排版，行内容溢出后
     * 与后续 flowItem 正面重叠。因此把标记沿祖先链打上去，让每层都 height:auto。
     * 停止条件：body/documentElement、浮层、`[data-chat-flow]` 及其直接子级边界
     * （再往上就会把整片会话撑开），或最多 ROW_CHAIN_MAX 层。
     * @param {Element} row 动作行根
     * @returns {Element[]} 可打标记的元素（首元素是 row）
     */
    function rowChainOf(row) {
      var chain = [row]
      var node = row.parentElement
      while (node !== null && node !== undefined && chain.length < ROW_CHAIN_MAX) {
        var tag = node.tagName
        if (tag === 'BODY' || tag === 'HTML') break
        if (node.hasAttribute('data-chat-flow')) break // 会话容器本身不放行
        if (isFloating(node)) break
        chain.push(node)
        // 已抵达 chat-flow 直接子级边界 → 到此为止，不再向上扩散。
        try {
          if (node.parentElement !== null && node.parentElement.hasAttribute('data-chat-flow')) break
        } catch {
          break
        }
        node = node.parentElement
      }
      return chain
    }

    /**
     * 该动作行当前是否处于「折叠不可见」态。
     *
     * 宿主在消息完成后会把动作行整体折叠为 h=0（本来靠 overflow:hidden 裁掉内容来隐藏）。
     * 我们为撑开展开态加的 `overflow:visible !important` 放行会让**折叠后被裁掉的内容
     * 重新显形**，图就压住后续 markdown（实测 size=96：行被折成 0 高，图仍在 80.3px
     * 高度上显示并盖住 P/CODE/LI/OL）。
     *
     * 判据只信「宿主原生高度」：链上**未带 ROW_MARK** 的层（我们的标记会让 height:auto
     * + overflow:visible，高度不再代表宿主真实折叠状态）。行根未标记时它自己就是原生高度
     * （折叠 0 / 展开 24px+），一旦被标记则可退到链上第一个未标记层判定。
     * 全部被标记（链达 ROW_CHAIN_MAX 上限）时按可见处理，避免误杀展开态。
     *
     * 每轮动态求值、不缓存：用户点开折叠行后高度恢复，下一轮 scan 自然重新插图。
     * @param {Element} row 动作行根
     * @returns {boolean} true=折叠态（不该插图，已有图与标记要撤掉）
     */
    function rowFolded(row) {
      var chain
      try {
        chain = rowChainOf(row)
      } catch {
        return false // 判定失败按可见处理，不阻断功能
      }
      try {
        for (var c = 0; c < chain.length; c += 1) {
          var el = chain[c]
          if (el.getAttribute(ROW_MARK) !== null) continue
          var cs = window.getComputedStyle(el)
          // display:contents 的元素**不生成盒子**，其子节点照常参与布局，
          // 因此 clientHeight / getBoundingClientRect().height / getClientRects() 恒为 0。
          // 这个 0 与折叠无关（宿主拿它做无类名包装层），必须先跳过再判高度，
          // 否则链上第一个未标记层总是它 → 每一行都被误判折叠 → 全员禁插 + 反向撤图。
          if (cs.display === 'contents') continue
          // display:none 的层整棵子树都不参与布局 → 真折叠。
          if (cs.display === 'none') return true
          // 不是 contents 却连一个盒子都没有 → 同样属于真不可见。
          if (el.getClientRects().length === 0) return true
          // 有盒子但高度被压成 0：宿主折叠行就是「h=0 + overflow:hidden」裁内容 → 真折叠。
          if (el.getBoundingClientRect().height <= 0.5) return true
        }
      } catch {
        return false
      }
      return false
    }

    /**
     * 记下「本轮确实含本插件动作图」的行及其 holder（查找顺序与 markDisclosureAncestor 一致）。
     * 只有它们有权持有 ROW_MARK，其余标记一律视为孤儿。
     * @param {Set<Element>|null} legit
     * @param {Element} row
     */
    function collectLegitRowMarks(legit, row) {
      if (legit === null || legit === undefined) return
      try {
        legit.add(row)
      } catch {
        // ignore
      }
      // 祖先链上的每一层都是合法持有者，否则每轮 sweep 会把它们当孤儿摘掉、
      // 行又缩回 24px 造成「撑开→塌陷」抖动。
      try {
        var chain = rowChainOf(row)
        for (var c = 0; c < chain.length; c += 1) legit.add(chain[c])
      } catch {
        // ignore
      }
      try {
        var holder = row.querySelector('[data-disclosure-row]')
        if (holder === null) holder = row.closest('[data-disclosure-row]')
        if (holder !== null) legit.add(holder)
      } catch {
        // ignore
      }
    }

    /**
     * 孤儿标记清扫：全文档 ROW_MARK 中不属于 legit 的一律摘掉。
     * 幂等、行数级别开销；ROW_MARK 只服务动作行与 CSS 放行，状态条走 MARK 域，不会误伤。
     * @param {Set<Element>|null} legit
     */
    function sweepOrphanRowMarks(legit) {
      try {
        var marked = document.querySelectorAll('[' + ROW_MARK + ']')
        for (var i = 0; i < marked.length; i += 1) {
          var el = marked[i]
          if (legit !== null && legit !== undefined && legit.has(el)) continue
          el.removeAttribute(ROW_MARK)
        }
      } catch {
        // ignore
      }
    }

    function reclaimActionRow(state, row) {
      var imgs
      try {
        imgs = row.querySelectorAll('img[' + MARK + '][' + ROLE_ATTR + '="action"]')
      } catch {
        return
      }
      for (var i = 0; i < imgs.length; i += 1) {
        var img = imgs[i]
        try {
          if (img.parentNode !== null) img.parentNode.removeChild(img)
        } catch {
          // ignore
        }
        if (typeof state.inserted.delete === 'function') state.inserted.delete(img)
      }
      // 行根 + 行后代 + 行外 holder 一次清干净，只清一种会留下被永久撑高的元素。
      clearRowMark(row)
    }

    /**
     * 多选择器扫描动作行并插图。
     *
     * 与状态条扫描完全隔离：用 ROW_MARK 在「行根元素」上打标记做幂等，
     * 因此同一行不会被反复插图；行的 DOM 被 React 重建后标记随之消失，会重新插一张。
     * 只处理 DOM 中最新的 MAX_ACTION_ROWS 行，其余行的图会被回收（见 reclaimActionRow）。
     * @param {ReturnType<typeof createState>} state
     * @param {boolean} still reduced-motion 下是否走静态首帧
     */
    function scanActions(state, still) {
      var names = state.names
      if (names.length === 0) return // 没素材 → 静默跳过
      var size = readSize()

      // 一次性查全文 `[data-variant]` 再按属性值分桶：8 次全文档查询降为 1 次。
      // querySelectorAll 返回文档序，正好用来切「最新 N 行」窗口。
      var found
      try {
        found = document.querySelectorAll('[data-variant]')
      } catch {
        return
      }

      var rows = []
      for (var n = 0; n < found.length; n += 1) {
        var hit = found[n]
        var variant = hit.getAttribute('data-variant')
        if (variant === null) continue
        if (ACTION_VARIANTS.indexOf(variant) < 0) continue
        // 只认最外层行根：宿主行内含带 data-variant 的嵌套节点（如 [data-disclosure-row] 子行）时，
        // 父子各算一行会稀释 MAX_ACTION_ROWS 预算，且父行被 reclaim 会连带拔掉子行的图。
        if (hit.parentElement && hit.parentElement.closest('[data-variant]') !== null) continue
        rows.push(hit)
      }
      if (rows.length === 0) {
        // 没有任何动作行 → 文档里不存在合法 holder，残留标记全属孤儿（脱离图的旧标记）。
        sweepOrphanRowMarks(null)
        return
      }

      // 本轮合法持有标记的元素集合：只有确实含本插件动作图的行 / holder 才能留在集合里。
      // 结尾用它做一次孤儿清扫，杜绝「图没了但标记还在」的元素被 CSS 永久撑高。
      var legit = new Set()

      // 窗口 = 文档里靠后的 MAX_ACTION_ROWS 行；窗口之前的历史行回收掉图。
      var keepFrom = rows.length - MAX_ACTION_ROWS
      if (keepFrom < 0) keepFrom = 0
      for (var cut = 0; cut < keepFrom; cut += 1) reclaimActionRow(state, rows[cut])

      for (var r = keepFrom; r < rows.length; r += 1) {
        var row = rows[r]
        var rowVariant = row.getAttribute('data-variant')
        // 折叠态（宿主把该行折成 h=0）→ 不插图，并把已有的图与标记全撤掉。
        // 必要性：我们为确保展开态撑开而加了 overflow:visible !important，这会让折叠态下
        // 本应被 overflow:hidden 裁掉的内容（含我们的图）重新显形，压住后续 markdown。
        // 判定每轮实时求值（不缓存），用户点开折叠行后高度恢复 → 下一轮自动重新插图。
        if (rowFolded(row)) {
          reclaimActionRow(state, row) // 移除行内动作图（非状态条图）+ clearRowMark
          continue
        }
        // 具名映射优先（think→thinking.webp …），缺图时回退到第 i 张轮换。
        var name = resolveActionName(names, rowVariant)
        if (name === undefined) {
          // 该行插不了图 → 它和它的 holder 都不该留标记（否则 holder 被永久撑高）。
          clearRowMark(row)
          continue
        }
        // 幂等：行根带标记 **且** 行内动作图还在 → 跳过。
        // 只判标记是不够的：React 复用行根、只替换子节点时 img 消失而标记留下，
        // 该行会永久失去插图（removeAllImages 的全局清理也覆盖不到这条路径）。
        if (row.getAttribute(ROW_MARK) !== null) {
          if (row.querySelector('img[' + MARK + '][' + ROLE_ATTR + '="action"]') !== null) {
            collectLegitRowMarks(legit, row)
            continue
          }
          // 标记在、图没了 → 行根与 holder 的标记一并作废。
          clearRowMark(row)
        }
        // 已插过（含被子元素重扫命中的情况）→ 补标记后跳过。
        if (row.querySelector('img[' + MARK + '][' + ROLE_ATTR + '="action"]') !== null) {
          row.setAttribute(ROW_MARK, rowVariant)
          markDisclosureAncestor(row)
          collectLegitRowMarks(legit, row)
          continue
        }
        var mount
        try {
          mount = findActionMount(row)
        } catch {
          clearRowMark(row)
          continue
        }
        if (mount === null) {
          clearRowMark(row)
          continue
        }
        var img = createImage(name, size, rowVariant)
        try {
          if (mount.before !== undefined && mount.before !== null) {
            mount.before.parentNode.insertBefore(img, mount.before)
          } else {
            mount.mount.prepend(img)
          }
        } catch {
          clearRowMark(row)
          continue // 结构不符合预期 → 跳过该行，不抛错
        }
        row.setAttribute(ROW_MARK, rowVariant)
        markDisclosureAncestor(row)
        collectLegitRowMarks(legit, row)
        state.inserted.add(img)
        if (still) freezeInPlace(img)
      }

      // 根治：本轮所有合法 holder 之外的 ROW_MARK 一律摘掉。
      sweepOrphanRowMarks(legit)
    }

    /**
     * 给「含本插件动作图」的行打放行标记：行根 + 行内 disclosure-row + 祖先链。
     *
     * 为什么要链：动作行的图由 `findActionMount` 插在同一祖先下，而行根（带 data-variant
     * 的元素）不一定是 `[data-disclosure-row]` 本身；更关键的是宿主 ToolRow 外层容器带
     * `contain:size layout` + 固定 24px，只放行行根会让容器按 24px 排版、行内容溢出到
     * 后续 flowItem 上（实测重叠 6552px²）。祖先链见 rowChainOf。
     * 只标记确实含本插件动作图的祖先，绝不标记无图行。
     * @param {Element} row 已插图的行根
     */
    function markDisclosureAncestor(row) {
      try {
        // 优先「行内」的 disclosure-row（本行自己的那一层），避免向上 closest 命中
        // 外层容器导致把整块历史都撑高；行内没有才退回最近的祖先。
        var holder = row.querySelector('[data-disclosure-row]')
        if (holder === null) holder = row.closest('[data-disclosure-row]')
        if (holder !== null) holder.setAttribute(ROW_MARK, '1')
      } catch {
        // ignore
      }
      // 祖先链逐层打标记：外层容器的 contain:size 才是高度不跟着长高的根因。
      try {
        var chain = rowChainOf(row)
        for (var c = 0; c < chain.length; c += 1) chain[c].setAttribute(ROW_MARK, '1')
      } catch {
        // ignore
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

    /** 强制拉一次素材清单（设置面板用；不走 2s 节流，打开面板即最新）。 */
    async function fetchNames() {
      try {
        var res = await fetch(LIST_URL, { cache: 'no-store' })
        if (!res.ok) return []
        // 与 refreshList 共用同一份过滤，杜绝「下拉干净、状态行脏」的通道差。
        return sanitizeNames(await res.json())
      } catch {
        return []
      }
    }

    /**
     * 预览尺寸映射：`shown = clamp(size * PREVIEW_SCALE, PREVIEW_MIN, PREVIEW_MAX)`。
     *
     * 为什么不用固定下限 `max(128, size)`：滑块范围 8–96 全在 128 以下，那个写法在整个
     * 区间恒等于 128 → 拉滑块预览毫无变化（实测 size=18 与 size=96 都是 128×126）。
     * 改成倍率后全程单调递增：18→64（下限兜底）、48→72、96→144，既有可见变化，
     * 又保证小尺寸仍可读、大尺寸不撑爆面板。
     */
    var PREVIEW_SCALE = 1.5
    /** 预览最小边长：低于它就看不清（可读下限，不是素材原生尺寸）。 */
    var PREVIEW_MIN = 64
    /** 预览最大边长：再大就会把设置面板撑高。 */
    var PREVIEW_MAX = 200
    /** 预览容器上下 padding 之和（8+8），容器高 = 图边长 + 它。 */
    var PREVIEW_PAD = 16

    /**
     * 由聊天区实际尺寸算出预览边长（纯函数，便于自检单调性）。
     * @param {number} size 聊天区动图边长（px）
     * @returns {number} 预览边长（整数 px，落在 [PREVIEW_MIN, PREVIEW_MAX]）
     */
    function previewSizeFor(size) {
      var scaled = Math.round(size * PREVIEW_SCALE)
      if (scaled < PREVIEW_MIN) return PREVIEW_MIN
      if (scaled > PREVIEW_MAX) return PREVIEW_MAX
      return scaled
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
      // 动作动画分组：2 列紧凑网格（长会话里 8 个下拉不占满屏）。
      '.__sa_group{display:flex;flex-direction:column;gap:8px;padding:8px;border-radius:8px;',
      'border:1px solid rgba(127,127,127,.35)}',
      '.__sa_grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 10px}',
      '.__sa_field{display:flex;align-items:center;gap:6px;min-width:0}',
      '.__sa_field .__sa_label{min-width:44px;font-size:12px}',
      '.__sa_field select{flex:1;min-width:0;background:Field;color:FieldText;',
      'border:1px solid rgba(127,127,127,.4);border-radius:6px;padding:2px 4px;font:inherit;',
      'font-size:12px}',
      '.__sa_actions{display:flex;align-items:center;gap:10px}',
      '.__sa_button{background:Field;color:FieldText;border:1px solid rgba(127,127,127,.45);',
      'border-radius:6px;padding:3px 10px;font:inherit;font-size:12px;cursor:pointer}',
      // —— 动作行放行（只作用于含本插件动作图的行，全局其它行零影响）——
      // 宿主 DisclosureRow/ToolRow 是固定 24px + overflow:hidden + align-items:center，
      // 大图会被上下对称裁切；这里用「本插件自己打的 data-status-anim-row 标记」精确放行，
      // 绝不全局解开所有行（24px 是宿主与测试锁定的契约）。
      // 关键：链上每一层都可能带 `contain:size layout`（宿主 _root），而 contain:size 会让
      // 元素高度不依赖内容 —— 不覆盖 contain，height:auto 也拿不到内容高度，容器仍按 24px
      // 排版，行内容溢出后与后续 flowItem 重叠。故这里一律 contain:none。
      // 特异性不足必须靠 !important：宿主规则形如
      // `.xxx_root:not([data-expanded]){contain:size layout;height:calc(24px + …)}`，
      // 特异性 (0,2,0) > 我们的属性选择器 (0,1,0)，不加 !important 时 height:auto/contain:none
      // 会被压过，该层仍锁 24px、图继续溢出去重叠（实机 i=3 层已复现）。
      // 只给「必须覆盖」的布局属性加 !important，其余保持普通声明，维持最小侵入。
      // 注意：`overflow:visible !important` 在这里**有意不按展开/折叠态收窄**。
      // 宿主折叠态用 h=0 + overflow:hidden 隐藏内容，我们的放行确实会让它显形，
      // 但该问题已由 JS 侧 `rowFolded()`（折叠态不插图并撤掉已有图与标记）根治；
      // 收窄 CSS 需要押住宿主的 `[data-expanded]` 语义，一旦判错就会破坏「展开态撑开」
      // 这个已实测生效的修复，故保持无差别放行，由 JS 保证折叠态行上没有图。
      '[' + ROW_MARK + ']{height:auto !important;min-height:0 !important;',
      'max-height:none !important;contain:none !important;overflow:visible !important}',
      '[data-disclosure-row][' + ROW_MARK + ']',
      '{height:auto !important;min-height:calc(24px + var(--dsh-content-font-delta,0px)) !important;',
      'overflow:visible !important;align-items:center}',
      // 图标位 .leading 是 16px 固定 inline-flex：含图行也放开高度，避免裁掉溢出部分。
      '[data-disclosure-row][' + ROW_MARK + ']>span:first-child',
      '{height:auto !important;min-height:calc(16px + var(--dsh-content-font-delta,0px)) !important;',
      'overflow:visible !important;width:auto !important;align-self:center}',
      // 图自身：高度随比例、居中对齐、不超出所在行宽度。
      'img[' + MARK + '][' + ROLE_ATTR + '="action"]{height:auto;max-width:100%;',
      'align-self:center;vertical-align:middle}',
      // 行变高后宿主 ::after 的 sweep 光带会被拉成整图高（视觉变淡）且 left:100% 后
      // 300px 光带溢出到右侧 —— 对含本插件图的行抑制该 sweep。
      '[data-disclosure-row][' + ROW_MARK + ']::after{animation:none;opacity:0}',
      // —— 预览区：高度跟随尺寸（由 React inline style 下发），这里只锁盒子模型 ——
      // 不再写死 height，否则大尺寸预览会被裁；min-height 兜住空素材时的塌陷。
      '.__sa_preview{min-height:64px;box-sizing:border-box}',
      '.__sa_preview img{max-width:100%;max-height:100%}',
      '.__sa_previewNote{font-size:11px;opacity:.7;',
      'color:var(--dsw-alias-label-primary,CanvasText);font-variant-numeric:tabular-nums}',
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

    /** 8 类动作的中文名（面板下拉与预览共用，顺序即 ACTION_SELECTORS 顺序）。 */
    var ACTION_LABELS = {
      write: '写入',
      think: '思考',
      bash: '运行命令',
      search: '搜索',
      read: '读取',
      edit: '编辑',
      code: '代码',
      others: '其他',
    }

    /**
     * 造设置面板组件（React 函数组件，零 props）。
     * 状态读写全部复用既有 KEY_* 与 readSize/isEnabled/readPicked/readMap，
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

        // 逐动作映射：整份对象进 state（改一项即换新对象，React 才会重渲染）。
        var mapState = useState(readMap())
        var map = mapState[0]
        var setMap = mapState[1]

        // 强制播放动画（motion=force，绕过系统 reduced-motion）。
        var forcedState = useState(motionForced())
        var forced = forcedState[0]
        var setForced = forcedState[1]

        // 预览对象：'status' = 状态条，其余为动作变体名。
        var previewState = useState('status')
        var previewVariant = previewState[0]
        var setPreviewVariant = previewState[1]

        // 「恢复默认设置」的二次点击确认态：confirm 被宿主禁用时的替代路径。
        var confirmingState = useState(false)
        var confirming = confirmingState[0]
        var setConfirming = confirmingState[1]

        /** 真正执行重置（confirm 可用时一次点即到；不可用时第二次点击进入这里）。 */
        function resetAll() {
          removeSetting(KEY_SIZE)
          removeSetting(KEY_ENABLED)
          removeSetting(KEY_PICKED)
          removeSetting(KEY_MAP)
          removeSetting(KEY_MOTION)
          // 本地 state 同步回落默认值，避免面板还停在旧值上。
          setSize(readSize())
          setEnabled(isEnabled())
          setPicked(readPicked())
          setMap(readMap())
          setForced(motionForced())
          setConfirming(false)
          // changedVariant:'*' → 随机缓存全清 + 所有图重取（重置语义）。
          flush({ retarget: true, changedVariant: '*' })
        }

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
        // 预览跟随滑块尺寸：shown 由倍率映射得到，全程单调递增（见 previewSizeFor）。
        var shown = previewSizeFor(size)
        // 展示用倍率（一位小数）：触摸到 PREVIEW_MIN/MAX 时会不等于 PREVIEW_SCALE，
        // 所以按实际 shown/size 反算，保证文案不撒谎。
        var previewRatio = Math.round((shown / (size > 0 ? size : 1)) * 10) / 10

        var options = [h('option', { key: '__sa_random', value: PICK_RANDOM }, '随机')]
        for (var i = 0; i < names.length; i += 1) {
          options.push(h('option', { key: '__sa_' + names[i], value: names[i] }, names[i]))
        }

        /** 动作下拉的选项：默认 + 随机 + 全量素材。 */
        function actionOptions() {
          var list = [
            h('option', { key: '__sa_default', value: '' }, '默认'),
            h('option', { key: '__sa_random', value: MAP_RANDOM }, '随机'),
          ]
          for (var j = 0; j < names.length; j += 1) {
            list.push(h('option', { key: '__sa_n_' + names[j], value: names[j] }, names[j]))
          }
          return list
        }

        /** 当前生效值：存的文件名已不在名单里 → 回显「默认」（但不清 localStorage）。 */
        function shownPick(variant) {
          var value = map[variant]
          if (typeof value !== 'string' || value === '') return ''
          if (value === MAP_RANDOM) return MAP_RANDOM
          return names.indexOf(value) >= 0 ? value : ''
        }

        var fields = []
        for (var f = 0; f < ACTION_VARIANTS.length; f += 1) {
          fields.push(
            h(
              'div',
              { className: '__sa_field', key: '__sa_field_' + ACTION_VARIANTS[f] },
              h('span', { className: '__sa_label' }, ACTION_LABELS[ACTION_VARIANTS[f]]),
              h(
                'select',
                {
                  value: shownPick(ACTION_VARIANTS[f]),
                  onChange: (function (variant) {
                    return function (event) {
                      var next = event.target.value
                      setActionPick(variant, next)
                      setMap(readMap())
                      if (confirming) setConfirming(false)
                      flush({ retarget: true, changedVariant: variant })
                    }
                  })(ACTION_VARIANTS[f]),
                },
                actionOptions()
              )
            )
          )
        }

        // 预览名：状态条沿用旧语义（currentName 等价），动作走新的取图优先级。
        var shownName =
          previewVariant === 'status' ? previewName : resolveActionName(names, previewVariant)

        var previewOptions = [h('option', { key: '__sa_pv_status', value: 'status' }, '状态条')]
        for (var p = 0; p < ACTION_VARIANTS.length; p += 1) {
          previewOptions.push(
            h(
              'option',
              { key: '__sa_pv_' + ACTION_VARIANTS[p], value: ACTION_VARIANTS[p] },
              ACTION_LABELS[ACTION_VARIANTS[p]]
            )
          )
        }

        var preview = h(
          'div',
          {
            className: '__sa_preview',
            // 容器高度跟随预览图边长 + 上下 padding：放大尺寸时预览区一起变大。
            style: { height: String(shown + PREVIEW_PAD) + 'px' },
          },
          shownName === undefined
            ? null
            : h('img', {
                src: fileUrl(shownName),
                alt: '',
                draggable: false,
                style: {
                  width: String(shown) + 'px',
                  height: String(shown) + 'px',
                  maxWidth: '100%',
                },
              }),
          h(
            'span',
            { className: '__sa_previewText' },
            shownName === undefined
              ? names.length === 0
                ? '（素材目录为空）'
                : '该类动作不使用素材'
              : '深度求索中，用时 52 秒 ···'
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
            // 只作用于状态条，不影响上方「动作动画」的逐行映射（resolveActionName 不读此键）。
            h('span', { className: '__sa_label' }, '状态条素材'),
            h(
              'select',
              {
                value: keptPick,
                onChange: function (event) {
                  var next = event.target.value
                  writeSetting(KEY_PICKED, next)
                  setPicked(next)
                  if (confirming) setConfirming(false)
                  flush({ retarget: true })
                },
              },
              options
            )
          ),
          // —— 逐动作素材：每类动作各选一张图（2 列紧凑网格）——
          h(
            'div',
            { className: '__sa_group' },
            h('div', { className: '__sa_label' }, '动作动画'),
            h('div', { className: '__sa_grid' }, fields)
          ),
          h(
            'div',
            { className: '__sa_row' },
            h('span', { className: '__sa_label' }, '强制播放'),
            h('input', {
              type: 'checkbox',
              checked: forced,
              onChange: function (event) {
                var next = event.target.checked === true
                // 勾选写 force；取消则删键 → 回到「跟随系统减动效」。
                if (next) writeSetting(KEY_MOTION, 'force')
                else removeSetting(KEY_MOTION)
                setForced(next)
                flush({ retarget: false })
              },
            }),
            h('span', { className: '__sa_hint' }, '系统要求减少动效时仍播放')
          ),
          h(
            'div',
            { className: '__sa_row' },
            h('span', { className: '__sa_label' }, '预览动作'),
            h(
              'select',
              {
                value: previewVariant,
                onChange: function (event) {
                  setPreviewVariant(event.target.value)
                },
              },
              previewOptions
            )
          ),
          h('div', { className: '__sa_caption' }, '实时预览（跟随尺寸）'),
          preview,
          h(
            'div',
            { className: '__sa_previewNote' },
            // 文案与新语义一致：预览是「放大后的示意」，聊天区才是实际渲染尺寸。
            '预览 ' +
              String(shown) +
              'px' +
              (previewRatio === 1 ? '' : '（放大 ' + String(previewRatio) + '×）') +
              ' · 聊天区实际 ' +
              String(size) +
              'px'
          ),
          h(
            'div',
            { className: '__sa_actions' },
            h(
              'button',
              {
                type: 'button',
                className: '__sa_button',
                // 鼠标离开 → 退出二次确认态，避免「悬停后隔很久再点」被误确认。
                onMouseLeave: function () {
                  if (confirming) setConfirming(false)
                },
                onClick: function () {
                  // Electron / 部分 webview 里 confirm 可能被禁用（返回 false）或直接抛错，
                  // 此时降级为「二次点击确认」：不执行，只换文案并把状态置为 confirming。
                  if (confirming === true) {
                    resetAll()
                    return
                  }
                  var ok = false
                  try {
                    ok =
                      typeof window.confirm === 'function'
                        ? window.confirm('确定恢复默认设置？当前所有自定义将被清除。') === true
                        : false
                  } catch {
                    ok = false
                  }
                  if (ok === true) {
                    resetAll()
                    return
                  }
                  setConfirming(true)
                },
              },
              confirming === true ? '再次点击确认恢复' : '恢复默认设置'
            )
          ),
          h('div', { className: '__sa_hint' }, '素材来自 ~/.dsh/status-anim/，改动即时生效。')
        )
      }

      return Panel
    }

    /**
     * 注册「设置 → 状态动画」菜单项（React 面板）。
     * slots 由调用方探测后传入（本插件 inject 为空，不声明 slots 依赖）。
     * 失败只损失设置页，核心动画不受影响。
     * @param {any} ctx
     * @param {{inject: Function, register: Function}} slots
     */
    function registerSettings(ctx, slots) {
      try {
        ensureStyle()
      } catch {
        // 样式失败不影响面板结构。
      }
      var React = getReact()
      if (React === null) return
      var h = React.createElement
      var Panel = buildPanelComponent(React)
      slots.inject('settings.section', function () {
        return slots.register(
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
     * 零服务依赖：slots 用 ctx.get 探测（不检查 inject，缺失返 undefined）。
     * @param {any} ctx
     * @returns {boolean} 是否注册成功
     */
    function tryRegisterSettings(ctx) {
      var slots = null
      try {
        if (ctx && typeof ctx.get === 'function') slots = ctx.get('slots')
        else if (ctx && ctx.slots) slots = ctx.slots // 兼容：若某些环境 inject 已放行
      } catch (e) { slots = null }
      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return false
      try { registerSettings(ctx, slots) } catch (e) { return false }
      return true
    }

    /**
     * 插件入口：零服务依赖，只用 effect 托住清理。
     * 先起路径 A（核心动画），再有限重试路径 B（设置 UI）。
     * @param {{ effect?: (fn: () => (() => void)) => void, get?: Function }} ctx
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
      // 不声明 inject ⇒ 不等待 slots ⇒ slots 可能晚于本插件就绪，故有限重试：
      // 立即试一次，失败则每 300ms 重试，最多 5 次（共 ~1.5s），成功或次数用尽即停。
      var REGISTER_RETRY_MS = 300
      var REGISTER_MAX_TRIES = 5
      var tries = 0
      var done = false
      function attempt() {
        if (done) return
        if (tryRegisterSettings(ctx)) {
          done = true
          return
        }
        tries += 1
        if (tries >= REGISTER_MAX_TRIES) {
          done = true // 次数用尽：放弃设置页，核心动画照常。
          return
        }
        try {
          window.setTimeout(attempt, REGISTER_RETRY_MS)
        } catch {
          done = true
        }
      }
      try {
        window.setTimeout(attempt, 0)
      } catch {
        // ignore：无 window 时不注册设置页。
      }
    }

    exports.apply = apply
    exports.inject = []
    // 供离线自检断言（宿主不读）。
    exports.__internals = {
      SELECTOR: SELECTOR,
      MARK: MARK,
      UI_MARK: UI_MARK,
      readSize: readSize,
      isEnabled: isEnabled,
      readPicked: readPicked,
      // 逐动作映射与取图优先级（离线自检 / 回归探针用）。
      readMap: readMap,
      writeMap: writeMap,
      getActionPick: getActionPick,
      setActionPick: setActionPick,
      resolveActionName: resolveActionName,
      motionForced: motionForced,
      MAX_ACTION_ROWS: MAX_ACTION_ROWS,
      flush: flush,
      registerSettings: registerSettings,
      buildPanelComponent: buildPanelComponent,
    }
    return module.exports
  },
})
