'use strict';

// Leftovers: media files in a project's folders (and, for FL Studio, the
// recording and render folders) that the project doesn't reference at all,
// such as vocal takes deleted from the channel rack or renders that were
// bounced and replaced. A file only counts as a leftover if no other project
// Cargo can find uses it either: FL Studio's Recorded folder is shared by
// every project.

const fsp = require('fs').promises;
const path = require('path');
const media = require('./media');
const { pathKey, statSafe, pool } = require('./fsutil');
const { assetFiles } = require('./analyze');
const { parseFlp } = require('./flp');
const flenv = require('./flenv');

const AUDIO = new Set(['wav', 'wave', 'mp3', 'flac', 'ogg', 'aif', 'aiff', 'aifc', 'wv', 'm4a', 'aac', 'opus', 'wma', 'mid', 'midi', 'rex', 'rx2', 'sf2']);
const AE_MEDIA = new Set(['video', 'audio', 'image', 'graphics']);
const SKIP_DIRS = /^(node_modules|\.git|\$recycle\.bin|system volume information)$/i;
const AUTO_SAVE = /auto[-\s_]?save|^backup$|\(overwritten at/i;

function isCandidate(format, file) {
  const ext = media.extOf(file);
  if (format === 'flp') return AUDIO.has(ext);
  return AE_MEDIA.has(media.categoryOf(ext));
}

async function walk(root, { depth = 6, limit, accept, signal }) {
  const out = [];
  const stack = [{ dir: root, d: 0 }];
  while (stack.length && out.length < limit) {
    if (signal && signal.aborted) break;
    const { dir, d } = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (d < depth && !SKIP_DIRS.test(e.name) && !e.name.startsWith('.')) stack.push({ dir: full, d: d + 1 });
      } else if (e.isFile() && accept(full, e.name)) {
        out.push(full);
      }
    }
  }
  return out;
}

/** Every file another project refers to, as path keys, with that project's name. */
async function referencedByOthers(projectFiles, { format, env, onProgress, signal }) {
  const keys = new Map();
  let checked = 0;
  for (const file of projectFiles) {
    if (signal && signal.aborted) break;
    checked++;
    if (checked % 10 === 0) onProgress({ phase: 'Checking your other projects', done: checked, total: projectFiles.length });
    let footage;
    try {
      const buf = await fsp.readFile(file);
      if (format === 'flp') footage = parseFlp(buf).footage;
      else footage = require('./analyze').parseProjectBuffer(file, buf).footage;
    } catch {
      continue;
    }
    const name = path.basename(file).replace(/\.[^.]+$/, '');
    const dir = path.dirname(file);
    for (const f of footage) {
      if (!f.path) continue;
      const real = format === 'flp' ? flenv.expandPath(f.path, env) : f.path;
      keys.set(pathKey(real), name);
      // FL Studio also finds samples sitting next to the project file.
      if (format === 'flp') keys.set(pathKey(path.join(dir, path.basename(real.replace(/\\/g, '/')))), name);
    }
  }
  return { keys, checked };
}

/**
 * @param {object} session scanned project
 * @param {object} opts
 * @param {string[]} opts.folders where to look for leftover files
 * @param {string[]} opts.projectRoots where to look for other projects
 * @param {object} [opts.env] FL Studio environment (flenv.environment())
 */
async function findLeftovers(session, { folders, projectRoots, env = flenv.environment(), onProgress = () => {}, signal, maxFiles = 50000, maxProjects = 3000 } = {}) {
  const format = session.format === 'flp' ? 'flp' : 'aep';
  const existing = [];
  for (const f of [...new Set(folders.filter(Boolean).map((f) => path.resolve(f)))]) {
    const st = await statSafe(f);
    if (st && st.isDirectory()) existing.push(f);
  }
  // Nested folders are walked once, from the outermost.
  const roots = existing.filter((f) => !existing.some((g) => g !== f && pathKey(f).startsWith(pathKey(g) + path.sep.toLowerCase())));

  onProgress({ phase: 'Looking for leftover files' });
  const own = new Set([pathKey(session.filePath)]);
  for (const a of session.assets) {
    if (a.leftover) continue;
    for (const f of assetFiles(a)) own.add(pathKey(f.path));
    if (a.resolvedPath) own.add(pathKey(a.resolvedPath));
  }
  const candidates = [];
  for (const root of roots) {
    const files = await walk(root, { limit: maxFiles - candidates.length, accept: (full) => isCandidate(format, full), signal });
    candidates.push(...files);
    if (candidates.length >= maxFiles) break;
  }
  const notOwn = candidates.filter((f) => !own.has(pathKey(f)) && !(format === 'flp' && flenv.isStock(f, f, env)));

  // Other projects of the same program that might use those files.
  const projectExt = format === 'flp' ? /\.flp$/i : /\.aepx?$/i;
  const projectFiles = new Set();
  for (const root of [...new Set([...projectRoots, ...roots].filter(Boolean))]) {
    if (!(await statSafe(root))) continue;
    const found = await walk(root, {
      limit: maxProjects,
      accept: (full, name) => projectExt.test(name) && !AUTO_SAVE.test(name) && !AUTO_SAVE.test(path.basename(path.dirname(full))),
      signal,
    });
    found.forEach((f) => projectFiles.add(f));
    if (projectFiles.size >= maxProjects) break;
  }
  projectFiles.forEach((f) => {
    if (pathKey(f) === pathKey(session.filePath)) projectFiles.delete(f);
  });
  const { keys: others, checked } = await referencedByOthers([...projectFiles], { format, env, onProgress, signal });

  const leftovers = [];
  let keptForOthers = 0;
  const stats = await pool(notOwn, 16, statSafe);
  notOwn.forEach((file, i) => {
    if (others.has(pathKey(file))) {
      keptForOthers++;
      return;
    }
    const st = stats[i];
    if (!st) return;
    const root = roots.find((r) => pathKey(file).startsWith(pathKey(r)));
    leftovers.push({ path: file, size: st.size, mtime: st.mtimeMs, folder: root ? path.basename(root) : path.basename(path.dirname(file)), duration: null });
  });
  const { wavDuration } = require('./analyze');
  await pool(
    leftovers.filter((l) => /\.wave?$/i.test(l.path)),
    8,
    async (l) => {
      l.duration = await wavDuration(l.path);
    },
  );
  leftovers.sort((a, b) => b.size - a.size);
  return { leftovers, keptForOthers, projectsChecked: checked, folders: roots, complete: candidates.length < maxFiles, others };
}

module.exports = { findLeftovers, isCandidate };
