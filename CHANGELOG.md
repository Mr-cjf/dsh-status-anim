# Changelog

本项目的所有重要变更都记录在此文件。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 2026-10-29

> 0.2.0 计划为首个经由 CI/OIDC（GitHub Actions + npm Trusted Publishing）发布的版本，带 provenance 证明；0.1.0 为本地手动发布。

### 新增

- **7 类动作各自挂图**：`write` / `think` / `bash` / `search` / `read` / `edit` / `code`（含 `others`）各自挂自己的动图，不再只挂状态条。
- **逐动作独立配置**：新增 `dsh-status-anim.map` 存储键（JSON），可单独指定每类动作用哪张图——空串 = 默认、`__random__` = 随机、其它 = 目录内文件名。
- **强制播放动画**：新增「强制播放动画」设置项（`dsh-status-anim.motion` = `force`），绕过系统「减少动效」偏好。
- **恢复默认设置**：新增按钮，两次点击确认（兼容禁用 `confirm` 的 webview），一键回到默认开关 / 尺寸 / 素材 / 映射。
- **逐动作预览**：设置页新增下拉，可查看任一动作实际会用到哪张图。

### 变更

- **设置入口迁移**：从页面右下角齿轮 FAB（`mountSettings()`）迁到设置页左侧菜单「状态动画」——注册 `{ name: 'settings.section', id: 'status-anim', order: 29, label: '状态动画' }`，面板改用 React 组件重写，随设置页主题与布局。
- 预览区改为固定 128px 放大显示，不随尺寸滑块跳动，并标注实际生效尺寸。
- 设置面板通过 `ctx.get('slots')` 探测注册，`exports.inject` 保持 `[]`（零服务依赖）；无 `slots` 的环境只保留动画、不显示面板。

### 移除

- 删除 `mountSettings()` 齿轮按钮与命令式 DOM 浮窗（自绘卡片、固定 `right/bottom` 定位、手工样式）。
- 素材格式白名单移除 `.gif` 与 `.avif`；`.png` 仅接受真 APNG（含 `acTL` 块），`.webp` 仅接受 animated（含 `ANIM` / `ANMF` 块）。

### 修复

- 素材格式校验改为按 PNG / WebP 块结构遍历，修复大 `iCCP` 块导致合法动图被误判为静态而静默隐藏。
- 修复 `?t=` 时间戳每行独立导致同一动图被重复下载（改为模块级 stamp 表复用）。
- 修复尺寸放大后被宿主动作行 24px 固定行高上下裁切（去掉方形假设、只控宽度，并用 `data-status-anim-row` 标记精确放行行高）。
- 修复 `data-status-anim-row` 标记泄漏导致行被永久撑高（统一清理 + 孤儿标记清扫）。
- 动作行挂图限制为最新 30 行（`MAX_ACTION_ROWS`），避免长会话性能退化。
- `MutationObserver` 增加 16ms 节流。

### 说明

- 素材取自 GitHub `QCYTSN/dsh-dafeiyu`（MIT 许可，需署名）的透明 WebP 帧序列，Pillow 合成（412×344 源 → 128px 宽，~220–230 帧，24fps，562–692KB/个）。

## [0.1.0] - 2026-10-28

首个版本。0.1.0 为本地手动发布（npmjs.com 上 `dsh-status-anim@0.1.0` 发布于 2026-10-28T10:09:20Z，`latest` 指向该版本），未附 provenance 证明。

### 新增

- **状态条动图插播**：在 DSH Web GUI 的「Deep diving...」状态提示条上插入用户自定义图片。用 `MutationObserver` 盯住 `[data-chat-flow] [role="status"][aria-live="polite"]` 并 `prepend(<img>)`，另带轮询兜底，宿主 DOM 结构变化后仍能命中。
- **放文件即换图，零重建零重启**：把 `.apng` / `.png` / `.webp` 丢进 `~/.dsh/status-anim/`（Windows：`C:\Users\14023\.dsh\status-anim\`），刷新页面即可看到；删旧放新即完成替换，不需要构建、不需要重启 `dsh web`。同名覆盖也能立刻生效（响应带 `Cache-Control: no-store`，`src` 附时间戳）。
- **可视化设置面板**：页面右下角半透明 ⚙ 齿轮按钮，点开即为设置卡片，改动即时生效、无需刷新。
  - 启用开关（`dsh-status-anim.enabled`）
  - 尺寸滑块 8–96px（`dsh-status-anim.size`，默认 18）
  - 素材下拉：随机或目录内任一文件（`dsh-status-anim.picked`）
  - 样式只用 `Canvas` / `CanvasText` / `Field` 等系统色，自动跟随深浅色主题。
- **只读素材服务**：host 侧用 `ctx.webServer.register({ kind: 'prefix', path: '/status-anim' })` 暴露素材目录，提供 `GET /status-anim/list`、`GET /status-anim/file/<name>`、`GET /status-anim/`（自述 JSON，含素材目录绝对路径与可用路由）。`path.resolve` + `startsWith` 目录穿越防护，拒绝以 `.` 开头的文件名与带路径分隔符的名字。
- **减少动效降级**：默认遵循 `prefers-reduced-motion: reduce`，此时取动图第一帧做静态降级；可用 `dsh-status-anim.motion` 设为 `force` 强制播放。

### 说明

- client 侧 `inject = []`：纯 DOM 操作、零服务依赖，因此核心动画与可选的设置面板互不拖累——设置面板整体 `try/catch` 并延后一拍启动，失败只损失面板，不影响动图。
- 拿不到列表、目录为空或请求失败时静默不插入，绝不影响宿主。

> 注：0.2.0 起设置入口已迁移到设置页「状态动画」，见上方 [0.2.0] 段。
