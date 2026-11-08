'use strict';

// Scans a project file: parses it, resolves every footage file on disk,
// detects image sequences, and works out what is used, unused and missing.

const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { parseAep } = require('./aep');
const { parseAepx } = require('./aepx');
const { parseFlp } = require('./flp');
const flenv = require('./flenv');
const { appFor, PROJECT_EXT } = require('./apps');
const media = require('./media');
const { matchSequence, parseFrameName } = require('./sequence');
const { pathKey, baseName, statSafe, pool, DirCache } = require('./fsutil');

const MAX_FOLDER_FILES = 20000;

function parseProjectBuffer(filePath, buf) {
  const ext = media.extOf(filePath);
  if (ext === 'flp' || buf.toString('latin1', 0, 4) === 'FLhd') return parseFlp(buf);
  if (ext === 'aepx' || buf.toString('utf8', 0, 64).trimStart().startsWith('<?xml')) {
    return parseAepx(buf);
  }
  return parseAep(buf);
}

async function listFolderRecursive(dir, limit) {
  const out = [];
  const stack = [dir];
  while (stack.length && out.length < limit) {
    const d = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) out.push(full);
    }
  }
  return out;
}

/**
 * @param {string} filePath project to scan
 * @param {object} [opts]
 * @param {Record<string,string>} [opts.relinks] stored path -> replacement path
 * @param {(p: {phase: string, done?: number, total?: number}) => void} [opts.onProgress]
 * @param {object} [opts.env] FL Studio folders (flenv.environment())
 */
async function scanProject(filePath, opts = {}) {
  const { relinks = {}, onProgress = () => {}, env = flenv.environment() } = opts;
  const started = Date.now();
  onProgress({ phase: 'Reading project' });
  const fileStat = await fsp.stat(filePath);
  const buf = await fsp.readFile(filePath);

  onProgress({ phase: 'Parsing project' });
  const parsed = parseProjectBuffer(filePath, buf);

  const folderById = new Map(parsed.folders.map((f) => [f.id, f]));
  const folderPath = (parentId) => {
    const names = [];
    let guard = 0;
    for (let id = parentId; id && folderById.has(id) && guard++ < 256; id = folderById.get(id).parentId) {
      names.unshift(folderById.get(id).name);
    }
    return names.join('/');
  };

  // Which comps reference each item through a layer source.
  const usedBy = new Map();
  for (const comp of parsed.comps) {
    for (const layer of comp.layers) {
      if (!layer.sourceId) continue;
      let set = usedBy.get(layer.sourceId);
      if (!set) usedBy.set(layer.sourceId, (set = new Set()));
      set.add(comp.id);
    }
  }
  const exprNames = new Set(parsed.expressionRefs.map((n) => n.toLowerCase()));
  const isFl = parsed.format === 'flp';
  const dir = path.dirname(filePath);
  const dataPath = isFl && parsed.dataPath ? flenv.expandPath(parsed.dataPath, env) : null;

  const assets = parsed.footage.map((f) => {
    const ext = f.path ? media.extOf(f.path) : '';
    const relinkedTo = f.path && relinks[f.path] ? relinks[f.path] : null;
    const resolved = relinkedTo || (isFl ? flenv.expandPath(f.path, env) : f.path);
    let category = f.kind === 'file' ? media.categoryOf(ext) : f.kind === 'solid' ? 'solid' : f.kind === 'placeholder' ? 'placeholder' : 'other';
    if (isFl && f.kind === 'file') category = flenv.classify(f.path, resolved, env, dataPath);
    const usedIn = [...(usedBy.get(f.id) || [])];
    const fileName = f.path ? path.basename(f.path.replace(/\\/g, '/')) : '';
    const usedByExpression = f.kind === 'file' && (exprNames.has(f.name.toLowerCase()) || exprNames.has(fileName.toLowerCase()));
    const used = parsed.usedIds ? parsed.usedIds.has(f.id) : usedIn.length > 0 || usedByExpression;
    return {
      id: f.id,
      name: f.name,
      kind: f.kind,
      category,
      ext,
      parentId: f.parentId,
      folderPath: f.group || folderPath(f.parentId),
      origin: f.origin || null,
      path: f.path,
      extraPaths: f.extraPaths,
      resolvedPath: resolved,
      relinked: !!relinkedTo,
      foundNearby: false,
      leftover: false,
      targetIsFolder: f.targetIsFolder,
      fileType: f.fileType,
      width: f.width,
      height: f.height,
      duration: f.duration,
      fps: f.fps,
      solidColor: f.solidColor,
      usedIn,
      usedByExpression,
      used,
      exists: false,
      size: 0,
      mtime: null,
      isSequence: false,
      isFolder: false,
      frames: null,
      frameCount: 0,
      sequencePattern: null,
      sequenceGaps: 0,
      status: 'unknown',
    };
  });

  // Resolve files on disk.
  const fileAssets = assets.filter((a) => a.kind === 'file' && a.resolvedPath);
  const dirs = new DirCache();
  let done = 0;
  onProgress({ phase: 'Checking files', done, total: fileAssets.length });
  await pool(fileAssets, 16, async (a) => {
    await resolveAsset(a, dirs);
    // FL Studio looks for missing samples next to the project (and in its
    // data folder) before giving up, so Cargo does too.
    if (isFl && !a.exists && !a.relinked) {
      const name = path.basename(String(a.resolvedPath).split("\\").join('/'));
      for (const near of [path.join(dir, name), dataPath && path.join(dataPath, name)].filter(Boolean)) {
        if (await statSafe(near)) {
          a.resolvedPath = near;
          a.foundNearby = true;
          await resolveAsset(a, dirs);
          break;
        }
      }
    }
    done++;
    if (done % 25 === 0 || done === fileAssets.length) {
      onProgress({ phase: 'Checking files', done, total: fileAssets.length });
    }
  });

  for (const a of assets) {
    if (a.kind === 'solid') a.status = 'generated';
    else if (a.kind === 'placeholder') a.status = 'placeholder';
    else if (a.kind !== 'file') a.status = 'unknown';
    else if (a.leftover) a.status = 'leftover';
    else if (a.exists) a.status = a.used ? 'used' : 'unused';
    else a.status = a.used ? 'missing' : 'unused-missing';
  }

  const comps = buildComps(parsed.comps, usedBy, folderPath);
  const app = appFor(parsed.format);
  const session = {
    id: crypto.randomUUID(),
    filePath,
    name: path.basename(filePath).replace(PROJECT_EXT, ''),
    dir,
    format: parsed.format,
    app: app.app,
    labels: app.labels,
    dataPath,
    leftoverInfo: null,
    fileSize: fileStat.size,
    mtime: fileStat.mtimeMs,
    creatorTool: parsed.creatorTool,
    folders: parsed.folders.map((f) => ({ ...f, path: folderPath(f.id) })),
    comps,
    effects: parsed.effects,
    assets,
    warnings: parsed.warnings,
    scannedAt: Date.now(),
    scanMs: 0,
  };
  session.totals = computeTotals(session);
  session.scanMs = Date.now() - started;
  return session;
}

async function resolveAsset(a, dirs) {
  const st = await statSafe(a.resolvedPath);
  if (!st) return;
  a.exists = true;
  a.mtime = st.mtimeMs;
  if (st.isDirectory()) {
    a.isFolder = true;
    const files = await listFolderRecursive(a.resolvedPath, MAX_FOLDER_FILES);
    const stats = await pool(files, 16, statSafe);
    a.frames = files.map((f, i) => ({ path: f, size: stats[i] ? stats[i].size : 0 }));
    a.frameCount = files.length;
    a.size = a.frames.reduce((s, f) => s + f.size, 0);
    return;
  }
  a.size = st.size;
  if ((a.ext === 'wav' || a.ext === 'wave') && !a.duration) a.duration = await wavDuration(a.resolvedPath);

  // Numbered stills with a duration are image sequences. When the source
  // spec was unreadable, fall back to looking for enough numbered siblings.
  const specKnown = a.width !== null || a.fileType !== null;
  const canSequence = media.SEQUENCE_EXTS.has(a.ext) && parseFrameName(path.basename(a.resolvedPath));
  if (!canSequence) return;
  if (specKnown && !a.duration) return;
  const names = await dirs.list(path.dirname(a.resolvedPath));
  const seq = matchSequence(a.resolvedPath, names);
  if (!seq || (!specKnown && seq.frames.length < 3)) return;
  const stats = await pool(seq.frames, 16, statSafe);
  a.isSequence = true;
  a.category = 'sequence';
  a.frames = seq.frames.map((f, i) => ({ path: f, size: stats[i] ? stats[i].size : 0 }));
  a.frameCount = seq.frames.length;
  a.sequencePattern = seq.pattern;
  // File footage has no stored name; show sequences the way AE does.
  if (a.name === baseName(a.path) || a.name === baseName(a.resolvedPath)) a.name = seq.displayName;
  a.sequenceGaps = seq.gaps;
  a.size = a.frames.reduce((s, f) => s + f.size, 0);
  for (const s of stats) if (s && s.mtimeMs > a.mtime) a.mtime = s.mtimeMs;
}

/** Length of a WAV file from its header, or null. */
async function wavDuration(file) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const head = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fh.read(head, 0, head.length, 0);
    const b = head.subarray(0, bytesRead);
    if (b.length < 12 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WAVE') return null;
    let byteRate = 0;
    let off = 12;
    while (off + 8 <= b.length) {
      const id = b.toString('latin1', off, off + 4);
      const size = b.readUInt32LE(off + 4);
      if (id === 'fmt ' && off + 20 <= b.length) byteRate = b.readUInt32LE(off + 16);
      if (id === 'data') {
        const st = await fh.stat();
        const dataSize = Math.min(size, st.size - off - 8);
        return byteRate ? Math.round((dataSize / byteRate) * 1000) / 1000 : null;
      }
      off += 8 + size + (size & 1);
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

function buildComps(rawComps, usedBy, folderPath) {
  return rawComps.map((c) => {
    const counts = new Map();
    for (const l of c.layers) {
      if (l.sourceId) counts.set(l.sourceId, (counts.get(l.sourceId) || 0) + 1);
    }
    return {
      id: c.id,
      name: c.name,
      kind: c.kind || 'comp',
      parentId: c.parentId,
      folderPath: folderPath(c.parentId),
      width: c.width,
      height: c.height,
      fps: c.fps,
      duration: c.duration,
      layerCount: c.layers.length,
      layers: c.layers.map((l) => ({ index: l.index, name: l.name, sourceId: l.sourceId, effects: l.effects, count: l.notes || l.clips || null })),
      sources: [...counts].map(([id, count]) => ({ id, count })),
      usedIn: [...(usedBy.get(c.id) || [])],
      effectCount: c.effects.length,
    };
  });
}

/** Every file on disk an asset stands for (all frames for sequences). */
function assetFiles(a) {
  if (!a.exists) return [];
  if (a.frames) return a.frames;
  return [{ path: a.resolvedPath, size: a.size }];
}

function computeTotals(session) {
  const usedFiles = new Map();
  const allFiles = new Map();
  for (const a of session.assets) {
    for (const f of assetFiles(a)) {
      const key = pathKey(f.path);
      allFiles.set(key, f.size);
      if (a.used) usedFiles.set(key, f.size);
    }
  }
  let unusedSize = 0;
  let unusedFiles = 0;
  for (const [key, size] of allFiles) {
    if (!usedFiles.has(key)) {
      unusedSize += size;
      unusedFiles++;
    }
  }
  const sum = (m) => [...m.values()].reduce((s, v) => s + v, 0);
  const byCategory = {};
  const byStatus = {};
  for (const a of session.assets) {
    const c = (byCategory[a.category] ||= { count: 0, size: 0, used: 0 });
    c.count++;
    c.size += a.size;
    if (a.used) c.used++;
    byStatus[a.status] = (byStatus[a.status] || 0) + 1;
  }
  const files = session.assets.filter((a) => a.kind === 'file' && !a.leftover);
  const leftovers = session.assets.filter((a) => a.leftover);
  return {
    assetCount: session.assets.length,
    fileAssetCount: files.length,
    compCount: session.comps.length,
    folderCount: session.folders.length,
    totalSize: sum(allFiles),
    usedSize: sum(usedFiles),
    unusedSize,
    fileCount: allFiles.size,
    unusedFileCount: unusedFiles,
    usedCount: files.filter((a) => a.used).length,
    unusedCount: files.filter((a) => !a.used).length,
    missingCount: byStatus.missing || 0,
    unusedMissingCount: byStatus['unused-missing'] || 0,
    solidCount: byStatus.generated || 0,
    placeholderCount: byStatus.placeholder || 0,
    leftoverCount: leftovers.length,
    leftoverSize: leftovers.reduce((t, a) => t + a.size, 0),
    byCategory,
    byStatus,
    thirdPartyEffects: session.effects.filter((e) => !e.builtIn).length,
  };
}

/** Plain-data view of a session for the renderer (no frame lists). */
function toClient(session) {
  return {
    id: session.id,
    filePath: session.filePath,
    name: session.name,
    dir: session.dir,
    format: session.format,
    app: session.app,
    labels: session.labels,
    dataPath: session.dataPath,
    leftoverInfo: session.leftoverInfo,
    fileSize: session.fileSize,
    mtime: session.mtime,
    creatorTool: session.creatorTool,
    folders: session.folders,
    comps: session.comps,
    effects: session.effects,
    assets: session.assets.map(({ frames, ...rest }) => ({ ...rest, key: rest.resolvedPath ? pathKey(rest.resolvedPath) : null })),
    warnings: session.warnings,
    totals: session.totals,
    scannedAt: session.scannedAt,
    scanMs: session.scanMs,
  };
}

/**
 * Replaces the leftover files of a session with a new search result
 * (from leftovers.findLeftovers) and updates the totals.
 */
function applyLeftovers(session, result, env = flenv.environment()) {
  session.assets = session.assets.filter((a) => !a.leftover);
  result.leftovers.forEach((l, i) => {
    const ext = media.extOf(l.path);
    session.assets.push({
      id: 300000 + i,
      name: path.basename(l.path),
      kind: 'file',
      category: session.format === 'flp' ? flenv.classify(l.path, l.path, env, session.dataPath) : media.categoryOf(ext),
      ext,
      parentId: 0,
      folderPath: l.folder,
      origin: 'leftover',
      path: l.path,
      extraPaths: [],
      resolvedPath: l.path,
      relinked: false,
      foundNearby: false,
      leftover: true,
      targetIsFolder: false,
      fileType: null,
      width: null,
      height: null,
      duration: l.duration || null,
      fps: null,
      solidColor: null,
      usedIn: [],
      usedByExpression: false,
      used: false,
      exists: true,
      size: l.size,
      mtime: l.mtime,
      isSequence: false,
      isFolder: false,
      frames: null,
      frameCount: 0,
      sequencePattern: null,
      sequenceGaps: 0,
      status: 'leftover',
    });
  });
  // Files the other projects use, so cleanup never offers them.
  Object.defineProperty(session, 'externalRefs', { value: result.others || new Map(), enumerable: false, configurable: true, writable: true });
  session.leftoverInfo = {
    count: result.leftovers.length,
    size: result.leftovers.reduce((t, l) => t + l.size, 0),
    folders: result.folders,
    projectsChecked: result.projectsChecked,
    keptForOthers: result.keptForOthers,
    complete: result.complete,
    at: Date.now(),
  };
  session.totals = computeTotals(session);
}

module.exports = { scanProject, parseProjectBuffer, computeTotals, assetFiles, toClient, applyLeftovers, wavDuration };
