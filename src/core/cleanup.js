'use strict';

// Deleting unused files. Files only go to the Recycle Bin / Trash (the
// caller passes the trash function), and a file is never offered for
// deletion if anything still needs it.

const path = require('path');
const { assetFiles } = require('./analyze');
const { pathKey } = require('./fsutil');

/**
 * @param {object} session
 * @param {object} opts
 * @param {Set<string>} [opts.protectedKeys] path keys that must be kept
 *   (favorites, "keep" tags, files used by other scanned projects)
 * @param {Map<string,string>} [opts.protectedReasons] path key -> reason
 */
function planDeleteUnused(session, { protectedKeys = new Set(), protectedReasons = new Map() } = {}) {
  const neededKeys = new Set([pathKey(session.filePath)]);
  for (const a of session.assets) {
    if (!a.used) continue;
    for (const f of assetFiles(a)) neededKeys.add(pathKey(f.path));
    if (a.resolvedPath) neededKeys.add(pathKey(a.resolvedPath));
  }

  const groups = [];
  const skipped = [];
  const claimed = new Set();
  for (const a of session.assets) {
    if (a.kind !== 'file' || a.used || !a.exists) continue;
    const files = [];
    let size = 0;
    let reason = null;
    for (const f of assetFiles(a)) {
      const key = pathKey(f.path);
      if (neededKeys.has(key)) {
        reason = 'Also used by another item in this project';
        continue;
      }
      if (protectedKeys.has(key)) {
        reason = protectedReasons.get(key) || 'Protected';
        continue;
      }
      if (claimed.has(key)) continue;
      claimed.add(key);
      files.push(f.path);
      size += f.size;
    }
    if (files.length) {
      groups.push({ id: a.id, name: a.name, category: a.category, files, size, folder: path.dirname(files[0]) });
    } else if (reason) {
      skipped.push({ id: a.id, name: a.name, reason });
    }
  }
  groups.sort((x, y) => y.size - x.size);
  return {
    groups,
    skipped,
    totalSize: groups.reduce((s, g) => s + g.size, 0),
    fileCount: groups.reduce((s, g) => s + g.files.length, 0),
  };
}

/**
 * Moves files to the trash one by one.
 * @param {string[]} files
 * @param {(p: string) => Promise<void>} trash
 */
async function trashFiles(files, trash, { onProgress = () => {}, signal } = {}) {
  const trashed = [];
  const failed = [];
  for (let i = 0; i < files.length; i++) {
    if (signal && signal.aborted) break;
    if (i % 10 === 0) onProgress({ phase: 'Moving to Recycle Bin', done: i, total: files.length, current: files[i] });
    try {
      await trash(files[i]);
      trashed.push(files[i]);
    } catch (err) {
      failed.push({ path: files[i], error: err.message });
    }
  }
  onProgress({ phase: 'Done', done: files.length, total: files.length });
  return { trashed, failed };
}

module.exports = { planDeleteUnused, trashFiles };
