import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileLevel, changeLevel, defName, missingComments, concepts, hookDecision } from '../scripts/gate.mjs';

test('gate: file and content decide the level, comments alone do not', () => {
  assert.equal(fileLevel('app/ui/style.css').level, 0);
  assert.equal(fileLevel('app/lib/search.js').level, 1);
  assert.equal(fileLevel('app/lib/store.js').level, 2);
  assert.equal(fileLevel('setup.ps1').level, 3);
  assert.equal(fileLevel('app/lib/context.js').level, 4);
  assert.equal(fileLevel('.claude/settings.json').level, 3);
  assert.equal(changeLevel('app/server.js', ['const a = 1;']).level, 1);
  assert.equal(changeLevel('app/server.js', ['fs.rmSync(dir);']).level, 4);
  assert.equal(changeLevel('app/server.js', ['p.x = 1; store.save();']).level, 2);
  assert.equal(changeLevel('app/lib/context.js', ['// 只改注释', '']).level, 0);
  assert.equal(changeLevel('test/store.test.mjs', ['fs.rmSync(dir);']).level, 0);
});

test('gate: recognizes the ways this repo names functions', () => {
  for (const [line, name] of [
    ['function a(b) {', 'a'], ['export async function load() {', 'load'], ['const f = x => x + 1;', 'f'],
    ['  const g = (a, b) => {', 'g'], ['const h = ({ a }) => a;', 'h'], ["      case '/api/chat/new': {", '/api/chat/new'],
    ['    restore(name) { return 1; },', 'restore'],
  ]) assert.equal(defName(line), name, line);
  for (const line of ['if (a) {', 'for (const x of y) {', 'const n = 3;', 'items.map(x => x.id)', '  return f(a);']) assert.equal(defName(line), null, line);
});

test('gate: a changed body is traced to its function; English or absent comments count as missing', () => {
  const src = ['// 说明这样做的原因', 'function ok() {', '  return 1;', '}', '// english only', 'function bad() {', '  return 2;', '}'].join('\n');
  assert.deepEqual(missingComments(src, [3]), []);
  assert.deepEqual(missingComments(src, [7]), [{ line: 6, name: 'bad' }]);
  assert.deepEqual(missingComments('const top = 1;', [1]), []);
});

test('gate: counts exports and API routes', () => {
  assert.deepEqual([...concepts("module.exports = { a, b: c };\ncase '/api/x': return;")], ['导出 a', '导出 b', 'API /api/x']);
  assert.deepEqual([...concepts('export function one() {}\nexport const two = 2;')], ['导出 one', '导出 two']);
});

test('gate: the hook asks for H2 and above, and ignores soft or outside files', () => {
  const root = path.resolve('/repo'), ask = f => hookDecision({ tool_input: { file_path: f } }, root);
  assert.equal(ask(path.join(root, 'app/lib/store.js')).hookSpecificOutput.permissionDecision, 'ask');
  assert.equal(ask(path.join(root, 'app/ui/style.css')), null);
  assert.equal(ask(path.resolve('/elsewhere/app/lib/store.js')), null);
  assert.equal(hookDecision({ tool_input: { command: 'ls' } }, root), null);
});
