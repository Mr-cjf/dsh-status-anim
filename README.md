# dsh-status-anim

给 DSH Web GUI 的 **「Deep diving...」状态提示条** 加一个你自己的动图（APNG / 动画 WebP；GIF 与 AVIF 不支持）。
**放文件即换图，零重建、零重启。**
7 类动作各挂各的图：思考、命令、搜索、读写各有专属动图，不再全靠一张随机图。

> 本文对应 **v0.4.0**（包版本以 package.json 为准）

## 一句话用法

把动图丢进 `~/.dsh/status-anim/`（Windows：`C:\Users\14023\.dsh\status-anim\`），刷新页面即可看到。
想换图：删掉旧的、放进新的 —— 不需要重新构建、不需要重启 `dsh web`。

按文件名前缀决定它挂在哪一类动作上（名字即语义）：

```
~/.dsh/status-anim/
  thinking.webp           # 思考中（think）
  working.webp            # 通用工作态（write / read / code / others）
  working_command.webp    # 执行命令、编辑文件（bash / edit）
  working_search.webp     # 搜索（search）
```

动作 → 素材的映射是固定约定：

| 动作 | 素材文件 |
| --- | --- |
| `think` | `thinking.webp` |
| `bash` | `working_command.webp` |
| `search` | `working_search.webp` |
| `write` / `read` / `code` / `others` | `working.webp` |
| `edit` | `working_command.webp` |

## 原理

| 半边 | 做什么 |
| --- | --- |
| host (`lib/index.js`) | 用 `ctx.webServer.register({ kind: 'prefix', path: '/status-anim' })` 把素材目录以只读 HTTP 暴露出来 |
| client (`lib/client.js`) | 路径 A：`MutationObserver` 盯住 `document.body`，命中 `[data-chat-flow] [role="status"][aria-live="polite"]` 就 `row.prepend(<img>)`；路径 B：通过 `settings.section` 槽位注册 React 面板（设置页左侧菜单「状态动画」） |

关键点：
- 前缀是 `/status-anim`（**不带尾斜杠**，宿主匹配规则是 `pathname === prefix || pathname.startsWith(prefix + '/')`）。
- `/plugins` 前缀已被 `dsh-client-modules` 占用，本插件不使用它。
- client 侧 `exports.inject = []`：**零服务依赖**，动画本体不依赖任何服务，加载失败面降到最小。设置面板走 `ctx.get('slots')` **探测**而非注入（不检查 inject、缺失时返回 `undefined`），探测到才注册；**无 slots 的环境里只保留动画、不显示面板**，动画绝不会被面板拖垮。
- 所有响应带 `Cache-Control: no-store`，client 侧 `src` 还带时间戳，所以**同名覆盖**也能立刻看到新字节。
- 观察器回调里先 `disconnect`、处理完再 `observe`，避免自己插入的节点把观察器打成死循环。
- 拿不到列表 / 目录为空 / 请求失败 → 静默不插入，**绝不影响宿主**。

## 接口

| 路由 | 说明 |
| --- | --- |
| `GET /status-anim/list` | JSON 数组：目录下所有允许的图片文件名，按名字排序 |
| `GET /status-anim/file/<name>` | 图片本体，带正确 `Content-Type` |
| `GET /status-anim/` | 自述 JSON：素材目录绝对路径 + 可用路由（人工排查用） |

允许的扩展名：`.apng` `.png` `.webp`（`.gif`、`.avif` 已从白名单移除，放进目录也不会被收）。
**静态图片会被剔除**：只接受真动图——`.apng` / `.png` 必须含 `acTL` 块（**`.png` 必须是真 APNG，否则不收**），`.webp` 必须含 `ANIM` / `ANMF` 块（仅 animated WebP），静态图一律不收（扩展名只是第一道筛子，真正的判定是按块结构遍历）。
安全性：`path.resolve` + `startsWith` 目录穿越防护（与 `dsh-host-frontend-static` 同法），并且拒绝以 `.` 开头的文件名和带路径分隔符的名字。

## 设置面板（设置页 → 状态动画）

设置页左侧菜单里多一项 **「状态动画」**（`settings.section` 槽位，`order: 29`），点进去就是本插件的面板，改动**即时生效、无需刷新**：

| 控件 | 作用 | localStorage 键 |
| --- | --- | --- |
| 启用 复选框 | 关 → 状态条上的图立刻消失；开 → 立刻回来 | `dsh-status-anim.enabled` |
| 尺寸 滑块 | 8–96px，拖动时状态条上的图实时缩放 | `dsh-status-anim.size` |
| 素材 下拉 | 「随机」或 `/status-anim/list` 里的任一文件，选中即换图 | `dsh-status-anim.picked` |
| 实时预览 | 当前生效的动图即时预览，改尺寸/素材立刻反映 | — |

面板是 React 组件，注册参数固定为：

```js
ctx.slots.register({
  name: 'settings.section', id: 'status-anim', order: 29, label: '状态动画'
}, Panel)
```

样式只用 `Canvas` / `CanvasText` / `Field` 等系统色，自动跟随深浅色主题。

### 为什么是「探测 slots」而不是 inject

`exports.inject = []` 是硬红线：它是**模块级唯一**的声明，cordis 的 fiber 依赖全有或全无——一旦为设置面板 inject 了 `slots` 等服务，核心动画所在的同一个 fiber 也一起背上这些依赖，任一部署缺服务就会整条 fiber 不 apply，动画和面板同归于尽。

因此改为运行时探测：`const slots = ctx.get('slots')`，拿到才注册 `settings.section`，拿不到就静默跳过。这样：

| 路径 | 内容 | 失败后果 |
| --- | --- | --- |
| A（核心） | 拉列表 + MutationObserver + `prepend(<img>)` + 轮询兜底 + 7 类动作映射 | 不允许失败；零服务依赖、零 import |
| B（设置） | `settings.section` 槽位注册的 React 面板 + `flush()` 即时通道 | 整体 `try/catch`，失败只损失面板 |

`apply()` 先 `ctx.effect(() => start())` 把 A 跑起来，再尝试 B。所以 B 无论怎么炸，A 的 observer 与轮询都已在运行。两条路径唯一的耦合是一个 `live.state` 引用：它为 `null` 时面板只是改不动动画，绝不会反向影响 A。

## 可选配置（浏览器 localStorage）

面板改的就是这几个键；也可以在 devtools 控制台直接设，刷新即生效：

```js
localStorage.setItem('dsh-status-anim.size', '24')      // 尺寸 px，8..96，默认 18
localStorage.setItem('dsh-status-anim.enabled', '0')    // 关闭：'0'/'false'/'off'/'no' → 不插入
localStorage.setItem('dsh-status-anim.picked', 'whale.webp') // 指定素材；空串 = 随机
localStorage.setItem('dsh-status-anim.motion', 'force') // 系统开着「减少动效」时仍然播放
```

旧键名完全沿用（向后兼容）：已有用户手设的值不会丢，面板打开时会读回并显示。
`dsh-status-anim.picked` 指向的文件被删掉时自动退回「随机」，不会卡在空白图。

默认遵循 `prefers-reduced-motion: reduce`：此时会取动图第一帧做静态降级（若浏览器不支持解码则退回直接显示动图）。

## 素材来源

默认动图取自 GitHub [`QCYTSN/dsh-dafeiyu`](https://github.com/QCYTSN/dsh-dafeiyu)（**MIT 许可，需署名**）的透明 WebP 帧序列，用 Pillow 合成：412×344 源 → 缩放 128px 宽，~220–230 帧，24fps，562–692KB/个。

## 默认素材（装完即有动画）

安装后**自带 12 张默认动图**，无需任何手动配置即可看到效果：

`head_pat` `waiting` `thinking` `working` `working_search` `eat_token` `working_command` `tail` `success` `error` `poke` `idle`

- 素材随包分发在 `assets/*.webp`（12 个 animated WebP，128×107，合计 2.75 MiB）。
- 想**追加**：把新图放进 `~/.dsh/status-anim/`，`/status-anim/list` 会把用户素材与默认素材合并返回。
- 想**覆盖**默认图：在 `~/.dsh/status-anim/` 放**同名**文件即可 —— 同名时用户目录优先，包内默认图不再重复出现。
- 两处都为空时才返回空列表（此时 client 静默跳过，不影响宿主）。

素材来源：[`QCYTSN/dsh-dafeiyu`](https://github.com/QCYTSN/dsh-dafeiyu)（**MIT 许可，需署名**）。
逐文件的规格、上游精确路径与 sha256 见 `assets/NOTICE.md`。

## 安装到 profile

`package.json` 里已经有了 `dsh.bundle.patch` 与 `dsh.client` 声明，profile 侧只需两条：

```jsonc
// ~/.dsh/profiles/web/package.json
{
  "dependencies": { "dsh-status-anim": "link:C:/Users/14023/myproject/dsh-status-anim" },
  "dsh": { "profile": { "bundles": [ /* … */, "dsh-status-anim" ] } }
}
```

然后在该 profile 目录 `pnpm install`，重启 `dsh web`。

## 开发说明

**没有构建步骤。** `lib/index.js` 与 `lib/client.js` 是**最终产物**，直接改、直接生效。
`src/` 下的同名 `.ts` 文件**仅供类型参照**（供 `tsc --noEmit` 与阅读用），**不是构建输入**，改了 `src/*.ts` 不会影响运行；要改行为请改 `lib/*.js`。

`lib/client.js` 的载体格式必须保持 `window.__ModuleLoader__.load({ id: 'dsh-status-anim', factory })`，
`id` 必须等于包名（`dsh-client-modules` 用包名作为 boot graph 的行 id）。

## License

MIT
