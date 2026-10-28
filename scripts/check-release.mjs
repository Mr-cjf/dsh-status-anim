#!/usr/bin/env node
/**
 * dsh-status-anim 本地发布门禁。
 *
 * 只用 Node 内置模块，无外部依赖。
 * 每一项检查都打印 PASS / FAIL / WARN；任一 FAIL 则进程 exit 1。
 *
 * 用法：npm run check:release
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const results = { pass: 0, fail: 0, warn: 0 };

function pass(label, detail) {
  results.pass++;
  console.log(`PASS  ${label}${detail ? ` — ${detail}` : ''}`);
}

function fail(label, detail) {
  results.fail++;
  console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
}

function warn(label, detail) {
  results.warn++;
  console.log(`WARN  ${label}${detail ? ` — ${detail}` : ''}`);
}

/** 执行一项检查；fn 抛出异常即视为 FAIL。 */
function check(label, fn) {
  try {
    const detail = fn();
    pass(label, detail);
  } catch (err) {
    fail(label, err && err.message ? err.message : String(err));
  }
}

function readText(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

function abs(rel) {
  return resolve(ROOT, rel);
}

function mustExist(rel) {
  if (!existsSync(abs(rel))) throw new Error(`缺少文件 ${rel}`);
}

/** 把导出/白名单里的路径统一成仓库相对、正斜杠、去掉 ./ 的形式。 */
function normalize(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/** files 白名单是否覆盖某个仓库内路径（目录项覆盖其整棵子树）。 */
function coveredByFiles(rel, files) {
  const target = normalize(rel);
  return files.some((entry) => {
    const e = normalize(entry);
    return target === e || target.startsWith(`${e}/`);
  });
}

// ---------------------------------------------------------------- 1. package.json
let pkg = null;
check('package.json 可解析且含 name/version、version 为合法 semver', () => {
  mustExist('package.json');
  try {
    pkg = JSON.parse(readText('package.json'));
  } catch (err) {
    throw new Error(`package.json 不是合法 JSON：${err.message}`);
  }
  if (!pkg || typeof pkg !== 'object') throw new Error('package.json 顶层不是对象');
  if (typeof pkg.name !== 'string' || !pkg.name.trim()) throw new Error('缺少 name 字段');
  if (typeof pkg.version !== 'string' || !pkg.version.trim()) throw new Error('缺少 version 字段');
  if (!SEMVER.test(pkg.version)) throw new Error(`version "${pkg.version}" 不符合 semver`);
  return `${pkg.name}@${pkg.version}`;
});

const version = pkg && typeof pkg.version === 'string' ? pkg.version : null;

// ---------------------------------------------------------------- 2. README 版本锚点
check('README.md 前 20 行存在且仅存在与 package.json 相等的 v<version> 锚点', () => {
  if (!version) throw new Error('无法校验：package.json version 不可用');
  mustExist('README.md');
  const head = readText('README.md').split(/\r?\n/).slice(0, 20);
  const found = new Set();
  for (const line of head) {
    const re = /(?:^|[^0-9A-Za-z])v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g;
    let m;
    while ((m = re.exec(line)) !== null) found.add(m[1]);
  }
  if (found.size === 0) throw new Error(`前 20 行没有 v<version> 锚点（期望 v${version}）`);
  const wrong = [...found].filter((v) => v !== version);
  if (wrong.length > 0) {
    throw new Error(`锚点版本 ${wrong.map((v) => `v${v}`).join(', ')} ≠ package.json 的 v${version}`);
  }
  return `v${version}`;
});

// ---------------------------------------------------------------- 3. files 白名单
const REQUIRED_FILES = ['lib', 'cordis.patch.yml', 'README.md'];
check('files 白名单包含 lib、cordis.patch.yml、README.md', () => {
  if (!Array.isArray(pkg?.files)) throw new Error('package.json 缺少 files 数组');
  const files = pkg.files.map(normalize);
  const missing = REQUIRED_FILES.filter((req) => !files.includes(normalize(req)));
  if (missing.length > 0) throw new Error(`files 缺少：${missing.join(', ')}`);
  return files.join(', ');
});

// ---------------------------------------------------------------- 4. exports 映射
const REQUIRED_EXPORTS = [
  ['.', 'lib/index.js'],
  ['./client', 'lib/client.js'],
  ['./cordis.patch.yml', 'cordis.patch.yml'],
];
check('exports 的 . / ./client / ./cordis.patch.yml 均指向 files 白名单内的真实文件', () => {
  const exp = pkg?.exports;
  if (!exp || typeof exp !== 'object' || Array.isArray(exp)) throw new Error('package.json 缺少 exports 对象');
  if (!Array.isArray(pkg?.files)) throw new Error('无法校验：files 白名单不可用');
  const problems = [];
  const okList = [];
  for (const [key, expectedTarget] of REQUIRED_EXPORTS) {
    if (!(key in exp)) {
      problems.push(`exports 缺少 "${key}"`);
      continue;
    }
    let entry = exp[key];
    // 允许条件导出对象：取 default，退化为第一个字符串值
    if (entry && typeof entry === 'object') {
      entry = entry.default ?? Object.values(entry).find((v) => typeof v === 'string');
    }
    if (typeof entry !== 'string') {
      problems.push(`exports["${key}"] 不是字符串或含 default 的对象`);
      continue;
    }
    const target = normalize(entry);
    if (target !== normalize(expectedTarget)) {
      problems.push(`exports["${key}"] 指向 ${target}，期望 ${normalize(expectedTarget)}`);
    }
    if (!coveredByFiles(target, pkg.files)) {
      problems.push(`exports["${key}"] 的 ${target} 不在 files 白名单内`);
    }
    if (!existsSync(abs(target))) {
      problems.push(`exports["${key}"] 的 ${target} 文件不存在`);
    } else if (!statSync(abs(target)).isFile()) {
      problems.push(`exports["${key}"] 的 ${target} 不是文件`);
    }
    okList.push(`${key} → ${target}`);
  }
  if (problems.length > 0) throw new Error(problems.join('；'));
  return okList.join('；');
});

// ---------------------------------------------------------------- 5. lib 实体 + 语法
const LIB_TARGETS = ['lib/index.js', 'lib/client.js'];
check('lib/index.js 与 lib/client.js 存在、>1KB、node --check 通过', () => {
  const problems = [];
  const okList = [];
  for (const rel of LIB_TARGETS) {
    const p = abs(rel);
    if (!existsSync(p)) {
      problems.push(`${rel} 不存在`);
      continue;
    }
    const size = statSync(p).size;
    if (!statSync(p).isFile()) {
      problems.push(`${rel} 不是文件`);
      continue;
    }
    if (size <= 1024) {
      problems.push(`${rel} 只有 ${size}B（需 >1KB）`);
      continue;
    }
    const res = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' });
    if (res.error) {
      problems.push(`${rel} node --check 无法执行：${res.error.message}`);
      continue;
    }
    if (res.status !== 0) {
      const msg = `${res.stderr || res.stdout || ''}`.trim().split(/\r?\n/).slice(0, 3).join(' | ');
      problems.push(`${rel} 语法检查失败：${msg}`);
      continue;
    }
    okList.push(`${rel} (${size}B, syntax ok)`);
  }
  if (problems.length > 0) throw new Error(problems.join('；'));
  return okList.join('；');
});

// ---------------------------------------------------------------- 6. cordis patch 挂载
check('cordis.patch.yml 存在、含 status-anim 挂载行、路径等于 dsh.bundle.patch', () => {
  const patchPath = pkg?.dsh?.bundle?.patch;
  if (typeof patchPath !== 'string' || !patchPath.trim()) {
    throw new Error('package.json 缺少 dsh.bundle.patch');
  }
  const rel = normalize(patchPath);
  if (rel !== 'cordis.patch.yml') {
    throw new Error(`dsh.bundle.patch 为 ${rel}，期望 cordis.patch.yml`);
  }
  mustExist(rel);
  const lines = readText(rel).split(/\r?\n/);
  const mount = lines.filter((line) => /^\s*-?\s*id:\s*["']?status-anim["']?\s*$/.test(line));
  if (mount.length === 0) throw new Error(`cordis.patch.yml 中找不到 id: status-anim 挂载行`);
  const named = lines.some((line) => /name:\s*["']?dsh-status-anim["']?\s*$/.test(line));
  return `${rel} 挂载行 ${mount.length} 条${named ? '，name: dsh-status-anim' : ''}`;
});

// ---------------------------------------------------------------- 7. package-lock 版本一致
check('package-lock.json（若存在）三处 version 与 package.json 一致', () => {
  if (!version) throw new Error('无法校验：package.json version 不可用');
  if (!existsSync(abs('package-lock.json'))) return '无 package-lock.json，跳过';
  let lock;
  try {
    lock = JSON.parse(readText('package-lock.json'));
  } catch (err) {
    throw new Error(`package-lock.json 不是合法 JSON：${err.message}`);
  }
  const problems = [];
  if (lock.version !== version) problems.push(`顶层 version=${lock.version} ≠ ${version}`);
  const rootPkg = lock.packages && lock.packages[''];
  if (!rootPkg) problems.push('packages[""] 缺失');
  else if (rootPkg.version !== version) problems.push(`packages[""].version=${rootPkg.version} ≠ ${version}`);
  if (problems.length > 0) throw new Error(problems.join('；'));
  return `3 处均为 ${version}`;
});

// ---------------------------------------------------------------- 8. private 提示（WARN）
if (pkg && pkg.private === true) {
  warn('private:true 未解除，npm publish 会被拒绝');
} else {
  pass('private 门禁', 'private 未设为 true，可发布');
}

// ---------------------------------------------------------------- 额外：CHANGELOG 容忍缺失
if (existsSync(abs('CHANGELOG.md'))) {
  pass('CHANGELOG.md', '存在');
} else {
  warn('CHANGELOG.md 不存在，跳过变更记录校验');
}

// ---------------------------------------------------------------- 汇总
console.log(
  `\n汇总：${results.pass} PASS / ${results.fail} FAIL / ${results.warn} WARN —— ${
    results.fail === 0 ? '发布门禁通过' : '发布门禁未通过'
  }`,
);

process.exit(results.fail === 0 ? 0 : 1);
