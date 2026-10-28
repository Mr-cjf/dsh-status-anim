# AGENTS.md — dsh-status-anim 发版硬约束

本文件只写**违反会直接损坏发布产物或已发布版本**的规则。完整流程见
[docs/dsh-release-guide.md](./docs/dsh-release-guide.md)；变更历史见 [CHANGELOG.md](./CHANGELOG.md)。

## 1. 禁止 `npm version`

改版本号只能**手改** [package.json](./package.json):3 的 `version`。
`npm version` 会自行改号、自行 commit、打 lightweight tag，与「分提交 + annotated tag + 打在已核实的 HEAD 上」冲突。
**违反后果**：版本号与锁文件不同步，CI `npm ci` 报 `EUSAGE`（`package-lock.json` 已存在、lockfileVersion 3，本条立即生效）；多出一个非 annotated tag，远程 tag 名被占，同版本号不可重发。

## 2. `lib/` 是手写运行产物，必须进 git 与 npm 包

本项目**没有构建步骤**：`lib/index.js`、`lib/client.js` 就是手写的最终产物（`src/*.ts` 只是类型参照，不参与运行）。

- **禁止把 `lib/` 加入 `.gitignore`**（同样禁止 `dist/`、`*.js` 一类的整目录忽略规则）。
- `package.json` 的 `files` 必须始终包含 `"lib"`。
- 每次改完 `lib/*.js` 必须跑语法检查：`node --check lib/index.js && node --check lib/client.js`。

**违反后果**：`lib/` 被忽略 → git 里没有产物、`npm pack` 出来是空包或缺文件，装上后插件加载失败且无任何本地报错；漏跑 `node --check` → 语法错误直接带进 registry，用户侧整条 fiber 不 apply。

## 3. 版本号与 README 锚点必须相等

改 `package.json` 版本时，必须同步 README 首屏版本锚点，两者**字符级相等**。

- 当前锚点：[README.md](./README.md):18 —— `> 本文对应 **v0.1.0**（包版本以 package.json 为准）`。
  当前与 `package.json:3` 的 `0.1.0` 一致；每次改版本必须同步改这一行。
- **违反后果**：锚点与实际版本不符 → 文档与实物不符，用户按错版本读文档；CI 若开启锚点校验则直接 `::error::` 失败。

## 4. tag 必须在全部改动 push 并核实远程 HEAD 之后才打

远程仓库：`https://github.com/Mr-cjf/dsh-status-anim`，跟踪分支 `main`。本地若尚未配置，先 `git remote add origin https://github.com/Mr-cjf/dsh-status-anim.git` 并确认 `git remote -v` 输出的就是该地址。

顺序固定：改代码 → 提交 → `git push origin main` → `git fetch origin && git rev-parse origin/main` 与 `git rev-parse HEAD` **必须一致** → 再打 annotated tag。
打之前用 `git log --oneline <上个tag>..HEAD` 核对每个 commit 都是要发的。

**违反后果**：`actions/checkout` 不带 `ref`，取的是 **tag 指向的 commit**，晚于它的改动全部不进包，而 CI 依然 success——发布残缺且不可修复。

## 5. 同版本号不可重发

npm 上的已发布版本**不能删除、不能覆盖**。发错了只能发下一个版本号补救，并在 CHANGELOG 声明前一版不完整。

**违反后果**：`npm publish` 报 `EPUBLISHCONFLICT`/403；或者你误以为能覆盖，实际用户装到的是旧内容。

## 6. 发布开关纪律：禁止加回 `private`

[package.json](./package.json) 当前**已无 `private` 字段**，可以直接发布；**禁止重新加回 `private: true`**——要挡发布请用 `npm pack` + 装到隔离 profile 实测，不要靠 `private`。
`scripts/check-release.mjs` 第 8 项只在 `private === true` 时报 `WARN`（提示 publish 会被拒），不阻断；所以门禁全绿**不等于**可发布，还得自己确认该字段不存在。

**违反后果**：`npm publish` 报 `This package has been marked as private`，CI 红；若为了绕过而本地 publish，则产生无 provenance 的野版本。

## 7. 禁止 `workflow_dispatch` 手动发布入口

`.github/workflows/publish.yml` 只允许 `push: tags: [dsh-v*]` 一种触发方式。

**理由**：版本一致性校验步骤带 `if: startsWith(github.ref, 'refs/tags/')`，手动触发时该步骤被**整段跳过**，等于零校验直接把 `package.json#version` 发出去。
**违反后果**：手动触发发出错版本号，且该版本号永久占位，只能靠下一个版本补救。

## 8. 验证纪律

验证统一入口是 **`npm run check:release`**（即 `node scripts/check-release.mjs`，已落地：[scripts/check-release.mjs](./scripts/check-release.mjs)）。
`package.json`:52 的 `prepublishOnly` 已接入同一命令，所以 `npm publish` 会自动跑这套门禁，不要再手写内联检查。

脚本只用 Node 内置模块，逐项打印 `PASS` / `FAIL` / `WARN`，实际校验 8 项：

1. `package.json` 可解析且含 `name`/`version`、`version` 为合法 semver；
2. `README.md` 前 20 行存在且仅存在与 `package.json` 相等的 `v<version>` 锚点；
3. `files` 白名单包含 `lib`、`cordis.patch.yml`、`README.md`；
4. `exports` 的 `.` / `./client` / `./cordis.patch.yml` 均指向 files 白名单内的真实文件；
5. `lib/index.js` 与 `lib/client.js` 存在、>1KB、`node --check` 通过；
6. `cordis.patch.yml` 存在、含 `status-anim` 挂载行、路径等于 `dsh.bundle.patch`；
7. `package-lock.json` 顶层 `version` 与 `packages[""].version` 均等于 `package.json` 的 `version`（本项目无外部依赖、peer 为 optional，锁文件只含根条目；脚本 PASS 文案里写作「3 处」）；
8. `private: true` 仅 `WARN`（提示 publish 会被拒），不阻断。

（另有 `CHANGELOG.md` 容忍缺失项：存在报 PASS，缺失只 `WARN`，不计入上面的 8 项硬门禁。）

退出码语义：`0` = 全部 PASS（WARN 不阻断），`1` = 存在任一 FAIL，阻断发布。
`scripts/check-release.mjs` **有意不进 `files` 白名单**——它是本地/CI 门禁，不随包发布。

- 发布后验证必须做全套三步（`npm view` → `npm pack` 解包 grep 关键符号 → 装到**隔离 profile** 实测动画与设置面板），细则见指南第 5 章。
- **违反后果**：只看到 CI 绿就宣布完成，等于没验证；`lib/` 缺符号或 client 载体格式坏了，用户侧静默失效。

- 推送含 `.github/workflows/` 的提交前，先确认 gh token 有 `workflow` scope（`gh auth show` 或 `gh auth refresh -s workflow`），否则改 SSH 远端推送（`git remote set-url origin git@github.com:<owner>/<repo>.git`）。
- Action 版本不得凭记忆写 `@v4`：必须用 `gh api repos/actions/<name>/releases/latest --jq .tag_name` 探测实测（`checkout` / `setup-node` 当前均为 `v7`），并验 `refs/tags/v7` 存在。
- **违反后果**：缺 scope 直接推不上去（workflow 文件被 GitHub 拒收）；写错 Action 版本会踩 `setup-node` v4–v6 假 token 破坏 OIDC 的坑，CI 认证失败。

## 9. `repository` 大小写与 LICENSE 署名

[package.json](./package.json):47 的 `repository.url` 必须**字符级**等于 GitHub 实际仓库 `Mr-cjf/dsh-status-anim`（**注意大写 M**）：owner/repo 大小写敏感，写错一个字母 provenance 就报 `E422`。
LICENSE 版权人与 GitHub 账号一致，均为 `Mr-cjf`（`Copyright (c) 2026 Mr-cjf`）；后续若更换账号或组织，LICENSE 署名须与 `repository.url` 的 owner 保持一致。

**违反后果**：`repository.url` 大小写不符 → 发布时 provenance 校验 `E422` 失败，包已上传但 provenance 缺失，只能发下一版补救。
