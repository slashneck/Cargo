'use strict';

// Collecting a project's files into a new layout. Package, Archive and
// Organize all build a plan with `planCollect` and run it with
// `copyToFolder` / `writeZip`, so every operation lays files out the same way.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { Transform, pipeline } = require('stream');
const { promisify } = require('util');
const yazl = require('yazl');
const media = require('./media');
const { pathKey, safeName, statSafe } = require('./fsutil');
const { assetFiles } = require('./analyze');
const { parseAep, rewriteFootagePaths } = require('./aep');
const { parseAepx, rewriteAepxPaths } = require('./aepx');

const pipe = promisify(pipeline);

const LAYOUTS = {
  type: 'By type (Video, Audio, Images…)',
  project: 'Mirror After Effects project folders',
  resolution: 'By type and resolution',
  date: 'By date modified (year / month)',
  flat: 'Everything in one folder',
};

function sequenceFolderName(asset) {
  const fromName = String(asset.sequencePattern || asset.name || '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[\s._-]+$/, '');
  return safeName(fromName, `Sequence ${asset.id}`);
}

function folderFor(asset, layout) {
  const label = media.CATEGORY_LABELS[asset.category] || 'Other';
  switch (layout) {
    case 'project':
      return asset.folderPath ? asset.folderPath.split('/').map((p) => safeName(p)).join('/') : '';
    case 'resolution': {
      const res = asset.width && asset.height ? `${asset.width}x${asset.height}` : null;
      return res && ['video', 'image', 'sequence'].includes(asset.category) ? `${label}/${res}` : label;
    }
    case 'date': {
      const d = asset.mtime ? new Date(asset.mtime) : null;
      if (!d) return 'Unknown date';
      const m = String(d.getMonth() + 1).padStart(2, '0');
      return `${d.getFullYear()}/${d.getFullYear()}-${m}`;
    }
    case 'flat':
      return '';
    case 'type':
    default:
      return label;
  }
}

/**
 * Decides where every file goes.
 * @param {object} session scanned project
 * @param {object} opts
 * @param {boolean} opts.includeUnused
 * @param {string} opts.layout one of LAYOUTS
 * @param {string} [opts.prefix] folder inside the destination ("Footage")
 * @param {Set<number>} [opts.onlyAssetIds] restrict to these assets
 */
function planCollect(session, opts) {
  const { includeUnused = false, layout = 'type', prefix = '', onlyAssetIds = null } = opts;
  const entries = [];
  const bySource = new Map(); // source key -> entry
  const taken = new Set(); // lower-cased relative destinations
  const assetTargets = new Map(); // asset id -> relative path of its (first) file
  const skipped = [];

  const claim = (rel) => {
    let candidate = rel;
    const ext = path.posix.extname(rel);
    const stem = rel.slice(0, rel.length - ext.length);
    for (let i = 2; taken.has(candidate.toLowerCase()); i++) candidate = `${stem} (${i})${ext}`;
    taken.add(candidate.toLowerCase());
    return candidate;
  };
  const join = (...parts) => parts.filter(Boolean).join('/');

  const assets = session.assets.filter((a) => a.kind === 'file' && (!onlyAssetIds || onlyAssetIds.has(a.id)));
  // Used assets first so shared files land in the "used" location.
  assets.sort((a, b) => Number(b.used) - Number(a.used));

  for (const asset of assets) {
    if (!asset.used && !includeUnused) {
      skipped.push({ id: asset.id, name: asset.name, reason: 'unused', size: asset.size });
      continue;
    }
    if (!asset.exists) {
      skipped.push({ id: asset.id, name: asset.name, reason: 'missing', size: 0 });
      continue;
    }
    const files = assetFiles(asset);
    const base = join(prefix, folderFor(asset, layout));
    if (asset.isSequence || asset.isFolder) {
      const firstKey = pathKey(files[0].path);
      if (bySource.has(firstKey)) {
        assetTargets.set(asset.id, bySource.get(firstKey).rel);
        continue;
      }
      // Frames keep their names inside their own folder.
      const folderName = asset.isFolder ? safeName(path.basename(asset.resolvedPath)) : sequenceFolderName(asset);
      const seqDir = claim(join(base, folderName));
      for (const f of files) {
        const inner = asset.isFolder ? path.relative(asset.resolvedPath, f.path).split(path.sep).map((p) => safeName(p)).join('/') : safeName(path.basename(f.path));
        const rel = join(seqDir, inner);
        taken.add(rel.toLowerCase());
        const entry = { src: f.path, rel, size: f.size, mtime: asset.mtime, assetIds: [asset.id], used: asset.used };
        entries.push(entry);
        bySource.set(pathKey(f.path), entry);
      }
      const primary = asset.isFolder ? seqDir : join(seqDir, safeName(path.basename(asset.resolvedPath)));
      assetTargets.set(asset.id, primary);
      continue;
    }
    const key = pathKey(asset.resolvedPath);
    const existing = bySource.get(key);
    if (existing) {
      existing.assetIds.push(asset.id);
      existing.used = existing.used || asset.used;
      assetTargets.set(asset.id, existing.rel);
      continue;
    }
    const rel = claim(join(base, safeName(path.basename(asset.resolvedPath))));
    const entry = { src: asset.resolvedPath, rel, size: asset.size, mtime: asset.mtime, assetIds: [asset.id], used: asset.used };
    entries.push(entry);
    bySource.set(key, entry);
    assetTargets.set(asset.id, rel);
  }

  const totalBytes = entries.reduce((s, e) => s + e.size, 0);
  return { entries, assetTargets, skipped, totalBytes, layout };
}

/** Maps each stored footage path to its new absolute location. */
function pathMapping(session, plan, absoluteRoot) {
  const mapping = new Map();
  for (const asset of session.assets) {
    const rel = plan.assetTargets.get(asset.id);
    if (!rel || !asset.path) continue;
    mapping.set(asset.path, path.join(absoluteRoot, ...rel.split('/')));
  }
  return mapping;
}

/**
 * Produces a copy of the project with footage paths rewritten, and checks
 * the result still parses to the same items. Falls back to the original
 * bytes (with a warning) if anything looks off.
 */
function relinkedProject(session, projectBuffer, mapping, options = {}) {
  const isXml = session.format === 'aepx';
  const { fallback = null } = options;
  const expected = (p) => (mapping.has(p) ? mapping.get(p) : (fallback && p && fallback(p)) || p);
  try {
    const { buffer, changed } = isXml ? rewriteAepxPaths(projectBuffer, mapping, options) : rewriteFootagePaths(projectBuffer, mapping, options);
    if (!changed && buffer === projectBuffer) return { buffer: projectBuffer, changed: 0, warning: null };
    const before = isXml ? parseAepx(projectBuffer) : parseAep(projectBuffer);
    const after = isXml ? parseAepx(buffer) : parseAep(buffer);
    const ok =
      after.footage.length === before.footage.length &&
      after.comps.length === before.comps.length &&
      after.footage.every((f, i) => f.id === before.footage[i].id && f.path === expected(before.footage[i].path));
    if (!ok) {
      return { buffer: projectBuffer, changed: 0, warning: 'The project could not be relinked safely, so the original project file was included unchanged.' };
    }
    return { buffer, changed, warning: null };
  } catch (err) {
    return { buffer: projectBuffer, changed: 0, warning: `The project could not be relinked (${err.message}); the original project file was included unchanged.` };
  }
}

class Throttle {
  constructor(fn, ms = 120) {
    this.fn = fn;
    this.ms = ms;
    this.last = 0;
  }
  call(payload, force = false) {
    const now = Date.now();
    if (force || now - this.last >= this.ms) {
      this.last = now;
      this.fn(payload);
    }
  }
}

function counter(onBytes) {
  return new Transform({
    transform(chunk, _enc, cb) {
      onBytes(chunk.length);
      cb(null, chunk);
    },
  });
}

function checkAbort(signal) {
  if (signal && signal.aborted) {
    const err = new Error('Cancelled');
    err.cancelled = true;
    throw err;
  }
}

/**
 * Copies (or moves) plan entries into `root`.
 * @param {'copy'|'move'} mode
 * @returns {Promise<{done: object[], failed: {entry, error}[]}>}
 */
async function copyToFolder(plan, root, { mode = 'copy', onProgress = () => {}, signal } = {}) {
  const throttle = new Throttle(onProgress);
  let bytes = 0;
  const done = [];
  const failed = [];
  for (let i = 0; i < plan.entries.length; i++) {
    checkAbort(signal);
    const entry = plan.entries[i];
    const target = path.join(root, ...entry.rel.split('/'));
    throttle.call({ phase: mode === 'move' ? 'Moving files' : 'Copying files', done: i, total: plan.entries.length, bytes, totalBytes: plan.totalBytes, current: entry.rel });
    try {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      if (pathKey(target) === pathKey(entry.src)) {
        done.push(entry);
        bytes += entry.size;
        continue;
      }
      if (await statSafe(target)) throw new Error('A file already exists at the destination');
      let moved = false;
      if (mode === 'move') {
        try {
          await fsp.rename(entry.src, target);
          moved = true;
          bytes += entry.size;
        } catch (err) {
          if (err.code !== 'EXDEV') throw err;
        }
      }
      if (!moved) {
        const tmp = `${target}.cargo-part`;
        try {
          await pipe(
            fs.createReadStream(entry.src, { highWaterMark: 4 * 1024 * 1024, signal }),
            counter((n) => {
              bytes += n;
              throttle.call({ phase: mode === 'move' ? 'Moving files' : 'Copying files', done: i, total: plan.entries.length, bytes, totalBytes: plan.totalBytes, current: entry.rel });
            }),
            fs.createWriteStream(tmp),
          );
          const [a, b] = await Promise.all([fsp.stat(entry.src), fsp.stat(tmp)]);
          if (a.size !== b.size) throw new Error('Copied file size does not match the original');
          await fsp.rename(tmp, target);
        } catch (err) {
          await fsp.rm(tmp, { force: true }).catch(() => {});
          throw err;
        }
        if (entry.mtime) {
          const t = new Date(entry.mtime);
          await fsp.utimes(target, t, t).catch(() => {});
        }
        if (mode === 'move') await fsp.unlink(entry.src);
      }
      done.push(entry);
    } catch (err) {
      if (signal && signal.aborted) checkAbort(signal);
      failed.push({ entry, error: err.message });
    }
  }
  throttle.call({ phase: 'Finishing', done: plan.entries.length, total: plan.entries.length, bytes, totalBytes: plan.totalBytes }, true);
  return { done, failed };
}

/**
 * Streams plan entries plus in-memory extras into a zip file.
 * @param {{rel: string, data: Buffer}[]} extras
 */
async function writeZip(plan, extras, zipPath, { onProgress = () => {}, signal } = {}) {
  const throttle = new Throttle(onProgress);
  const tmp = `${zipPath}.cargo-part`;
  const zip = new yazl.ZipFile();
  const out = fs.createWriteStream(tmp);
  let bytes = 0;
  let index = 0;
  let failure = null;
  const streams = new Set();

  const finished = new Promise((resolve, reject) => {
    out.on('close', resolve);
    out.on('error', reject);
    zip.outputStream.on('error', reject);
  });
  zip.outputStream.pipe(out);

  const abort = () => {
    for (const s of streams) s.destroy();
    zip.outputStream.unpipe(out);
    out.destroy();
  };
  if (signal) signal.addEventListener('abort', abort, { once: true });

  for (const entry of plan.entries) {
    const compress = media.COMPRESSIBLE.has(media.extOf(entry.src));
    const opts = { compress, mtime: entry.mtime ? new Date(entry.mtime) : new Date() };
    zip.addReadStreamLazy(entry.rel, opts, (cb) => {
      index++;
      const rs = fs.createReadStream(entry.src, { highWaterMark: 4 * 1024 * 1024 });
      const count = counter((n) => {
        bytes += n;
        throttle.call({ phase: 'Adding files to zip', done: index, total: plan.entries.length, bytes, totalBytes: plan.totalBytes, current: entry.rel });
      });
      streams.add(rs);
      rs.on('error', (err) => {
        failure = failure || new Error(`Could not read ${entry.src}: ${err.message}`);
        count.destroy(failure);
        abort();
      });
      rs.on('close', () => streams.delete(rs));
      cb(null, rs.pipe(count));
    });
  }
  for (const extra of extras) {
    zip.addBuffer(extra.data, extra.rel, { compress: true, mtime: new Date() });
  }
  zip.end();

  try {
    await finished;
    if (signal && signal.aborted) checkAbort(signal);
    if (failure) throw failure;
    await fsp.rename(tmp, zipPath);
  } catch (err) {
    abort();
    await fsp.rm(tmp, { force: true }).catch(() => {});
    if (signal && signal.aborted) checkAbort(signal);
    throw failure || err;
  } finally {
    if (signal) signal.removeEventListener('abort', abort);
  }
  throttle.call({ phase: 'Finishing', done: plan.entries.length, total: plan.entries.length, bytes, totalBytes: plan.totalBytes }, true);
  const st = await fsp.stat(zipPath);
  return { size: st.size };
}

module.exports = { LAYOUTS, planCollect, pathMapping, relinkedProject, copyToFolder, writeZip, folderFor };
