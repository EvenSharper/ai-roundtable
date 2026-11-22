const fs = require('fs');
const path = require('path');
const { resolveInside } = require('./workspace');

const TEXT_TYPES = new Set(['.txt', '.md', '.csv', '.json', '.html', '.htm', '.xml', '.yml', '.yaml', '.log']);
const MAX_BYTES = 800000;

function defaultMaterialsRoot(dataDir) {
  try {
    return fs.readFileSync(path.join(dataDir, 'materials-root.txt'), 'utf8').trim();
  } catch {
    return '';
  }
}

function validateMaterialsRoot(input) {
  const folder = typeof input === 'string' ? input.trim().replace(/^"(.+)"$/, '$1') : '';
  const isLocalAbsolute = process.platform === 'win32' ? /^[a-z]:[\\/]/i.test(folder) : path.isAbsolute(folder);
  if (isLocalAbsolute) {
    try {
      const real = fs.realpathSync(folder);
      if (fs.statSync(real).isDirectory()) return real;
    } catch {}
  }
  throw new Error('請輸入現有資料夾的完整路徑 / Enter the full path of an existing folder');
}

function readLinkedMaterial(root, relativePath, maxChars) {
  if (!root) throw new Error('尚未設定會議資料來源 / No meeting materials folder is configured');
  root = validateMaterialsRoot(root);
  const relative = String(relativePath || '').trim();
  if (relative.includes(':') || !TEXT_TYPES.has(path.extname(relative).toLowerCase())) {
    throw new Error('請輸入資料來源內的文字檔相對路徑 / Enter a relative path to a supported text file');
  }
  const target = fs.realpathSync(resolveInside(root, relative));
  resolveInside(root, path.relative(fs.realpathSync(root), target));
  if (!fs.statSync(target).isFile()) throw new Error('請選擇一般檔案 / Select a regular file');
  const descriptor = fs.openSync(target, 'r');
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size > MAX_BYTES) throw new Error('檔案過大或無法讀取 / File is too large or unreadable');
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (!count) break;
      offset += count;
    }
    const after = fs.fstatSync(descriptor);
    if (offset !== before.size || before.mtimeMs !== after.mtimeMs || before.size !== after.size) {
      throw new Error('檔案正在更新，請重試 / File changed while reading; retry');
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset));
    if (!text.trim() || text.length > maxChars || text.includes('\0')) {
      throw new Error('請提供有效的 UTF-8 文字檔（最多 200,000 字） / Use UTF-8 text up to 200,000 characters');
    }
    return { text, sourceRoot: root, sourcePath: relative, sourceModified: after.mtime.toISOString() };
  } finally {
    fs.closeSync(descriptor);
  }
}

module.exports = { defaultMaterialsRoot, validateMaterialsRoot, readLinkedMaterial };
