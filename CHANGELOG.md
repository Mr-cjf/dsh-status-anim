# Changelog

本项目的所有重要变更都记录在此文件。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 未发布

首个版本，尚未发布到 npm registry（`package.json` 当前 `private: true`）。

### 新增

- **状态条动图插播**：在 DSH Web GUI 的「Deep diving...」状态提示条上插入用户自定义图片。用 `MutationObserver` 盯住 `[data-chat-flow] [role="status"][aria-live="polite"]` 并 `prepend(<img>)`，另带轮询兜底，宿主 DOM 结构变化后仍能命中。
- **放文件即换图，零重建零重启**：把 `.gif` / `.apng` / `.webp` / `.png` / `.avif` 丢进 `~/.dsh/status-anim/`（Windows：`C:\Users\14023\.dsh\status-anim\`），刷新页面即可看到；删旧放新即完成替换，不需要构建、不需要重启 `dsh web`。同名覆盖也能立刻生效（响应带 `Cache-Control: no-store`，`src` 附时间戳）。
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
