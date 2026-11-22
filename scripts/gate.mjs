// 改动检查：用机器能数的东西给改动定坚硬度，供 Critic 和 Guardian 引用。规则说明见 CLAUDE.md
// node scripts/gate.mjs [--base 提交] [--declare H2] [--no-test]
//   --declare 是提案里声明的级别；实际级别更高、缺注释或测试失败时，以非零状态结束
// node scripts/gate.mjs --hook   由 .claude/settings.json 调用：改 H2 以上的文件前要求用户点头
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 按文件定级，从硬到软，取第一个符合的。钩子和报告共用这一张表，避免两处各写一份后走样
const FILE_RULES = [
  [4, /^app\/lib\/(context|redact|prompts-en)\.js$/, '决定发给外部 AI 的内容'],
  [4, /^app\/lib\/providers\.js$/, 'AI 的权限与 CLI 参数'],
  [4, /^app\/lib\/crypto-store\.js$/, '数据金钥与加密格式'],
  [3, /^app\/lib\/(parsers|runner)\.js$/, '外部 CLI 的输出与调用方式'],
  [3, /^app\/lib\/security\.js$/, '本机 API 防护与新旧版本互认'],
  [3, /^[^/]+\.(bat|ps1|vbs)$|^scripts\/build\.mjs$/, '安装、卸载与打包'],
  [3, /^CLAUDE\.md$|^\.claude\/|^scripts\/gate\.mjs$/, '护栏本身'],
  [2, /^app\/lib\/(store|paths|workspace)\.js$/, '用户磁盘上的数据格式与位置'],
  [1, /^app\/(server\.js|lib\/|ui\/js\/i18n)|^package\.json$|^scripts\/|^\.github\//, '内部结构'],
];
// 按改动的内容定级，只看 app/ 里的程序行。软文件里出现硬操作时，用它把级别拉上来
const LINE_RULES = [
  [4, /\b(rm|rmdir|unlink)(Sync)?\(/, '删除文件'],
  [4, /\b(buildPayload|runCli)\b/, '发送给外部 AI 的路径'],
  [3, /RTEXP1|__identity|__shutdown|Content-Security-Policy/, '外部契约'],
  [2, /\bSCHEMA\b|\bmigrate|RTENC1|\.rtb\b|\bstore\.save\(/, '持久数据'],
];
const CJK = /[一-鿿]/;
// 空行和整行注释都不算程序；用来排除只改注释的改动
const isComment = line => /^\s*(\/\/|\/\*|\*|$)/.test(line);

// 返回一个路径的级别与理由；没有规则命中的（样式、文档、测试）算 H0
export function fileLevel(file) {
  const hit = FILE_RULES.find(([, re]) => re.test(file));
  return hit ? { level: hit[0], why: hit[2] } : { level: 0, why: '' };
}

// 合并"改了哪个文件"和"改了什么行"，取较硬者。只改注释时算 H0：坚硬度看行为，不看文件名
export function changeLevel(file, lines) {
  const code = /\.m?js$/.test(file) ? lines.filter(l => !isComment(l)) : lines;
  if (!code.length) return { level: 0, reasons: [] };
  const byFile = fileLevel(file), reasons = byFile.level ? [`H${byFile.level} ${byFile.why}`] : [];
  let level = byFile.level;
  if (/^app\/.*\.js$/.test(file)) for (const [l, re, why] of LINE_RULES) {
    if (code.some(x => re.test(x))) { level = Math.max(level, l); reasons.push(`H${l} ${why}`); }
  }
  return { level, reasons };
}

// 认出一行是不是具名函数或 API 分支的开头，返回它的名字。只认常见写法，不做完整语法解析，所以不引入解析器依赖
export function defName(line) {
  const m = line.match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)/)
    || line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|\(?\{[^=]*\}\)?\s*=>|[\w$]+\s*=>)/)
    || line.match(/^\s*case\s+'(\/api\/[^']+)'/)
    || line.match(/^\s*(?:async\s+)?(?!(?:if|for|while|switch|catch|return|function)\b)([\w$]+)\([^()]*\)\s*\{/);
  return m ? m[1] : null;
}

// 找出被改到、上方却没有中文注释的函数。改动落在函数体里时，往上找缩进更浅的那个定义，所以只改函数体也会查到。
// 单独的收尾括号跳过：它的缩进属于外层，会误指到外层函数
export function missingComments(text, changed) {
  const lines = text.split(/\r?\n/), indent = l => l.match(/^\s*/)[0].length, missing = new Map();
  for (const n of changed) {
    const line = lines[n - 1];
    if (line === undefined || isComment(line) || /^\s*[\])}]+[;,]?\s*$/.test(line)) continue;
    let at = n - 1;
    if (!defName(line)) {
      const depth = indent(line);
      for (at = n - 2; at >= 0; at--) if (lines[at].trim() && indent(lines[at]) < depth && defName(lines[at])) break;
      if (at < 0) continue;
    }
    let above = at - 1, note = '';
    while (above >= 0 && lines[above].trim() && isComment(lines[above])) note += lines[above--];
    if (!CJK.test(note)) missing.set(at + 1, defName(lines[at]));
  }
  return [...missing].map(([line, name]) => ({ line, name }));
}

// 列出一个文件对外暴露的概念：导出名与 API 路径。新旧两份相减，就是新增的概念数
export function concepts(text) {
  const out = new Set();
  for (const m of text.matchAll(/module\.exports\s*=\s*\{([^}]*)\}/g)) for (const n of m[1].split(',')) if (n.trim()) out.add('导出 ' + n.split(':')[0].trim());
  for (const m of text.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([\w$]+)/gm)) out.add('导出 ' + m[1]);
  for (const m of text.matchAll(/case\s+'(\/api\/[^']+)'/g)) out.add('API ' + m[1]);
  return out;
}

// 判断一次工具调用要不要先问用户。仓库外的文件不管，免得妨碍临时目录里的实验
export function hookDecision(input, root = ROOT) {
  const file = input.tool_input?.file_path || input.tool_input?.notebook_path;
  if (!file) return null;
  const rel = path.relative(root, path.resolve(root, file)).split(path.sep).join('/');
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const { level, why } = fileLevel(rel);
  if (level < 2) return null;
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: `${rel} 属于 H${level}（${why}），改动前需要你同意` } };
}

// 在仓库根目录跑一条只读的 git 指令。参数用数组传、不经过 shell，文件名里的特殊字符不会被解释
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

// 读出某个提交里的文件；当时还没有这个文件就当成空，新增文件因此会整份算作新概念
function oldText(base, file) { try { return git('show', `${base}:${file}`); } catch { return ''; } }

// 把 git diff 整理成「文件 → 增删的行与新行号」。未跟踪的文件也算进来，否则新文件会漏检
function readChanges(base) {
  const files = new Map(); let cur = null, n = 0;
  for (const line of git('-c', 'core.quotepath=off', 'diff', '--no-color', '--no-ext-diff', '--no-renames', '--unified=0', base).split('\n')) {
    const head = line.match(/^diff --git a\/.* b\/(.*)$/), hunk = line.match(/^@@ -\S+ \+(\d+)/);
    if (head) files.set(head[1], cur = { added: [], removed: [], at: [], body: false });
    else if (hunk) { n = Number(hunk[1]); cur.body = true; }
    else if (cur?.body && line[0] === '+') { cur.added.push(line.slice(1)); cur.at.push(n++); }
    else if (cur?.body && line[0] === '-') cur.removed.push(line.slice(1));
  }
  for (const f of git('-c', 'core.quotepath=off', 'ls-files', '-o', '--exclude-standard').split('\n').filter(Boolean)) {
    const lines = fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n');
    files.set(f, { added: lines, removed: [], at: lines.map((_, i) => i + 1), isNew: true });
  }
  return files;
}

// 汇总并打印报告。只报事实，不评价好坏：判断交给 Critic、Guardian 和用户
function report({ base, declared, runTests }) {
  const files = readChanges(base), problems = []; let level = 0, removedAsserts = 0; const added = [];
  for (const [file, c] of files) {
    const { level: l, reasons } = changeLevel(file, [...c.added, ...c.removed]);
    level = Math.max(level, l);
    console.log(`H${l}  ${file}  +${c.added.length} -${c.removed.length}${reasons.length ? '  ' + reasons.join('；') : ''}`);
    if (/^test\/.*\.mjs$/.test(file)) removedAsserts += c.removed.filter(x => /\bassert\b/.test(x)).length;
    const full = path.join(ROOT, file);
    if (!/^(app|scripts)\/.*\.m?js$/.test(file) || !fs.existsSync(full)) continue;
    const now = fs.readFileSync(full, 'utf8'), before = oldText(base, file), was = concepts(before);
    if (!before) added.push('文件 ' + file);
    for (const x of concepts(now)) if (!was.has(x)) added.push(`${x}（${file}）`);
    for (const m of missingComments(now, c.at)) problems.push(`缺中文注释：${file}:${m.line} ${m.name}`);
  }
  console.log(`\n实际坚硬度 H${level}，声明 H${declared}`);
  console.log(`新增概念 ${added.length}${added.length ? '：\n  ' + added.join('\n  ') : ''}`);
  if (removedAsserts) console.log(`注意：删改了 ${removedAsserts} 行既有断言，需要说明理由`);
  if (level > declared) problems.push(`实际 H${level} 高于声明的 H${declared}，需按 H${level} 的要求重走流程`);
  if (runTests) {
    const r = spawnSync(process.execPath, ['--test', 'test/*.test.mjs'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    console.log(`测试${r.status === 0 ? '通过' : '失败'}：${(r.stdout.match(/^ℹ (tests|pass|fail) \d+/gm) || []).join('，').replaceAll('ℹ ', '')}`);
    if (r.status !== 0) problems.push('测试失败');
  } else console.log('没有跑测试（--no-test）');
  console.log(problems.length ? '\n未通过：\n  ' + problems.join('\n  ') : '\n通过');
  return problems.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2), opt = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
  if (argv.includes('--hook')) {
    const d = hookDecision(JSON.parse(fs.readFileSync(0, 'utf8')));
    if (d) console.log(JSON.stringify(d));
  } else {
    const m = /^H([0-4])$/.exec(opt('--declare', 'H0'));
    if (!m) { console.error('--declare 只接受 H0 到 H4'); process.exit(2); }
    process.exitCode = report({ base: opt('--base', 'HEAD'), declared: Number(m[1]), runTests: !argv.includes('--no-test') });
  }
}
