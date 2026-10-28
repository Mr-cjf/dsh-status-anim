# dsh-status-anim

给 DSH Web GUI 的 **「Deep diving...」状态提示条** 加一个你自己的动图（GIF / APNG / WebP / PNG / AVIF）。
**放文件即换图，零重建、零重启。**

## 一句话用法

把动图丢进 `~/.dsh/status-anim/`（Windows：`C:\Users\14023\.dsh\status-anim\`），刷新页面即可看到。
想换图：删掉旧的、放进新的 —— 不需要重新构建、不需要重启 `dsh web`。

```
~/.dsh/status-anim/
  diving.gif
  whale.webp
  dots.apng
```

> 本文对应 **v0.1.0**（包版本以 package.json 为准）

## 原理

| 半边 | 做什么 |
| --- | --- |
| host (`lib/index.js`) | 用 `ctx.webServer.register({ kind: 'prefix', path: '/status-anim' })` 把素材目录以只读 HTTP 暴露出来 |
| client (`lib/client.js`) | 路径 A：`MutationObserver` 盯住 `document.body`，命中 `[data-chat-flow] [role="status"][aria-live="polite"]` 就 `row.prepend(<img>)`；路径 B：右下角齿轮 + 自绘设置面板 |

关键点：
- 前缀是 `/status-anim`（**不带尾斜杠**，宿主匹配规则是 `pathname === prefix || pathname.startsWith(prefix + '/')`）。
- `/plugins` 前缀已被 `dsh-client-modules` 占用，本插件不使用它。
- client 侧 `inject = []`：rc.3 里 `settingsScope` 服务不存在（实际叫 `configForms`），本插件纯 DOM 操作，零服务依赖 = 零挂载风险。
- 所有响应带 `Cache-Control: no-store`，client 侧 `src` 还带时间戳，所以**同名覆盖**也能立刻看到新字节。
- 观察器回调里先 `disconnect`、处理完再 `observe`，避免自己插入的节点把观察器打成死循环。
- 拿不到列表 / 目录为空 / 请求失败 → 静默不插入，**绝不影响宿主**。

## 接口

| 路由 | 说明 |
| --- | --- |
| `GET /status-anim/list` | JSON 数组：目录下所有允许的图片文件名，按名字排序 |
| `GET /status-anim/file/<name>` | 图片本体，带正确 `Content-Type` |
| `GET /status-anim/` | 自述 JSON：素材目录绝对路径 + 可用路由（人工排查用） |

允许的扩展名：`.gif` `.apng` `.png` `.webp` `.avif`。
安全性：`path.resolve` + `startsWith` 目录穿越防护（与 `dsh-host-frontend-static` 同法），并且拒绝以 `.` 开头的文件名和带路径分隔符的名字。

## 可视化设置面板（齿轮按钮）

页面**右下角**有一个半透明 ⚙ 齿轮按钮，点开就是设置卡片，改动**即时生效、无需刷新**：

| 控件 | 作用 | localStorage 键 |
| --- | --- | --- |
| 启用 复选框 | 关 → 状态条上的图立刻消失；开 → 立刻回来 | `dsh-status-anim.enabled` |
| 尺寸 滑块 | 8–96px，拖动时状态条上的图实时缩放 | `dsh-status-anim.size` |
| 素材 下拉 | 「随机」或 `/status-anim/list` 里的任一文件，选中即换图 | `dsh-status-anim.picked` |

按钮位置 `right:14px; bottom:96px`（避开右下角输入区），`z-index` 高于聊天层。样式只用 `Canvas` / `CanvasText` / `Field` 等系统色，自动跟随深浅色主题。

### 为什么是自绘面板，而不是设置页里的原生卡片

rc.3 的插件设置卡片要注册进 `plugins.item` 槽位，源码形状是
（`dsh-client-ui-settings-shell/lib/client.js:182-189`）：

```js
ctx.effect(() => ctx.configForms.whileServed([BASH_NS, PWSH_NS], (served) =>
  ctx.slots.inject("plugins.item", () => ctx.slots.register({
    name: "plugins.item", id: "shell", order: 40,
    label: () => t("title"), locale: NS,
    inject: () => ({ hooks: {...}, ...form.actions() })
  }, ShellCard))), "ui-settings-shell: page");
```

它有两条本插件无法接受的约束：

1. **卡片必须是 React 组件**，靠 `require("react/jsx-runtime")` + `props.view` / `props.hooks` 渲染，
   还得配 `SettingsFormModel` / `settingsNumberField` 一整套表单模型（同文件 `:66-110`、`:119-148`）。
2. 服务靠**模块级唯一的** `exports.inject` 声明（同文件 `:161-165`
   `const inject = ["slots", "locale", "configForms"]`）。cordis 的 fiber 依赖是全有或全无：
   只要为设置卡片 inject 了服务，**核心动画所在的同一个 fiber 也一起背上这些依赖**——
   任一部署缺服务，整条 fiber 不 apply，动画和设置界面同归于尽。

这与「核心动画绝不能被设置界面拖垮」的红线直接冲突，所以选择自绘面板，
`inject: []` 这个护城河一点不破。

### 两条路径的隔离

| 路径 | 内容 | 失败后果 |
| --- | --- | --- |
| A（核心） | 拉列表 + MutationObserver + `prepend(<img>)` + 轮询兜底 | 不允许失败；零服务依赖、零 import |
| B（设置） | 齿轮按钮 + 浮动面板 + `flush()` 即时通道 | 整体 `try/catch` + `setTimeout(...,0)` 延后一拍，失败只损失面板 |

`apply()` 先 `ctx.effect(() => start())` 把 A 跑起来，再延后一拍尝试 B。所以 B 无论怎么炸，
A 的 observer 与轮询都已在运行。两条路径唯一的耦合是一个 `live.state` 引用：
它为 `null` 时面板只是改不动动画，绝不会反向影响 A。

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

**没有构建步骤。** `lib/index.js` 与 `lib/client.js` 就是手写的产物，直接改、直接生效。
`src/` 下同名 `.ts` 文件是等价的类型化源码参照（供 `tsc --noEmit` 与阅读用），**不是构建输入**，
改了 `src/*.ts` 不会影响运行；要改行为请改 `lib/*.js`。

`lib/client.js` 的载体格式必须保持 `window.__ModuleLoader__.load({ id: 'dsh-status-anim', factory })`，
`id` 必须等于包名（`dsh-client-modules` 用包名作为 boot graph 的行 id）。

## License

MIT
