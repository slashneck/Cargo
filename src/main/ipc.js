'use strict';

// IPC surface between the window and the file system. Every long operation
// runs as a "job" that reports progress and can be cancelled. Handlers
// return {ok, value} or {ok: false, error} so the window gets readable
// messages instead of Electron's wrapped errors.

const { ipcMain, dialog, shell, BrowserWindow, app } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const { scanProject, toClient, assetFiles } = require('../core/analyze');
const collect = require('../core/collect');
const report = require('../core/report');
const { relinkScript } = require('../core/relinkScript');
const { planDeleteUnused, trashFiles } = require('../core/cleanup');
const { findMissing } = require('../core/relink');
const { findDuplicates } = require('../core/duplicates');
const { pathKey, safeName, dateStamp, uniquePath, statSafe } = require('../core/fsutil');
const { thumbnail } = require('./media');
const privacy = require('../core/privacy');
const updater = require('./updater');

const BLOCKED_OPEN = new Set(['exe', 'bat', 'cmd', 'com', 'msi', 'ps1', 'vbs', 'vbe', 'js', 'jse', 'jsx', 'jsxbin', 'wsf', 'scr', 'lnk', 'reg', 'hta', 'cpl', 'app', 'sh', 'command', 'pkg', 'dmg']);

// Auto-save folders and files as After Effects names them in its languages,
// e.g. "Adobe After Effects Auto-Save" and "Spot auto-save 3.aep".
const AUTO_SAVE = /auto[-\s_]?save|automatisch|autom[aá]tico|salvataggio automatico|enregistrement auto|sauvegarde auto|автосохран|自動保存|자동 저장|自动保存/i;

class UserError extends Error {}

function friendlyError(err, filePath) {
  if (err && err.cancelled) return 'Cancelled';
  if (err instanceof UserError || (err && err.name === 'AepFormatError')) return err.message;
  const name = filePath ? `"${path.basename(filePath)}"` : 'the file';
  switch (err && err.code) {
    case 'ENOENT':
      return `Cargo could not find ${name}. It may have been moved or deleted.`;
    case 'EACCES':
    case 'EPERM':
      return `Cargo does not have permission to access ${name}.`;
    case 'EBUSY':
      return `${name} is in use by another program.`;
    case 'ENOSPC':
      return 'The destination drive is full.';
    default:
      return (err && err.message) || String(err);
  }
}

function register({ store }) {
  const sessions = new Map();
  const jobs = new Map();
  let allowed = new Set();

  const rebuildAllowed = () => {
    const keys = new Set();
    for (const s of sessions.values()) {
      for (const a of s.assets) {
        if (a.resolvedPath) keys.add(pathKey(a.resolvedPath));
        if (a.frames) for (const f of a.frames) keys.add(pathKey(f.path));
      }
    }
    allowed = keys;
  };

  const getSession = (id) => {
    const s = sessions.get(id);
    if (!s) throw new UserError('This project is no longer open. Please open it again.');
    return s;
  };

  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        return { ok: true, value: await fn(event, ...args) };
      } catch (err) {
        if (!(err instanceof UserError) && !(err && err.cancelled)) console.error(`[${channel}]`, err);
        return { ok: false, error: friendlyError(err), cancelled: !!(err && err.cancelled) };
      }
    });
  };

  const runJob = async (event, jobId, fn) => {
    const controller = new AbortController();
    if (jobId) jobs.set(jobId, controller);
    const progress = (p) => {
      if (jobId && !event.sender.isDestroyed()) event.sender.send('job:progress', { jobId, ...p });
    };
    try {
      return await fn({ signal: controller.signal, progress });
    } finally {
      if (jobId) jobs.delete(jobId);
    }
  };

  const client = (s) => {
    const dto = toClient(s);
    dto.relinkCount = dto.assets.filter((a) => a.relinked).length;
    return dto;
  };

  const scan = async (filePath, progress, keepId) => {
    try {
      const s = await scanProject(filePath, { relinks: store.relinksFor(filePath), onProgress: progress });
      if (keepId) {
        s.id = keepId;
        sessions.delete(keepId);
      }
      sessions.set(s.id, s);
      rebuildAllowed();
      store.addRecent(s);
      return s;
    } catch (err) {
      throw new UserError(friendlyError(err, filePath));
    }
  };

  // Files other open projects rely on, so cleanup never breaks them.
  const otherProjectsUse = (session) => {
    const reasons = new Map();
    for (const other of sessions.values()) {
      if (other.id === session.id || pathKey(other.filePath) === pathKey(session.filePath)) continue;
      for (const a of other.assets) {
        if (!a.used) continue;
        for (const f of assetFiles(a)) reasons.set(pathKey(f.path), `Used by "${other.name}"`);
      }
    }
    return reasons;
  };

  const protection = (session) => {
    const reasons = new Map([...store.protectedKeys(), ...otherProjectsUse(session)]);
    return { protectedKeys: new Set(reasons.keys()), protectedReasons: reasons };
  };

  const ensureUnchanged = async (session) => {
    const st = await statSafe(session.filePath);
    if (!st) throw new UserError('The project file is no longer where it was scanned. Open it again.');
    if (Math.abs(st.mtimeMs - session.mtime) > 1 || st.size !== session.fileSize) {
      throw new UserError('The project was saved after it was scanned. Rescan it (Ctrl+R) and try again.');
    }
  };

  // ---- dialogs --------------------------------------------------------------

  handle('dialog:openProjects', async (event, { multi = false } = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const r = await dialog.showOpenDialog(win, {
      title: multi ? 'Choose After Effects projects' : 'Open After Effects project',
      properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: [{ name: 'After Effects Projects', extensions: ['aep', 'aepx'] }],
    });
    return r.canceled ? [] : r.filePaths;
  });

  handle('dialog:openFolder', async (event, { title, defaultPath } = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const r = await dialog.showOpenDialog(win, { title: title || 'Choose a folder', defaultPath, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  handle('dialog:locateFile', async (event, { title, defaultPath, ext } = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const r = await dialog.showOpenDialog(win, {
      title: title || 'Locate file',
      defaultPath,
      properties: ['openFile'],
      filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }, { name: 'All files', extensions: ['*'] }] : [],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  // ---- projects -------------------------------------------------------------

  handle('project:scan', async (event, filePath, jobId) => {
    return runJob(event, jobId, async ({ progress }) => client(await scan(filePath, progress)));
  });

  handle('project:rescan', async (event, id, jobId) => {
    const s = getSession(id);
    return runJob(event, jobId, async ({ progress }) => client(await scan(s.filePath, progress, id)));
  });

  handle('project:close', async (_e, id) => {
    sessions.delete(id);
    rebuildAllowed();
    return true;
  });

  handle('project:thumbnail', async (_e, id, assetId) => {
    const s = sessions.get(id);
    const a = s && s.assets.find((x) => x.id === assetId);
    if (!a || !a.exists) return null;
    const file = a.frames && a.frames.length ? a.frames[0].path : a.resolvedPath;
    return thumbnail(file, a.mtime);
  });

  // ---- missing files --------------------------------------------------------

  handle('project:findMissing', async (event, id, { roots = [], deep = true } = {}, jobId) => {
    const s = getSession(id);
    const missing = s.assets.filter((a) => a.kind === 'file' && !a.exists && a.path).map((a) => ({ id: a.id, path: a.resolvedPath || a.path }));
    const searchRoots = [...new Set([s.dir, path.dirname(s.dir), ...roots, ...store.data.settings.searchRoots].filter(Boolean))];
    return runJob(event, jobId, ({ signal, progress }) => findMissing(missing, { roots: searchRoots, deep, onProgress: progress, signal }));
  });

  handle('project:relink', async (event, id, links, jobId) => {
    const s = getSession(id);
    const map = {};
    for (const { assetId, path: target } of links) {
      const a = s.assets.find((x) => x.id === assetId);
      if (!a || !a.path) continue;
      map[a.path] = target || null;
    }
    store.setRelinks(s.filePath, map);
    return runJob(event, jobId, async ({ progress }) => client(await scan(s.filePath, progress, id)));
  });

  handle('project:saveRelinked', async (event, id) => {
    const s = getSession(id);
    await ensureUnchanged(s);
    const mapping = new Map(s.assets.filter((a) => a.relinked && a.exists).map((a) => [a.path, a.resolvedPath]));
    if (!mapping.size) throw new UserError('There are no relinked files to save.');
    const buf = await fsp.readFile(s.filePath);
    const ext = path.extname(s.filePath);
    const result = collect.relinkedProject(s, buf, mapping);
    if (result.warning) throw new UserError(result.warning);
    const target = await uniquePath(path.join(s.dir, `${s.name}_relinked${ext}`));
    await fsp.writeFile(target, result.buffer);
    return { path: target, changed: result.changed };
  });

  // ---- package / archive / organize -----------------------------------------

  const RELINK_HELP = 'run "Relink Footage.jsx" in After Effects (File > Scripts > Run Script File…)';

  const packageNotes = (session, plan, relinked, { zip, privateMode, neutral }) => {
    const notes = [];
    if (privateMode) {
      notes.push(`Footage paths in the project point to ${neutral}. Extract the package to ${path.dirname(neutral)} and After Effects finds every file, or open the project from anywhere and ${RELINK_HELP}.`);
    } else if (relinked.changed) {
      notes.push(
        zip
          ? `Footage paths in the project point to this package as if it were extracted next to the zip file. If After Effects reports missing footage after extracting somewhere else, ${RELINK_HELP}.`
          : `Footage paths in the project point to the files in this folder. If you move the folder and After Effects reports missing footage, ${RELINK_HELP}.`,
      );
    }
    if (relinked.warning) notes.push(relinked.warning);
    const unused = plan.skipped.filter((k) => k.reason === 'unused');
    if (unused.length) notes.push(`${unused.length} unused item(s) were not included. In After Effects, File > Dependencies > Remove Unused Footage removes them from the project.`);
    const missing = plan.skipped.filter((k) => k.reason === 'missing');
    if (missing.length) notes.push(`${missing.length} file(s) were missing and could not be included.`);
    const thirdParty = session.effects.filter((e) => !e.builtIn && e.count > 0);
    if (thirdParty.length) notes.push(`Third-party effects are used and must be installed to open this project as intended: ${thirdParty.map((e) => e.displayName).join(', ')}.`);
    notes.push('Fonts are not included. Install the fonts used in text layers before opening the project.');
    return notes;
  };

  const extrasFor = (session, plan, mapping, relinked, projectBuf, notes, opts) => {
    const projectFileName = path.basename(session.filePath);
    const data = report.reportData(session, { plan, title: opts.title || 'Package Manifest', notes, privateMode: !!opts.privateMode });
    const scriptEntries = [];
    for (const a of session.assets) {
      const rel = plan.assetTargets.get(a.id);
      if (!rel || !a.path) continue;
      const to = mapping.get(a.path);
      scriptEntries.push({ from: opts.privateMode ? to : a.path, to, rel, sequence: a.isSequence });
    }
    const extras = [
      { rel: projectFileName, data: relinked.buffer },
      { rel: 'MANIFEST.txt', data: Buffer.from(report.toText(data), 'utf8') },
      { rel: 'manifest.json', data: Buffer.from(report.toJson(data), 'utf8') },
      { rel: 'Relink Footage.jsx', data: Buffer.from(relinkScript(session.name, scriptEntries), 'utf8') },
    ];
    if (opts.includeOriginal && relinked.changed && !opts.privateMode) extras.push({ rel: `Original Project/${projectFileName}`, data: projectBuf });
    return extras;
  };

  const writeExtras = async (root, extras) => {
    for (const e of extras) {
      const target = path.join(root, ...e.rel.split('/'));
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, e.data);
    }
  };

  /**
   * Private packages point every path inside the project to a neutral folder
   * named after the package, drop the XMP save history, and keep locations,
   * dates and the After Effects version out of the manifest.
   */
  const privateProject = (session, plan, projectBuf, packageName) => {
    const neutral = privacy.neutralRoot(packageName);
    const mapping = collect.pathMapping(session, plan, neutral);
    const fallback = (p) => privacy.neutralPath(neutral, `Not included/${privacy.lastSegment(p) || 'file'}`);
    const relinked = collect.relinkedProject(session, projectBuf, mapping, {
      fallback,
      scrubText: privacy.scrubPaths,
      xmp: session.format === 'aepx' ? null : privacy.neutralXmp(),
    });
    if (relinked.warning) {
      throw new UserError('Cargo could not make a private copy of this project safely, so no package was created. Turn off “Private package” to package it unchanged.');
    }
    return { neutral, mapping, relinked };
  };

  const leakWarnings = (extras) => {
    const warnings = [];
    for (const e of extras) {
      const leaks = privacy.findLeaks(e.data);
      if (!leaks.length) continue;
      const n = leaks.reduce((t, l) => t + l.count, 0);
      warnings.push(`Your user or computer name still appears ${n} time(s) in ${e.rel}, for example in a layer, comp or folder name. Cargo leaves project content as it is; rename it in After Effects if it matters.`);
    }
    return warnings;
  };

  const packageProject = async (session, opts, { signal, progress }) => {
    const { format = 'zip', destDir, includeUnused = false, layout = 'type', relink = true, includeOriginal = false } = opts;
    const privateMode = opts.privateMode !== false;
    if (!destDir) throw new UserError('Choose where to save the package.');
    await ensureUnchanged(session);
    const baseName = safeName(opts.name || `${session.name}_Package_${dateStamp()}`);
    const onlyAssetIds = Array.isArray(opts.assetIds) ? new Set(opts.assetIds) : null;
    const plan = collect.planCollect(session, { includeUnused, layout, prefix: 'Footage', onlyAssetIds });
    let root;
    let zipPath = null;
    if (format === 'zip') {
      zipPath = await uniquePath(path.join(destDir, `${baseName}.zip`));
      root = path.join(destDir, path.basename(zipPath, '.zip'));
    } else {
      root = await uniquePath(path.join(destDir, baseName));
    }
    progress({ phase: 'Preparing project' });
    const projectBuf = await fsp.readFile(session.filePath);
    let mapping;
    let relinked;
    let neutral = null;
    if (privateMode) {
      ({ neutral, mapping, relinked } = privateProject(session, plan, projectBuf, path.basename(root)));
    } else {
      mapping = collect.pathMapping(session, plan, root);
      relinked = relink ? collect.relinkedProject(session, projectBuf, mapping) : { buffer: projectBuf, changed: 0, warning: null };
    }
    const notes = packageNotes(session, plan, relinked, { zip: format === 'zip', privateMode, neutral });
    const extras = extrasFor(session, plan, mapping, relinked, projectBuf, notes, { includeOriginal, privateMode });
    const warnings = relinked.warning ? [relinked.warning] : [];
    if (privateMode) warnings.push(...leakWarnings(extras));
    let output;
    let failed = [];
    if (format === 'zip') {
      await collect.writeZip(plan, extras, zipPath, { onProgress: progress, signal });
      output = zipPath;
    } else {
      await fsp.mkdir(root, { recursive: true });
      try {
        ({ failed } = await collect.copyToFolder(plan, root, { onProgress: progress, signal }));
      } catch (err) {
        if (err.cancelled) await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
        throw err;
      }
      await writeExtras(root, extras);
      output = root;
    }
    const st = await statSafe(output);
    const result = {
      output,
      files: plan.entries.length - failed.length,
      bytes: format === 'zip' && st ? st.size : plan.totalBytes,
      skipped: plan.skipped,
      failed: failed.map((f) => ({ path: f.entry.src, error: f.error })),
      warnings,
      relinked: relinked.changed,
      privateMode,
      neutral,
    };
    store.addHistory({ kind: format === 'zip' ? 'zip' : 'folder', project: session.name, projectPath: session.filePath, output, files: result.files, bytes: result.bytes });
    return result;
  };

  handle('project:packagePreview', async (_e, id, opts) => {
    const s = getSession(id);
    const onlyAssetIds = Array.isArray(opts.assetIds) ? new Set(opts.assetIds) : null;
    const plan = collect.planCollect(s, { includeUnused: !!opts.includeUnused, layout: opts.layout || 'type', prefix: 'Footage', onlyAssetIds });
    return {
      files: plan.entries.length,
      bytes: plan.totalBytes,
      missing: plan.skipped.filter((k) => k.reason === 'missing').length,
      unused: plan.skipped.filter((k) => k.reason === 'unused').length,
      unusedBytes: plan.skipped.filter((k) => k.reason === 'unused').reduce((t, k) => t + k.size, 0),
      sample: plan.entries.slice(0, 400).map((e) => e.rel),
    };
  });

  handle('project:package', async (event, id, opts, jobId) => {
    const s = getSession(id);
    return runJob(event, jobId, (ctx) => packageProject(s, opts, ctx));
  });

  handle('project:archive', async (event, id, opts, jobId) => {
    const s = getSession(id);
    const { destDir, includeUnused = true, layout = 'type', removeOriginals = false } = opts;
    if (!destDir) throw new UserError('Choose an archive location.');
    await ensureUnchanged(s);
    return runJob(event, jobId, async ({ signal, progress }) => {
      const root = await uniquePath(path.join(destDir, safeName(s.name)));
      const plan = collect.planCollect(s, { includeUnused, layout, prefix: 'Footage' });
      await fsp.mkdir(root, { recursive: true });
      let copied;
      try {
        copied = await collect.copyToFolder(plan, root, { onProgress: progress, signal });
      } catch (err) {
        if (err.cancelled) await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
        throw err;
      }
      const projectBuf = await fsp.readFile(s.filePath);
      const mapping = collect.pathMapping(s, plan, root);
      const relinked = collect.relinkedProject(s, projectBuf, mapping);
      const notes = packageNotes(s, plan, relinked, { zip: false });
      await writeExtras(root, extrasFor(s, plan, mapping, relinked, projectBuf, notes, { title: 'Archive Manifest' }));
      const newProject = path.join(root, path.basename(s.filePath));

      const result = {
        output: root,
        project: newProject,
        files: copied.done.length,
        bytes: plan.totalBytes,
        failed: copied.failed.map((f) => ({ path: f.entry.src, error: f.error })),
        removed: 0,
        kept: [],
        warnings: relinked.warning ? [relinked.warning] : [],
      };

      if (removeOriginals) {
        if (copied.failed.length) {
          result.warnings.push('Some files could not be copied, so no originals were removed.');
        } else {
          const { protectedKeys, protectedReasons } = protection(s);
          const toTrash = [];
          for (const e of copied.done) {
            const key = pathKey(e.src);
            if (protectedKeys.has(key)) result.kept.push({ path: e.src, reason: protectedReasons.get(key) });
            else toTrash.push(e.src);
          }
          toTrash.push(s.filePath);
          const { trashed, failed } = await trashFiles(toTrash, (p) => shell.trashItem(p), { onProgress: progress, signal });
          result.removed = trashed.length;
          for (const f of failed) result.failed.push(f);
        }
      }
      store.addHistory({ kind: 'archive', project: s.name, projectPath: s.filePath, output: root, files: result.files, bytes: result.bytes });
      return result;
    });
  });

  handle('project:organize', async (event, id, opts, jobId) => {
    const s = getSession(id);
    const { destDir, layout = 'type', mode = 'copy', includeUnused = true } = opts;
    if (!destDir) throw new UserError('Choose a destination folder.');
    await ensureUnchanged(s);
    return runJob(event, jobId, async ({ signal, progress }) => {
      const plan = collect.planCollect(s, { includeUnused, layout, prefix: '' });
      // Skip files that already sit where they would go.
      await fsp.mkdir(destDir, { recursive: true });
      const { done, failed } = await collect.copyToFolder(plan, destDir, { mode, onProgress: progress, signal });
      const okSources = new Set(done.map((e) => pathKey(e.src)));
      const mapping = new Map();
      for (const a of s.assets) {
        const rel = plan.assetTargets.get(a.id);
        if (!rel || !a.path) continue;
        if (!assetFiles(a).every((f) => okSources.has(pathKey(f.path)))) continue;
        mapping.set(a.path, path.join(destDir, ...rel.split('/')));
      }
      const projectBuf = await fsp.readFile(s.filePath);
      const relinked = collect.relinkedProject(s, projectBuf, mapping);
      const ext = path.extname(s.filePath);
      const newProject = await uniquePath(path.join(s.dir, `${s.name}_organized${ext}`));
      await fsp.writeFile(newProject, relinked.buffer);
      const manifest = report.toText(report.reportData(s, { plan, title: 'Organize Report', notes: [`Relinked project: ${newProject}`] }));
      await fsp.writeFile(path.join(destDir, `${safeName(s.name)} - Organize Report.txt`), manifest);
      store.addHistory({ kind: mode === 'move' ? 'organize-move' : 'organize', project: s.name, projectPath: s.filePath, output: destDir, files: done.length, bytes: plan.totalBytes });
      return {
        output: destDir,
        project: newProject,
        files: done.length,
        failed: failed.map((f) => ({ path: f.entry.src, error: f.error })),
        warnings: relinked.warning ? [relinked.warning] : [],
      };
    });
  });

  // ---- cleanup ---------------------------------------------------------------

  handle('project:deletePlan', async (_e, id) => {
    const s = getSession(id);
    return planDeleteUnused(s, protection(s));
  });

  handle('project:trash', async (event, id, files, jobId) => {
    const s = getSession(id);
    // Only files that the delete plan (or an unused duplicate) allows.
    const plan = planDeleteUnused(s, protection(s));
    const allowedKeys = new Set(plan.groups.flatMap((g) => g.files.map(pathKey)));
    const rejected = files.filter((f) => !allowedKeys.has(pathKey(f)));
    if (rejected.length) throw new UserError(`${rejected.length} file(s) are still needed and were not deleted.`);
    return runJob(event, jobId, async ({ signal, progress }) => {
      const sizes = new Map();
      for (const a of s.assets) for (const f of assetFiles(a)) sizes.set(pathKey(f.path), f.size);
      const result = await trashFiles(files, (p) => shell.trashItem(p), { onProgress: progress, signal });
      const freed = result.trashed.reduce((t, f) => t + (sizes.get(pathKey(f)) || 0), 0);
      store.addHistory({ kind: 'cleanup', project: s.name, projectPath: s.filePath, output: 'Recycle Bin', files: result.trashed.length, bytes: freed });
      const updated = client(await scan(s.filePath, progress, id));
      return { ...result, freed, project: updated };
    });
  });

  // Deleting chosen items (or all media). Unlike Delete Unused this may remove
  // files the project uses, so every file comes with the reasons to keep it.
  handle('project:deleteAssetsPlan', async (_e, id, assetIds) => {
    const s = getSession(id);
    const chosen = assetIds ? new Set(assetIds) : null;
    const { protectedReasons } = protection(s);
    const compNames = new Map(s.comps.map((c) => [c.id, c.name]));
    const owners = new Map(); // file key -> items using it
    for (const b of s.assets) {
      for (const g of assetFiles(b)) {
        const key = pathKey(g.path);
        if (!owners.has(key)) owners.set(key, []);
        owners.get(key).push(b);
      }
    }
    const groups = [];
    const claimed = new Set();
    for (const a of s.assets) {
      if (a.kind !== 'file' || !a.exists || (chosen && !chosen.has(a.id))) continue;
      const files = [];
      let size = 0;
      const reasons = new Set();
      for (const f of assetFiles(a)) {
        const key = pathKey(f.path);
        if (claimed.has(key) || key === pathKey(s.filePath)) continue;
        claimed.add(key);
        files.push(f.path);
        size += f.size;
        if (protectedReasons.has(key)) reasons.add(protectedReasons.get(key));
        const other = chosen && (owners.get(key) || []).find((b) => b.id !== a.id && !chosen.has(b.id));
        if (other) reasons.add(`Also used by “${other.name}” in this project`);
      }
      if (!files.length) continue;
      groups.push({
        id: a.id,
        name: a.name,
        category: a.category,
        files,
        size,
        folder: path.dirname(files[0]),
        used: a.used,
        usedIn: a.usedIn.slice(0, 3).map((c) => compNames.get(c) || `#${c}`),
        usedInCount: a.usedIn.length,
        reasons: [...reasons],
      });
    }
    groups.sort((x, y) => y.size - x.size);
    return { groups, projectFile: s.filePath, projectSize: s.fileSize };
  });

  handle('project:trashAssets', async (event, id, files, { includeProject = false } = {}, jobId) => {
    const s = getSession(id);
    const allowedKeys = new Set();
    const sizes = new Map();
    for (const a of s.assets) {
      for (const f of assetFiles(a)) {
        allowedKeys.add(pathKey(f.path));
        sizes.set(pathKey(f.path), f.size);
      }
    }
    allowedKeys.delete(pathKey(s.filePath));
    const rejected = files.filter((f) => !allowedKeys.has(pathKey(f)));
    if (rejected.length) throw new UserError(`${rejected.length} file(s) don't belong to this project and were not deleted.`);
    const list = includeProject ? [...files, s.filePath] : files;
    return runJob(event, jobId, async ({ signal, progress }) => {
      const result = await trashFiles(list, (p) => shell.trashItem(p), { onProgress: progress, signal });
      const freed = result.trashed.reduce((t, f) => t + (sizes.get(pathKey(f)) || (pathKey(f) === pathKey(s.filePath) ? s.fileSize : 0)), 0);
      store.addHistory({ kind: 'cleanup', project: s.name, projectPath: s.filePath, output: 'Recycle Bin', files: result.trashed.length, bytes: freed });
      const projectGone = includeProject && result.trashed.some((f) => pathKey(f) === pathKey(s.filePath));
      if (projectGone) {
        sessions.delete(id);
        rebuildAllowed();
        store.removeRecent(s.filePath);
        return { ...result, freed, project: null };
      }
      return { ...result, freed, project: client(await scan(s.filePath, progress, id)) };
    });
  });

  handle('project:duplicates', async (event, id, jobId) => {
    const s = getSession(id);
    return runJob(event, jobId, (ctx) => findDuplicates(s, { onProgress: ctx.progress, signal: ctx.signal }));
  });

  // ---- reports ---------------------------------------------------------------

  const renderPdf = async (html) => {
    const tmp = path.join(os.tmpdir(), `cargo-report-${process.pid}-${Date.now()}.html`);
    await fsp.writeFile(tmp, html);
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
    try {
      await win.loadFile(tmp);
      return await win.webContents.printToPDF({ pageSize: 'A4', printBackground: true });
    } finally {
      win.destroy();
      fsp.rm(tmp, { force: true }).catch(() => {});
    }
  };

  const saveReport = async (event, defaultName, format, render) => {
    const filters = {
      txt: { name: 'Text', extensions: ['txt'] },
      csv: { name: 'CSV (Excel, Numbers, Sheets)', extensions: ['csv'] },
      json: { name: 'JSON', extensions: ['json'] },
      pdf: { name: 'PDF', extensions: ['pdf'] },
      html: { name: 'Web page', extensions: ['html'] },
    };
    if (!filters[format]) throw new UserError('Unknown export format.');
    const win = BrowserWindow.fromWebContents(event.sender);
    const r = await dialog.showSaveDialog(win, {
      title: 'Export',
      defaultPath: path.join(app.getPath('documents'), `${safeName(defaultName)}.${format}`),
      filters: [filters[format]],
    });
    if (r.canceled || !r.filePath) return null;
    const content = await render(format);
    await fsp.writeFile(r.filePath, content);
    return r.filePath;
  };

  handle('project:export', async (event, id, format) => {
    const s = getSession(id);
    const data = report.reportData(s);
    return saveReport(event, `${s.name}_Manifest`, format, async (fmt) => {
      if (fmt === 'txt') return report.toText(data);
      if (fmt === 'csv') return report.toCsv(data);
      if (fmt === 'json') return report.toJson(data);
      if (fmt === 'html') return report.toHtml(data);
      return renderPdf(report.toHtml(data));
    });
  });

  // ---- batch -----------------------------------------------------------------

  handle('batch:findProjects', async (event, dir, { skipAutoSave = true } = {}, jobId) => {
    return runJob(event, jobId, async ({ signal, progress }) => {
      const found = [];
      const stack = [{ d: dir, depth: 0 }];
      let visited = 0;
      let skipped = 0;
      while (stack.length && found.length < 2000) {
        if (signal.aborted) break;
        const { d, depth } = stack.pop();
        let entries;
        try {
          entries = await fsp.readdir(d, { withFileTypes: true });
        } catch {
          continue;
        }
        if (++visited % 50 === 0) progress({ phase: 'Looking for projects', done: found.length, current: d });
        for (const e of entries) {
          const full = path.join(d, e.name);
          if (e.isDirectory()) {
            if (depth >= 10 || e.name.startsWith('.') || e.name === 'node_modules') continue;
            if (skipAutoSave && AUTO_SAVE.test(e.name)) {
              skipped++;
              continue;
            }
            stack.push({ d: full, depth: depth + 1 });
          } else if (e.isFile() && /\.aepx?$/i.test(e.name)) {
            if (skipAutoSave && AUTO_SAVE.test(e.name)) skipped++;
            else found.push(full);
          }
        }
      }
      return { paths: found.sort((a, b) => a.localeCompare(b)), skipped };
    });
  });

  handle('batch:scan', async (event, paths, jobId) => {
    return runJob(event, jobId, async ({ signal, progress }) => {
      const results = [];
      for (let i = 0; i < paths.length; i++) {
        if (signal.aborted) break;
        const p = paths[i];
        progress({ phase: `Scanning ${path.basename(p)}`, done: i, total: paths.length });
        try {
          results.push({ path: p, ok: true, project: client(await scan(p, () => {})) });
        } catch (err) {
          results.push({ path: p, ok: false, error: err.message });
        }
      }
      progress({ phase: 'Done', done: paths.length, total: paths.length });
      return results;
    });
  });

  handle('batch:package', async (event, ids, opts, jobId) => {
    return runJob(event, jobId, async ({ signal, progress }) => {
      const results = [];
      for (let i = 0; i < ids.length; i++) {
        if (signal.aborted) break;
        const s = sessions.get(ids[i]);
        if (!s) continue;
        try {
          const r = await packageProject(s, opts, {
            signal,
            progress: (p) => progress({ ...p, phase: `${s.name} (${i + 1}/${ids.length}) — ${p.phase || ''}` }),
          });
          results.push({ id: s.id, name: s.name, ok: true, ...r });
        } catch (err) {
          if (err.cancelled) throw err;
          results.push({ id: s.id, name: s.name, ok: false, error: friendlyError(err, s.filePath) });
        }
      }
      return results;
    });
  });

  handle('batch:export', async (event, ids, format) => {
    const list = ids.map((id) => sessions.get(id)).filter(Boolean);
    if (!list.length) throw new UserError('No projects to export.');
    return saveReport(event, `Cargo_Batch_Report_${dateStamp()}`, format, async (fmt) => {
      if (fmt === 'csv') return report.batchCsv(list);
      if (fmt === 'json') return JSON.stringify(list.map((s) => report.reportData(s)), null, 2);
      if (fmt === 'txt') return list.map((s) => report.toText(report.reportData(s))).join('\r\n\r\n');
      const html = report.batchHtml(list);
      return fmt === 'html' ? html : renderPdf(html);
    });
  });

  // ---- store -----------------------------------------------------------------

  handle('store:get', async () => store.snapshot());
  handle('store:setTags', async (_e, keys, tags) => {
    store.setTags(keys, tags);
    return store.snapshot();
  });
  handle('store:setFavorite', async (_e, keys, on) => {
    store.setFavorite(keys, on);
    return store.snapshot();
  });
  handle('store:removeRecent', async (_e, p) => {
    store.removeRecent(p);
    return store.snapshot();
  });
  handle('store:clearRecent', async () => {
    store.clearRecent();
    return store.snapshot();
  });
  handle('store:clearHistory', async () => {
    store.data.packages = [];
    store.save();
    return store.snapshot();
  });
  handle('store:setSetting', async (_e, key, value) => {
    store.setSetting(key, value);
    return store.snapshot();
  });

  // ---- shell -----------------------------------------------------------------

  const knownPath = (p) => {
    const key = pathKey(p);
    for (const s of sessions.values()) {
      if (pathKey(s.filePath) === key) return true;
    }
    return allowed.has(key);
  };

  handle('shell:showInFolder', async (_e, p) => {
    if (p) shell.showItemInFolder(path.normalize(p));
    return true;
  });

  handle('shell:openPath', async (_e, p) => {
    const ext = path.extname(p).slice(1).toLowerCase();
    if (BLOCKED_OPEN.has(ext)) throw new UserError('Cargo does not open program or script files.');
    if (!knownPath(p) && !(await statSafe(p))?.isDirectory()) throw new UserError('Cargo only opens files that belong to a scanned project.');
    const err = await shell.openPath(path.normalize(p));
    if (err) throw new UserError(err);
    return true;
  });

  handle('shell:openProject', async (_e, id) => {
    const s = getSession(id);
    const err = await shell.openPath(s.filePath);
    if (err) throw new UserError(`Could not open the project: ${err}`);
    return true;
  });

  handle('shell:openExternal', async (_e, url) => {
    if (!/^https:\/\//.test(url)) throw new UserError('Only web links can be opened.');
    await shell.openExternal(url);
    return true;
  });

  // ---- updates ---------------------------------------------------------------

  let latestUpdate = null;
  let downloadedSetup = null;

  handle('update:check', async (_e, { manual = false } = {}) => {
    if (!manual && store.data.settings.autoUpdate === false) return null;
    try {
      latestUpdate = await updater.check();
    } catch (err) {
      if (manual) throw new UserError(`Couldn’t reach GitHub to check for updates (${err.message}).`);
      return null;
    }
    store.setSetting('lastUpdateCheck', Date.now());
    return latestUpdate;
  });

  handle('update:download', async (event, jobId) => {
    if (!latestUpdate || !latestUpdate.canInstall) throw new UserError('There is no update to download.');
    return runJob(event, jobId, async ({ signal, progress }) => {
      downloadedSetup = await updater.download(latestUpdate, { onProgress: progress, signal });
      return true;
    });
  });

  handle('update:install', async () => {
    if (!downloadedSetup) throw new UserError('Download the update first.');
    await store.flush();
    updater.install(downloadedSetup);
    return true;
  });

  handle('job:cancel', async (_e, jobId) => {
    const c = jobs.get(jobId);
    if (c) c.abort();
    return !!c;
  });

  handle('app:info', async () => ({ version: app.getVersion(), platform: process.platform, name: app.getName(), homepage: updater.REPO_URL }));

  return { allowedKeys: () => allowed };
}

module.exports = { register };
