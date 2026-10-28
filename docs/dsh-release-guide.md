# dsh-status-anim 发版规范（本项目可执行版）

> 本文由 cohub `docs/dsh-release-guide.md` 适配而来，所有命令均按**本项目实况**改写：无构建步骤、`lib/*.js` 为手写产物、当前非 git 仓库、当前无锁文件。
> 硬性红线单独见 [AGENTS.md](../AGENTS.md)。本文与 `AGENTS.md` 冲突时以 `AGENTS.md` 更严者为准；与 `.github/workflows/publish.yml` 实际行为冲突时以 workflow 为准。
>
> 本包：`dsh-status-anim`（version `0.1.0`，`private: true`）。目标 profile 示例：`web`。GitHub 仓库 owner/repo：**待定**（本项目尚未 `git init`，也没有远程）。

核心原则一句话：**CI 从 tag 指向的 commit 取代码发布**，所以 tag 是「发布快照」，必须在所有改动就位后再打。

---

## 1. 一次性配置（项目起步）

> 与前身规范的差异：本章删除「必须 build」类步骤——本项目**没有构建步骤**，`lib/index.js` / `lib/client.js` 是手写产物；`scripts.build` / `prepublishOnly` 一律不加，对应位置改为「手写产物检查：`node --check lib/index.js && node --check lib/client.js`」。`files` 只列 `lib`、`cordis.patch.yml`、`README.md`（不含前身的 `presets`）。

### 1.1 `package.json` 必备字段（当前实况）

```jsonc
{
  "name": "dsh-status-anim",
  "version": "0.1.0",                    // 第 3 行，手改
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": { "default": "./lib/index.js" },
    "./client": { "default": "./lib/client.js" },
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml", "README.md"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "inject": [], "platform": "web" } },
  "private": true                        // 第 47 行，正式发版前必须移除
}
```

要点：

- `files` 必须显式列出 `lib`（手写产物目录）。**`lib/` 禁止进 `.gitignore`**——本项目没有 build 能重新生成它，被忽略就是永久丢失。
- `dsh.bundle.patch` 指向 `cordis.patch.yml`，该文件必须同时在 `files` 里，否则装上后插件挂不上。
- `repository.url` 目前**待定**：仓库尚未创建。建仓后必须与 GitHub 仓库**大小写字符级一致**，否则 provenance 硬报 `E422`。
- 手写产物检查（替代前身的 `npm run build`）：

```bash
node --check lib/index.js && node --check lib/client.js
```

- `lib/client.js` 的载体格式必须保持 `window.__ModuleLoader__.load({ id: 'dsh-status-anim', factory })`，`id` 必须等于包名。

### 1.2 `.github/workflows/publish.yml` 关键结构（本项目版）

只放**仓库根** `.github/workflows/`，文件名必须是 `publish.yml`。本项目是单一包、仓库根即包根，因此**没有** `working-directory`。

```yaml
on:
  push:
    tags:
      - dsh-v*          # 唯一允许的发布触发方式；禁止 workflow_dispatch

permissions:
  contents: read
  id-token: write       # OIDC 必需

jobs:
  publish-dsh:
    runs-on: ubuntu-latest
    concurrency:
      group: publish-dsh
      cancel-in-progress: false
    steps:
      - uses: actions/checkout@v4          # 无 ref → 取 tag 指向的 commit
      - uses: actions/setup-node@v7        # v4–v6 会导出假 token 污染 OIDC
        with:
          node-version: 24
          registry-url: https://registry.npmjs.org
      - run: node --check lib/index.js && node --check lib/client.js   # 手写产物检查
      - run: npm publish --provenance --access public
```

各要素作用：`id-token: write` 是 OIDC 环境，**不需要也不使用 `NPM_TOKEN`**；`concurrency` 保证同包发布串行；`actions/checkout@v4`（无 `ref`）取 tag 指向的 commit，这是「提前打 tag」事故的直接成因；`setup-node@v7` 因为 v4–v6 会把假 token `XXXXX-XXXXX-XXXXX-XXXXX` 写进 `.npmrc` 破坏 OIDC；`node --check` 是唯一的产物前检（没有 build 可跑）。

**npm CLI 版本**：OIDC 要求 npm CLI ≥ 11.5.1。本项目靠 `node-version: 24` 自带 npm 满足（本机实测 Node `v24.22.1` / npm `11.19.1`）。**`npm install -g npm@latest` 这一步不存在**——前身规范里那行是给低版本 Node 的兜底，本项目不需要；仅当你某天把 `node-version` 降到自带 npm < 11.5.1 时，才按需在 `npm publish` 前加一步 `npm install -g npm@latest`。

**不做的两件事**：① 不加 `npm ci`（本项目当前无 `package-lock.json`，详见第 2 章）；② 不加 `workflow_dispatch` 入口（其版本一致性校验会被 `if` 跳过）。

若日后补 `.github/workflows/publish.yml`，可选但推荐的校验步骤：

```yaml
      - name: 版本一致性校验
        if: startsWith(github.ref, 'refs/tags/')
        run: |
          TAG_VERSION="${GITHUB_REF_NAME#dsh-v}"
          PKG_VERSION=$(node -p "require('./package.json').version")
          [ "$TAG_VERSION" = "$PKG_VERSION" ] || { echo "❌ tag=$TAG_VERSION pkg=$PKG_VERSION"; exit 1; }
```

> 注意：该步骤带 `if: startsWith(github.ref, 'refs/tags/')`，若将来加入 `workflow_dispatch` 就会被跳过——这是本项目禁止手动发布入口的直接理由。

### 1.3 npm 侧：Trusted Publisher（OIDC）

npm 没有组织级 TP，**每个包单独配一条**：

```bash
npm trust github dsh-status-anim --repo <owner>/dsh-status-anim --file publish.yml --allow-publish -y
```

- `<owner>` **待定**：仓库创建后填入实际 owner（大小写与 GitHub 一致）。`--file` 只填 `publish.yml`，不带 `.github/workflows/` 前缀。
- `npm trust` 属账号变更操作，需要 2FA（CLI 会给 `npmjs.com/auth/cli/<uuid>` 链接）。
- 包尚不存在于 registry 时无法预配 TP：需**一次性**先发一个占位版本（如 `0.0.1`，同时临时解除 `private: true`），再配 TP。此引导动作之后，正式发版一律只走 CI，本地永不 `npm publish`。
- 查询/撤销：`npm trust list dsh-status-anim` / `npm trust revoke dsh-status-anim --id=<id>`。

### 1.4 关键坑：`actions/checkout` 不带 `ref` 参数

`actions/checkout@v4` 在 tag 触发时默认 checkout **该 tag 指向的 commit**，不是 `main` 的最新 commit。
后果：tag 若在开发中途打，之后的提交**不会**进产物——CI 依然绿，包依然能装，只是内容残缺。见第 6 节。

---

## 2. 版本号规则

> 与前身规范的差异：本项目锁文件是 `package-lock.json`（npm），**共 3 处 version**（`package.json` 1 处 + 锁文件 2 处：顶层与 `packages[""].version`），非前身所说「至少两处」；且本项目**当前尚未生成锁文件**，未生成前只校 `package.json` + README 锚点。仓库为单包、包根即仓库根，没有子包目录前缀。

**禁止 `npm version`**（改号只能手改）。手改清单：

| # | 位置 | 说明 |
|---|------|------|
| 1 | `package.json` 第 3 行 `version` | 权威值 |
| 2 | `package-lock.json` 顶层 `version` | **仅当锁文件已存在** |
| 3 | `package-lock.json` 的 `packages[""].version` | **仅当锁文件已存在** |

- 锁文件**当前不存在**。首次 `npm install` 生成后，上述第 2/3 处才成为必改项；漏改任一处，CI 的 `npm ci` 会报 `EUSAGE`：

```
npm error `npm ci` can only install packages when your package.json and
npm error package-lock.json are in sync. ... Invalid: lock file's dsh-status-anim@X.Y.Z does not satisfy dsh-status-anim@A.B.C
```

- **未生成锁文件前**的校验只需两条：`node -p "require('./package.json').version"` 与 README 锚点行。

semver 判据（0.x 阶段）：

| 变更性质 | 版本位 | 本项目示例 |
|----------|--------|-----------|
| 新增用户可见功能（如新增一个设置控件/一种素材格式） | minor | `0.1.0` → `0.2.0` |
| 仅修复、无新功能（如修 DOM 匹配器误伤） | patch | `0.1.0` → `0.1.1` |
| 破坏性变更（如改 localStorage 键名、改路由前缀） | major（0.x 可放宽为 minor，但须在 CHANGELOG 写明破坏点） | `0.1.0` → `1.0.0` |

README 版本锚点必须同步，且与 `package.json` 版本**字符级相等**。本项目锚点已存在于 [README.md](../README.md):18：

```markdown
> 本文对应 **vX.Y.Z**（包版本以 package.json 为准）
```

改版本时把该行的 `vX.Y.Z` 一起改掉，且必须留在首屏前 20 行内。

---

## 3. 发版前检查清单（按依赖顺序，逐条勾）

> 与前身规范的差异：删除 `npm run build`（无构建）→ 换成手写产物检查 `node --check lib/index.js && node --check lib/client.js`；删除 `npm run test:runtime && npm run test:host && npm run typecheck`（本项目 `package.json` 无 `scripts` 字段）→ 换成 `test/` 下按需直跑 `.mjs` 验证脚本；锁文件检查标注为「待锁文件存在后启用」；CHANGELOG 校验标注为**人工前置、无 CI 校验**。

> 命令环境注记：以下清单/验证命令为 **bash 写法（CI ubuntu / 本地 Git Bash 均可直跑）**。本机 PowerShell 没有 `grep`/`head`，请改用 `Select-String`，例如 `Select-String -Path README.md -Pattern "本文对应"`；`tar` 本机可用（`C:\WINDOWS\system32\tar.exe`），`node`/`npm`/`git` 均可用（Node `v24.22.1`、npm `11.19.1`）。

```bash
# ① 工作区干净（项目 git init 后生效；有输出就是有未提交改动）
git status --porcelain

# ② 手写产物语法正确（替代 build；必须为 0 退出）
node --check lib/index.js && node --check lib/client.js

# ③ 手写产物确实在包里、且未被 .gitignore 排除
node -e "const p=require('./package.json');console.log(p.files);process.exit(p.files.includes('lib')?0:1)"
grep -nE '^(lib|dist)/?$|^lib' .gitignore || echo "OK: lib 未被忽略"

# ④ 版本号一致（锁文件存在时才跑后两条）
node -p "require('./package.json').version"
node -p "require('./package-lock.json').version"                        # 待锁文件存在后启用
node -p "require('./package-lock.json').packages[''].version"           # 待锁文件存在后启用
grep -nE "本文对应.*v$(node -p "require('./package.json').version")" README.md

# ⑤ 远程/本地无同名 tag（输出必须为空，git 建仓后生效）
git ls-remote --tags origin | grep "refs/tags/dsh-vX.Y.Z"
git tag -l "dsh-vX.Y.Z"

# ⑥ 确认 tag 将指向的 commit 含全部要发的改动
git log --oneline dsh-v<上个版本>..HEAD
```

| # | 检查项 | 失败症状 |
|---|--------|----------|
| 1 | 工作区干净 | 未提交改动不会进 CI，发布内容缺东西 |
| 2 | `node --check` 通过 | 语法错误直接进 registry，用户侧 fiber 整体不 apply |
| 3 | `files` 含 `lib` 且未被 gitignore | `npm pack` 出来缺 `lib/`，装上即加载失败 |
| 4 | 版本号（+锁文件）与 README 锚点一致 | 文档与实物错位；锁文件在时 `npm ci` 报 `EUSAGE` |
| 5 | CHANGELOG 已写且只记实际发布内容（**人工前置**） | 文档与实物不符，用户被误导。**注意：CHANGELOG 无 CI 校验，全靠人肉** |
| 6 | tag 未占用 | `git push` 被拒；或误删已有 tag（严禁） |
| 7 | HEAD 含全部改动 | 发布残缺，只能发下一个版本补救（见第 6 节） |

**CHANGELOG 的边界（重要）**：本项目的 CHANGELOG 校验**没有任何 CI 门禁**，属于纯人工前置动作——写没写、写对没写对，CI 不会替你拦。发版负责人必须在打 tag 前人工确认 `CHANGELOG.md` 顶部已有对应版本段，且只记实际发出去的内容。条目用独立 `docs:` commit 提交，格式遵循 Keep a Changelog。

---

## 4. 执行顺序（顺序错了就出事）

> 与前身规范的差异：删掉「build 产物最新」这一环（本项目无构建，改为改完即 `node --check`）；提交粒度沿用「代码 / CHANGELOG / 版本号分开提交」；**tag 之前的「核实远程 HEAD」是本项目红线**，因为 `lib/*.js` 手写产物一旦不在 tag 里就永久缺失。

```
改 lib/*.js（手写）→ node --check 双文件 → 改 package.json 版本 + README 锚点 + CHANGELOG →
提交 → push main → 核实 origin/main 与 HEAD 同一 SHA → 打 annotated tag 指向该 commit →
push tag → CI 自动发布
```

```bash
# 1. 改动与提交（代码 / CHANGELOG / 版本号分开提交）
git commit -am "feat: ..."
git commit -m "docs: CHANGELOG X.Y.Z"
git commit -m "chore: 版本号 X.Y.Z"

# 2. 推到 main 并核实 SHA：git rev-parse HEAD 与 origin/main 必须一致
git push origin main
git fetch origin && git rev-parse origin/main && git rev-parse HEAD

# 3. 再次核对：这个 commit 是否含全部要发的改动
git log --oneline dsh-v<上个版本>..HEAD

# 4. 打 annotated tag 指向该 commit
git tag -a "dsh-vX.Y.Z" -m "release X.Y.Z" <main-SHA>

# 5. 推送 tag，触发 CI
git push origin "refs/tags/dsh-vX.Y.Z"
```

**为什么顺序不能颠倒**：CI 的 `actions/checkout` 取的是 tag 指向的 commit。提前打 tag 会把之后的提交全部排除在发布之外，而 CI 仍然 success。

---

## 5. 发布后验证（CI 绿 ≠ 能装）

> 与前身规范的差异：保留三步骨架，但把第 ② 步写成**可执行的解包 grep**（`tar -xzf` + grep 本插件真实符号），第 ③ 步必须是**隔离 profile** 的实装实测（动画 + 设置面板都要看）。

```bash
# ① 版本已上架（注意传播延迟）
npm view dsh-status-anim version

# ② 产物内容核对：解包看 lib/ 里有没有本次新增的关键符号
npm pack dsh-status-anim@X.Y.Z
tar -xzf dsh-status-anim-X.Y.Z.tgz
grep -n "status-anim/list"        package/lib/index.js   # host 侧路由前缀
grep -n "__ModuleLoader__"        package/lib/client.js  # client 载体格式
grep -n "dsh-status-anim.size"    package/lib/client.js  # 设置面板 localStorage 键
test -s package/lib/index.js && test -s package/lib/client.js && echo "OK: 两个产物非空"
# 轻量替代：npm pack dsh-status-anim@X.Y.Z --dry-run，确认 lib/index.js 与 lib/client.js 都在

# ③ 重装到隔离 profile 实测
dsh plugin --profile dsh-anim-verify add dsh-status-anim@X.Y.Z
node -p "require('C:/Users/14023/.dsh/profiles/dsh-anim-verify/node_modules/dsh-status-anim/package.json').version"
```

第 ③ 步的验收口径（缺一不可）：

1. 重启该 profile 的 `dsh web`，状态条「Deep diving...」旁出现动图；
2. 右下角 ⚙ 齿轮打开设置面板，改「尺寸/素材/启用」三项都能即时生效；
3. 删掉素材文件后不报错、不插入空白图（宿主不受影响）。

注意 profile 选择：**必须用依赖里写 registry 版本号的 profile**（如上例 `dsh-anim-verify`）；用 `link:` 指向本地 checkout 的 profile（如仓库内示例的 `web` + `link:C:/…/dsh-status-anim`）验证不到 npm 产物。确认版本时不要只看命令回显，按上面的 `node -p` 读真实落盘 `package.json`。

registry 传播延迟约 **2–2.5 分钟**（前身实测 0.10.1≈2min、0.10.2≈2.5min、0.10.3≈30s）。首次 `npm view` 查不到新版本是正常现象，**别误判为发布失败**。

---

## 6. 事故案例：0.10.0 发布残缺（外部引鉴）

> 与前身规范的差异：本节**不是本项目的发布记录**，而是从 cohub 引鉴的**外部案例**。`dsh-status-anim` 至今从未发布过任何版本（当前 `0.1.0` 未发布、`private: true`），因此不得把 0.10.0 写成自己的历史；本节只用于说明「提前打 tag」这一类风险。

**现象**：tag 已推送、CI 全绿、`npm view` 与安装都正常，但装到的版本**缺少三个功能**。用户看到的包「看起来是新的」，实际内容是旧的。

**根因**：`dsh-v0.10.0` tag 在开发过程中就被打了并推送，它指向 `8872eae`，而后续三项改动（`4fc30ea` / `6ad6f33` / `ae2ca32`）都晚于该 commit。CI 的 `actions/checkout` 取 tag 指向的 commit → 三项改动全部没进包。

**后果**：npm 上同版本号不可重发，只能发 `0.10.1` 补救，并在 CHANGELOG 新版本段声明 `0.10.0` 不完整。

**对本项目的映射**：本项目没有 build 能重建 `lib/`，所以同样的错误后果更重——漏进 tag 的手写改动**无法通过重跑 CI 补回**，只能改版本号重发。

**教训**：

1. tag 是「发布快照」，必须在**所有改动就位后**再打；不要在开发中途为了跑一次 CI 就打 tag。
2. 打之前用 `git log --oneline <上个tag>..HEAD` 核对：列出的每个 commit 都应该是你想发布的。
3. CI 全绿只证明「workflow 跑通了」，不证明「内容是全的」。

---

## 7. 常见坑速查表

> 与前身规范的差异：保留全部条目并扩充；把「忘了 `npm run build`」替换为本项目的「忘了 `node --check` / `lib/` 被 gitignore」；新增 `workflow_dispatch` 跳过版本校验、checkout 不带 ref 取旧 commit、`setup-node` v4~v6 假 token、`repository` 大小写 E422、传播延迟 2–2.5 分钟五条。

| 坑 | 症状 | 解法 |
|----|------|------|
| 把 `lib/` 加进 `.gitignore` | git 与 npm 包都没有产物，`npm pack` 出空包 | **绝不忽略 `lib/`**；`files` 必须含 `lib` |
| 改完 `lib/*.js` 没跑 `node --check` | 语法错误进 registry，用户侧整条 fiber 不 apply | 提交前必跑 `node --check lib/index.js && node --check lib/client.js` |
| 忘了同步 README 版本锚点 | 文档版本与包版本错位 | 手改 `package.json` 与 README 锚点，两者字符级相等（锚点待补） |
| 锁文件只改一版 `version` | `npm ci` 报 `EUSAGE`（package.json 与 lock 不同步） | 改两处：顶层 + `packages[""].version`（锁文件存在后） |
| `npm view` 查不到新版本 | 以为发布失败，重复打 tag | 等 2–2.5 分钟，registry 传播有延迟 |
| 用 `npm version` | 版本号与 lock 不一致、多出 lightweight tag | 手改 version，禁止 `npm version` |
| 在本地 `npm publish` | 绕过 CI 校验、无 provenance | 只走 CI；本地永不 publish（TP 引导占位版除外） |
| `private: true` 没解除就发 | `npm publish` 直接失败（package marked private） | 发版前移除 `private` 字段并单独 commit |
| `workflow_dispatch` 手动发布 | 版本一致性校验被 `if: startsWith(github.ref,'refs/tags/')` 整段跳过，发出错版本 | **禁止该入口**；只用 `push: tags: dsh-v*` |
| `actions/checkout` 不带 `ref` | tag 指向旧 commit，晚于它的改动全没进包，CI 却 success | 先 push 并核实 `origin/main == HEAD`，再打 tag |
| `setup-node@v4~v6` | OIDC 认证失败（假 token `XXXXX-…` 污染 `.npmrc`） | 用 `@v7`，不要手写清空 `NODE_AUTH_TOKEN` 的 workaround |
| `repository.url` 大小写不符 | `npm publish` 报 `E422` | 与 GitHub 仓库字符级一致（本项目 repository 待定） |
| CHANGELOG 记了未发布的内容 | 文档与实物不符 | 只记实际发出去的内容；且**无 CI 校验，纯人工把关** |
| workflow 放在子包目录 | CI 永不触发 | 只放仓库根 `.github/workflows/publish.yml` |
