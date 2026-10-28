# 发布后验证记录（模板）

> **本文件是模板，不是记录。** 每次发布后由发版人填写；当前项目**尚无任何已发布版本**（`0.1.0` 待发），因此下方所有区块均为空模板。
> 事实基线：本项目 **0.1.0 为首次发布，无任何历史发布记录**——任何看起来像既有结论的数据都必须来自本次真实验证，禁止预填。
> 方法依据：[dsh-release-guide.md](dsh-release-guide.md) 第 5 章、[AGENTS.md](../AGENTS.md) 第 8 条末段（发布后验证必须做全套三步）。
## 1. 第 1 步：等待 registry 传播
CI（`npm publish`）成功后，registry 传播延迟约 **2–2.5 分钟**。立即执行 `npm view` 可能报 `404 Not Found`——属**正常现象**，不等于发布失败。
PowerShell 轮询（本机无 bash `until`，用 for 循环）：
```powershell
$v = "0.1.0"
for ($i = 0; $i -lt 20; $i++) {
  npm view "dsh-status-anim@$v" version 2>$null
  if ($LASTEXITCODE -eq 0) { break }
  Start-Sleep -Seconds 15
}
```
轮询打印出版本号才算传播完成；超过 5 分钟仍 404 再按第 5 节排查，切勿重复打 tag。
## 2. 第 2 步：核验 registry 元数据
```powershell
npm view dsh-status-anim@0.1.0 version
npm view dsh-status-anim versions --json
npm view dsh-status-anim dist.tarball
npm view dsh-status-anim repository.url
```
逐条确认：
1. 第一条打印的版本号与本次 tag 的版本号一致；
2. `versions --json` 里本次版本在列，且无「本不该出现」的版本；
3. `repository.url` 回显的 `owner/repo` 与 GitHub 的 `Mr-cjf/dsh-status-anim` **字符级一致（大小写敏感）**——写成 `mr-cjf` / `Mr-CJF` 之类会让 `npm publish --provenance` 硬报 `E422`。
## 3. 第 3 步：解包 grep 关键符号
PowerShell 版：
```powershell
npm pack dsh-status-anim@0.1.0
tar -xzf dsh-status-anim-0.1.0.tgz
Select-String -Path package/lib/index.js  -Pattern 'status-anim'          # 挂载 id
Select-String -Path package/lib/client.js -Pattern '__ModuleLoader__'     # client 载体格式
Select-String -Path package/lib/client.js -Pattern 'dsh-status-anim.size' # 客户端样式/选择器标记
Get-Item package/lib/index.js, package/lib/client.js | Select-Object Name, Length
```
bash 版（CI / Git Bash）：
```bash
npm pack dsh-status-anim@0.1.0 && tar -xzf dsh-status-anim-0.1.0.tgz
grep -n "status-anim"          package/lib/index.js
grep -n "__ModuleLoader__"     package/lib/client.js
grep -n "dsh-status-anim.size" package/lib/client.js
test -s package/lib/index.js && test -s package/lib/client.js && echo "OK: 两个产物非空"
```
三类符号缺一不可：`status-anim`（挂载 id）、`__ModuleLoader__`（client 载体格式）、`dsh-status-anim.size`（客户端样式/选择器标记）。**查不到任一符号 = 包内容残缺，即使 CI 绿也不能发布**：判 `FAIL`，转第 5 节补救。
## 4. 第 4 步：隔离 profile 实测
必须把 **registry 产物**装进**隔离 profile**（不得用本地 `link:` 代替）：
```powershell
dsh plugin --profile dsh-anim-verify add dsh-status-anim@0.1.0
node -p "require('C:/Users/14023/.dsh/profiles/dsh-anim-verify/node_modules/dsh-status-anim/package.json').version"
```
验收口径（缺一不可）：
1. 状态提示条出现**自定义动图**；
2. ⚙ **可视化设置面板**三个控件均可用、改动即时生效；
3. `cordis.patch.yml` 的 `status-anim` 挂载行在该 profile 内生效（插件真挂上，不是文件只落盘）。
提醒：本地 `link:` 验证**不能**替代 registry 安装验证——link 绕过 tarball 打包与 `files` 白名单，而那正是要验证的两处。
## 5. 填写表格（每次发布一行，只增不改）
| 版本 | tag | 发布时间 | registry 传播确认 | 包内容 grep | 隔离 profile 实测 | 验证人 | 结论 |
|------|-----|----------|-------------------|-------------|-------------------|--------|------|
|  |  |  |  |  |  |  |  |
## 6. 事故补救区
- 同版本号 **不可重发、不可删除**；一次发错即永久留痕。
- 唯一出口：**提下一个版本号**发新包，并在 `CHANGELOG.md` 新版本段声明前一版不完整。
- 本项目无构建步骤，`lib/*.js` 是手写产物，漏进 tag 的改动**无法靠重跑 CI 补回**，只能改版本号重发。
外部引鉴案例（**外部案例，不是本项目发布记录**）：某包 `0.10.0` 提前打 tag → `actions/checkout` 取 tag 指向的旧 commit → CI 绿、装得上，但内容缺三项功能 → 同版本不可重发，只能发 `0.10.1` 并在 CHANGELOG 声明 `0.10.0` 不完整。详见指南第 6 章。
---
本文档随仓库 `docs/` 保存，**不进 npm 包**：`package.json` 的 `files` 白名单仅 `["lib","cordis.patch.yml","README.md"]`，不含 `docs`。
