'use strict';

// Missing file finder. For every missing file it tries, in order of
// confidence:
//   1. the same path on another drive letter (external drives move around)
//   2. the tail of the original path under each search root
//      (D:\Jobs\Acme\Footage\a.mov -> <root>\Acme\Footage\a.mov)
//   3. a file-name index built by walking the search roots
// Candidates are scored by how many trailing path components match.

const fsp = require('fs').promises;
const path = require('path');
const { pathParts, statSafe, pathKey } = require('./fsutil');

const SKIP_DIRS = new Set(['$recycle.bin', 'system volume information', 'windows', 'program files', 'program files (x86)', 'programdata', 'appdata', 'node_modules', '.git', '.trash', '.trashes', '.spotlight-v100', '.fseventsd', 'library']);

function lower(s) {
  return s.toLowerCase();
}

function trailingMatch(aParts, bParts) {
  let n = 0;
  while (n < aParts.length && n < bParts.length && lower(aParts[aParts.length - 1 - n]) === lower(bParts[bParts.length - 1 - n])) n++;
  return n;
}

async function driveRoots() {
  if (process.platform !== 'win32') {
    const roots = ['/'];
    for (const base of ['/Volumes', '/media', '/mnt']) {
      try {
        for (const e of await fsp.readdir(base, { withFileTypes: true })) {
          if (e.isDirectory()) roots.push(path.join(base, e.name));
        }
      } catch {
        // not present on this OS
      }
    }
    return roots;
  }
  const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const found = await Promise.all(letters.map(async (l) => ((await statSafe(`${l}:\\`)) ? `${l}:\\` : null)));
  return found.filter(Boolean);
}

/**
 * Builds an index of file names under `roots`.
 * Stops after `maxFiles` files or when `deadline` passes.
 */
async function buildIndex(roots, wanted, { maxFiles = 400000, deadline, onProgress, signal } = {}) {
  const index = new Map();
  const seen = new Set();
  let files = 0;
  let dirsVisited = 0;
  for (const root of roots) {
    const stack = [{ dir: root, depth: 0 }];
    while (stack.length) {
      if (signal && signal.aborted) return { index, complete: false };
      if (files >= maxFiles || (deadline && Date.now() > deadline)) return { index, complete: false };
      const { dir, depth } = stack.pop();
      const key = pathKey(dir);
      if (seen.has(key)) continue;
      seen.add(key);
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      dirsVisited++;
      if (onProgress && dirsVisited % 200 === 0) onProgress({ phase: 'Searching folders', done: files, current: dir });
      for (const e of entries) {
        if (e.isDirectory()) {
          if (depth < 14 && !SKIP_DIRS.has(lower(e.name)) && !e.name.startsWith('.')) {
            stack.push({ dir: path.join(dir, e.name), depth: depth + 1 });
          }
        } else if (e.isFile()) {
          files++;
          const name = lower(e.name);
          if (wanted.has(name)) {
            let list = index.get(name);
            if (!list) index.set(name, (list = []));
            list.push(path.join(dir, e.name));
          }
        }
      }
    }
  }
  return { index, complete: true };
}

/**
 * @param {{id: number, path: string}[]} missing assets with their stored path
 * @param {object} opts
 * @param {string[]} opts.roots folders to search (project folder etc.)
 * @param {boolean} [opts.deep] also walk the search roots (slower)
 * @returns {Promise<{results: {id, path, candidates: {path, score, reason}[]}[], complete: boolean}>}
 */
async function findMissing(missing, opts) {
  const { roots = [], deep = true, timeLimitMs = 45000, onProgress, signal } = opts;
  const drives = await driveRoots();
  const results = missing.map((m) => ({ id: m.id, path: m.path, candidates: [] }));
  const add = (r, candidate, score, reason) => {
    const key = pathKey(candidate);
    const existing = r.candidates.find((c) => pathKey(c.path) === key);
    if (existing) {
      existing.score = Math.max(existing.score, score);
      return;
    }
    r.candidates.push({ path: candidate, score, reason });
  };

  // 1 + 2: direct probes (cheap).
  let done = 0;
  for (const r of results) {
    if (signal && signal.aborted) break;
    const parts = pathParts(r.path);
    if (!parts.length) continue;
    const probes = [];
    // A macOS volume path (/Volumes/Name/...) maps onto a drive root elsewhere.
    const onVolume = parts[0] === 'Volumes' && parts.length > 2 ? parts.slice(2) : null;
    for (const d of drives) {
      probes.push({ p: path.join(d, ...parts), reason: 'Same path on another drive' });
      if (onVolume) probes.push({ p: path.join(d, ...onVolume), reason: 'Same path on another drive' });
    }
    for (const root of roots) {
      for (let k = 1; k <= Math.min(parts.length, 6); k++) {
        probes.push({ p: path.join(root, ...parts.slice(parts.length - k)), reason: 'Found near the project' });
      }
    }
    for (const probe of probes) {
      if (pathKey(probe.p) === pathKey(r.path)) continue;
      const st = await statSafe(probe.p);
      if (st && st.isFile()) add(r, probe.p, trailingMatch(parts, pathParts(probe.p)) + 1, probe.reason);
    }
    done++;
    if (onProgress) onProgress({ phase: 'Checking likely locations', done, total: results.length });
  }

  // 3: walk the roots for anything still unresolved.
  let complete = true;
  const unresolved = results.filter((r) => r.candidates.length === 0);
  if (deep && unresolved.length && roots.length && !(signal && signal.aborted)) {
    const wanted = new Set(unresolved.map((r) => lower(pathParts(r.path).pop() || '')));
    const { index, complete: finished } = await buildIndex(roots, wanted, {
      deadline: Date.now() + timeLimitMs,
      onProgress,
      signal,
    });
    complete = finished;
    for (const r of unresolved) {
      const parts = pathParts(r.path);
      for (const hit of index.get(lower(parts[parts.length - 1] || '')) || []) {
        add(r, hit, trailingMatch(parts, pathParts(hit)), 'Same file name');
      }
    }
  }

  for (const r of results) r.candidates.sort((a, b) => b.score - a.score);
  return { results, complete };
}

/** Candidate we are confident enough about to apply automatically. */
function bestCandidate(result) {
  const [first, second] = result.candidates;
  if (!first) return null;
  if (!second || first.score > second.score) return first;
  return null;
}

module.exports = { findMissing, bestCandidate, driveRoots };
