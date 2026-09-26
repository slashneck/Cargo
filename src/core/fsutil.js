'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

/** A stable key for comparing file paths on this platform. */
function pathKey(p) {
  if (!p) return '';
  let n = path.normalize(String(p));
  if (process.platform === 'win32') n = n.replace(/\//g, '\\');
  n = n.replace(/[\\/]+$/, '');
  return CASE_INSENSITIVE ? n.toLowerCase() : n;
}

/** Splits a path from any OS into its components (drive/root dropped). */
function pathParts(p) {
  return String(p)
    .replace(/^[a-zA-Z]:/, '')
    .split(/[\\/]+/)
    .filter(Boolean);
}

function baseName(p) {
  const parts = pathParts(p);
  return parts.length ? parts[parts.length - 1] : String(p);
}

async function statSafe(p) {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

async function exists(p) {
  return (await statSafe(p)) !== null;
}

/** Runs `worker` over `items` with at most `limit` in flight. */
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

/** Caches directory listings (name list) for the lifetime of one operation. */
class DirCache {
  constructor() {
    this.map = new Map();
  }
  list(dir) {
    const key = pathKey(dir);
    if (!this.map.has(key)) {
      this.map.set(
        key,
        fsp.readdir(dir, { withFileTypes: true }).then(
          (entries) => entries.filter((e) => e.isFile()).map((e) => e.name),
          () => [],
        ),
      );
    }
    return this.map.get(key);
  }
}

/** Picks a path inside `dir` that does not exist yet ("name (2).ext"). */
async function uniquePath(target) {
  if (!(await exists(target))) return target;
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const stem = path.basename(target, ext);
  for (let i = 2; i < 10000; i++) {
    const candidate = path.join(dir, `${stem} (${i})${ext}`);
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error(`Could not find a free name for ${target}`);
}

/** Replaces characters that are invalid in Windows/macOS file names. */
function safeName(name, fallback = 'Untitled') {
  const cleaned = String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim();
  const reserved = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
  if (!cleaned || reserved.test(cleaned)) return fallback;
  return cleaned.slice(0, 180);
}

function dateStamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Writes a file atomically (temp file + rename). */
async function writeFileAtomic(target, data) {
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, target);
}

module.exports = {
  pathKey,
  pathParts,
  baseName,
  statSafe,
  exists,
  pool,
  DirCache,
  uniquePath,
  safeName,
  dateStamp,
  writeFileAtomic,
};
