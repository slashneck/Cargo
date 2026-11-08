// Operations triggered from the UI. They talk to the main process through
// window.cargo and update the shared state.

import { state, emit, resetProjectView, invalidate, selectedAssets, tagsFor, isFavorite, assetById, compById, appName } from './state.js';
import { runJob, errorDialog, toast, openMenu, modal } from './ui.js';
import { h, btn, checkbox, uid, basename, fmtBytes, plural } from './util.js';
import { clearThumbCache } from './views/table.js';
import { deleteUnusedDialog, deleteAssetsDialog, leftoversDialog } from './dialogs.js';

const api = window.cargo;

export async function refreshStore(snapshot) {
  state.store = snapshot || (await api.getState());
  state.storeVersion = (state.storeVersion || 0) + 1;
  invalidate();
}

function setProject(project, { keepView = false } = {}) {
  const previous = state.project;
  if (previous && previous.id !== project.id && !state.projects.has(previous.id)) api.close(previous.id).catch(() => {});
  state.project = project;
  if (state.fromBatch || state.batch.some((b) => b.id === project.id)) state.projects.set(project.id, project);
  if (!keepView) {
    resetProjectView();
    state.tab = 'assets';
  } else {
    // Drop selections of items that no longer exist.
    const ids = new Set(project.assets.map((a) => a.id));
    state.selection = new Set([...state.selection].filter((id) => ids.has(id)));
    if (!ids.has(state.focusId)) state.focusId = null;
    invalidate();
  }
  state.mode = 'project';
}

export async function openProject(filePath, { fromBatch = false } = {}) {
  const prevMode = state.mode;
  state.mode = 'scanning';
  state.scanProgress = { phase: 'Reading project', path: filePath };
  emit('all');
  const jobId = uid();
  const off = api.onProgress((p) => {
    if (p.jobId !== jobId) return;
    state.scanProgress = { ...p, path: filePath };
    emit('scan');
  });
  try {
    const project = await api.scan(filePath, jobId);
    state.fromBatch = fromBatch;
    if (!fromBatch) {
      state.projects.forEach((p, id) => {
        if (!state.batch.some((b) => b.id === id)) state.projects.delete(id);
      });
    }
    setProject(project);
    await refreshStore();
    emit('all');
  } catch (err) {
    state.mode = prevMode === 'scanning' ? 'welcome' : prevMode === 'project' && state.project ? 'project' : prevMode === 'batch' ? 'batch' : 'welcome';
    emit('all');
    errorDialog(err.message, 'Couldn’t read this project');
  } finally {
    off();
  }
}

export async function showProject(id) {
  const project = state.projects.get(id);
  if (!project) return;
  state.fromBatch = true;
  setProject(project);
  emit('all');
}

export async function rescan({ quiet = false } = {}) {
  if (!state.project) return;
  try {
    const project = await runJob('Rescanning project', (jobId) => api.rescan(state.project.id, jobId), { icon: 'refresh', delay: 400, cancellable: false });
    clearThumbCache();
    setProject(project, { keepView: true });
    await refreshStore();
    emit('all');
    if (!quiet) toast('Project rescanned', { tone: 'ok', timeout: 2000 });
  } catch (err) {
    errorDialog(err.message, 'Couldn’t rescan the project');
  }
}

export function applyProjectUpdate(project) {
  clearThumbCache();
  setProject(project, { keepView: true });
  emit('all');
}

export function goHome() {
  state.mode = 'welcome';
  state.fromBatch = false;
  refreshStore().then(() => emit('all'));
}

export async function chooseAndOpen() {
  try {
    const [p] = await api.openProjects({ multi: false });
    if (p) await openProject(p);
  } catch (err) {
    errorDialog(err.message);
  }
}

// ---------------------------------------------------------------- batch

export async function batchScan(paths, { append = true } = {}) {
  if (!paths.length) return;
  const existing = new Set(state.batch.map((b) => b.path.toLowerCase()));
  const todo = paths.filter((p) => !append || !existing.has(p.toLowerCase()));
  if (!todo.length) {
    state.mode = 'batch';
    emit('all');
    return;
  }
  try {
    const results = await runJob(`Scanning ${plural(todo.length, 'project')}`, (jobId) => api.batchScan(todo, jobId), { icon: 'batch' });
    if (!append) {
      state.batch = [];
      state.projects.clear();
    }
    for (const r of results) {
      if (r.ok) state.projects.set(r.project.id, r.project);
      state.batch.push({ path: r.path, ok: r.ok, id: r.ok ? r.project.id : null, error: r.error || null });
    }
    state.mode = 'batch';
    await refreshStore();
    emit('all');
    const failed = results.filter((r) => !r.ok).length;
    if (failed) toast(`${plural(failed, 'project')} couldn’t be read`, { tone: 'bad' });
  } catch (err) {
    if (!err.cancelled) errorDialog(err.message);
  }
}

/** Finds projects in a folder, leaving out auto-saves unless asked not to. */
async function findIn(folder) {
  const skipAutoSave = state.store.settings.skipAutoSave !== false;
  const r = await runJob('Looking for projects', (jobId) => api.findProjects(folder, { skipAutoSave }, jobId), { icon: 'search' });
  return r;
}

export async function scanFolder(dir) {
  try {
    const folder = dir || (await api.openFolder({ title: 'Choose a folder with projects' }));
    if (!folder) return;
    const go = btn('Scan', { cls: 'primary', icon: 'search' });
    let skip = state.store.settings.skipAutoSave !== false;
    const m = modal({
      title: 'Scan a folder',
      subtitle: 'Every After Effects and FL Studio project in this folder and its subfolders is scanned.',
      icon: 'batch',
      body: [
        h('div.path-box', h('div.mono', folder)),
        checkbox({ checked: skip, label: 'Skip auto-save projects', hint: 'Leaves out auto-saves and backups, like “Project auto-save 3.aep” or “Song (overwritten at 1503).flp”.', onchange: (v) => (skip = v) }),
      ],
      footer: (close) => [h('div.info'), btn('Cancel', { onclick: () => close(null) }), go],
    });
    go.addEventListener('click', () => m.close('go'));
    if ((await m.result) !== 'go') return;
    if (skip !== (state.store.settings.skipAutoSave !== false)) await refreshStore(await api.setSetting('skipAutoSave', skip));
    const { paths, skipped } = await findIn(folder);
    if (!paths.length) {
      toast(skipped ? `Only auto-save projects were found (${skipped}).` : 'No After Effects or FL Studio projects were found in that folder.');
      return;
    }
    await batchScan(paths);
    if (skipped) toast(`Skipped ${plural(skipped, 'auto-save project')}.`, { timeout: 3500 });
  } catch (err) {
    if (!err.cancelled) errorDialog(err.message);
  }
}

export async function addProjectsToBatch() {
  const paths = await api.openProjects({ multi: true });
  if (paths.length) await batchScan(paths);
}

/** Files or folders dropped onto the window. */
export async function handleDropped(paths) {
  const projects = paths.filter((p) => /\.(aepx?|flp)$/i.test(p));
  const others = paths.filter((p) => !/\.(aepx?|flp)$/i.test(p));
  if (projects.length === 1 && others.length === 0) return openProject(projects[0]);
  let all = [...projects];
  for (const dir of others) {
    try {
      all.push(...(await findIn(dir)).paths);
    } catch (err) {
      if (err.cancelled) return;
    }
  }
  all = [...new Set(all)];
  if (!all.length) {
    toast('Drop an After Effects or FL Studio project (.aep, .aepx, .flp), or a folder that contains some.', { tone: 'bad' });
    return;
  }
  if (all.length === 1) return openProject(all[0]);
  return batchScan(all);
}

// ---------------------------------------------------------------- assets

export async function reveal(p) {
  try {
    await api.showInFolder(p);
  } catch (err) {
    errorDialog(err.message);
  }
}

export async function openInAE() {
  try {
    await api.openProject(state.project.id);
    toast(`Opening in ${appName()}…`, { timeout: 2500 });
  } catch (err) {
    errorDialog(err.message);
  }
}

export async function openFile(a) {
  if (!a.exists) {
    toast(`“${a.name}” is missing. Use Locate to find it.`, { tone: 'bad' });
    return;
  }
  try {
    await api.openPath(a.resolvedPath);
  } catch (err) {
    errorDialog(err.message);
  }
}

export async function copyText(text, what = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(what, { tone: 'ok', timeout: 1600 });
  } catch {
    toast('Couldn’t copy to the clipboard', { tone: 'bad' });
  }
}

export async function setFavorite(assets, on) {
  const keys = assets.map((a) => a.key).filter(Boolean);
  if (!keys.length) return;
  await refreshStore(await api.setFavorite(keys, on));
  emit('table', 'preview', 'sidebar');
}

export async function setTags(assets, tags) {
  const keys = assets.map((a) => a.key).filter(Boolean);
  if (!keys.length) return;
  await refreshStore(await api.setTags(keys, tags));
  emit('table', 'preview', 'sidebar');
}

export async function addTag(assets, tag) {
  for (const a of assets) {
    const keys = [a.key].filter(Boolean);
    if (!keys.length) continue;
    const next = [...new Set([...tagsFor(a), tag])];
    await refreshStore(await api.setTags(keys, next));
  }
  emit('table', 'preview', 'sidebar');
}

export async function removeTag(assets, tag) {
  for (const a of assets) {
    if (!a.key) continue;
    await refreshStore(await api.setTags([a.key], tagsFor(a).filter((t) => t !== tag)));
  }
  emit('table', 'preview', 'sidebar');
}

export const PRESET_TAGS = ['keep', 'archive', 'sell', 'client', 'review'];

export function allTags() {
  const set = new Set(PRESET_TAGS);
  for (const tags of Object.values(state.store.tags)) tags.forEach((t) => set.add(t));
  return [...set];
}

/** Tag picker menu for the given assets. */
export function tagMenu(anchor, assets) {
  const input = h('input.input', {
    placeholder: 'New tag…',
    maxLength: 24,
    onkeydown: (e) => {
      if (e.key === 'Enter' && input.value.trim()) {
        const tag = input.value.trim().toLowerCase().replace(/\s+/g, '-');
        addTag(assets, tag);
        document.querySelector('.menu')?.remove();
      }
      e.stopPropagation();
    },
  });
  const items = [{ header: assets.length > 1 ? `Tag ${assets.length} items` : 'Tags' }];
  for (const t of allTags()) {
    const has = assets.every((a) => tagsFor(a).includes(t));
    items.push({ label: t, icon: has ? 'check' : 'tag', onclick: () => (has ? removeTag(assets, t) : addTag(assets, t)) });
  }
  items.push('sep', { node: h('div.menu-input', input) });
  if (assets.some((a) => tagsFor(a).length)) items.push({ label: 'Remove all tags', icon: 'x', onclick: () => setTags(assets, []) });
  openMenu(anchor, items, { minWidth: 220 });
  setTimeout(() => input.focus(), 30);
}

export async function locate(a) {
  try {
    const target = await api.locateFile({ title: `Locate “${a.name}”`, defaultPath: state.project.dir, ext: a.ext });
    if (!target) return;
    const project = await runJob('Relinking', (jobId) => api.relink(state.project.id, [{ assetId: a.id, path: target }], jobId), { icon: 'link', delay: 400, cancellable: false });
    applyProjectUpdate(project);
    toast(`Relinked “${a.name}”. Save a relinked copy of the project to keep it for ${appName()}.`, { tone: 'ok', timeout: 6000 });
  } catch (err) {
    errorDialog(err.message);
  }
}

export async function clearRelink(assets) {
  const links = assets.filter((a) => a.relinked).map((a) => ({ assetId: a.id, path: null }));
  if (!links.length) return;
  try {
    const project = await runJob('Updating', (jobId) => api.relink(state.project.id, links, jobId), { delay: 400, cancellable: false });
    applyProjectUpdate(project);
  } catch (err) {
    errorDialog(err.message);
  }
}

export async function saveRelinked() {
  try {
    const r = await api.saveRelinked(state.project.id);
    toast(`Saved ${basename(r.path)} with ${plural(r.changed, 'updated path')}.`, {
      tone: 'ok',
      timeout: 8000,
      action: { label: 'Show', onclick: () => reveal(r.path) },
    });
  } catch (err) {
    errorDialog(err.message, 'Couldn’t save the relinked project');
  }
}

export function filterByComp(compId) {
  state.tab = 'assets';
  state.filter = { ...state.filter, compId, folderId: null, library: 'all', status: null };
  state.selection = new Set();
  invalidate();
  emit('all');
}

export function filterByFolder(folderId) {
  state.tab = 'assets';
  state.filter = { ...state.filter, folderId, compId: null };
  invalidate();
  emit('all');
}

export function focusAsset(id) {
  const a = assetById(id);
  if (!a) return;
  state.tab = 'assets';
  // Make sure the asset is visible.
  state.filter = { library: 'all', status: null, folderId: null, compId: null, search: '' };
  if (a.kind === 'solid' && !state.store.settings.showGenerated) state.filter.library = 'solid';
  state.selection = new Set([id]);
  state.focusId = id;
  state.anchorId = id;
  invalidate();
  emit('all', 'scrollToFocus');
}

export function assetContextMenu(a, at) {
  const sel = selectedAssets();
  const many = sel.length > 1;
  const targets = many ? sel : [a];
  const fav = targets.every(isFavorite);
  const items = [];
  if (!many) {
    items.push({ label: 'Show in folder', icon: 'reveal', disabled: !a.exists, onclick: () => reveal(a.resolvedPath) });
    items.push({ label: 'Open', icon: 'external', disabled: !a.exists, kbd: 'Enter', onclick: () => openFile(a) });
    if (a.resolvedPath) items.push({ label: 'Copy path', icon: 'copy', onclick: () => copyText(a.resolvedPath, 'Path copied') });
    items.push('sep');
  } else {
    items.push({ header: `${sel.length} items selected` });
    items.push({ label: 'Copy paths', icon: 'copy', onclick: () => copyText(sel.map((x) => x.resolvedPath).filter(Boolean).join('\n'), 'Paths copied') });
  }
  items.push({ label: fav ? 'Remove from favorites' : 'Add to favorites', icon: 'star', onclick: () => setFavorite(targets, !fav) });
  items.push({ label: 'Tags…', icon: 'tag', onclick: () => tagMenu(at, targets) });
  if (!many && a.kind === 'file') {
    items.push('sep');
    if (!a.exists || a.relinked) items.push({ label: a.exists ? 'Locate a different file…' : 'Locate file…', icon: 'locate', onclick: () => locate(a) });
    if (a.relinked) items.push({ label: 'Undo relink', icon: 'x', onclick: () => clearRelink([a]) });
  }
  const withFiles = targets.filter((x) => x.kind === 'file' && x.exists);
  if (withFiles.length) {
    items.push('sep', { label: many ? `Move ${withFiles.length} to Recycle Bin…` : 'Move to Recycle Bin…', icon: 'trash', danger: true, kbd: 'Del', onclick: () => deleteAssetsDialog({ assetIds: withFiles.map((x) => x.id) }) });
  }
  if (!many && a.usedIn.length) {
    items.push('sep', { header: 'Used in' });
    for (const id of a.usedIn.slice(0, 6)) {
      const c = compById(id);
      items.push({ label: c ? c.name : `#${id}`, icon: 'comp', onclick: () => showComp(id) });
    }
  }
  openMenu(at, items);
}

export function showComp(id) {
  state.tab = 'comps';
  state.compFocus = id;
  // Open the path to this comp in the tree.
  emit('all');
}

export function deleteMenu(anchor) {
  const p = state.project;
  const selected = p.assets.filter((a) => state.selection.has(a.id) && a.kind === 'file' && a.exists);
  const onDisk = p.assets.filter((a) => a.kind === 'file' && a.exists && !a.leftover);
  const leftovers = p.assets.filter((a) => a.leftover);
  openMenu(
    anchor,
    [
      { header: 'Move to Recycle Bin' },
      { label: 'Unused files…', icon: 'trash', disabled: !p.totals.unusedFileCount, onclick: deleteUnusedDialog },
      { label: selected.length ? `Selected files (${selected.length})…` : 'Selected files…', icon: 'check', disabled: !selected.length, kbd: 'Del', onclick: () => deleteAssetsDialog({ assetIds: selected.map((a) => a.id) }) },
      { label: leftovers.length ? `Not in project (${leftovers.length})…` : 'Not in project…', icon: 'mic', disabled: !leftovers.length, onclick: () => deleteAssetsDialog({ assetIds: leftovers.map((a) => a.id) }) },
      'sep',
      { label: 'All media of this project…', icon: 'alert', danger: true, disabled: !onDisk.length, onclick: () => deleteAssetsDialog() },
      'sep',
      { label: 'Find leftover files…', icon: 'search', onclick: leftoversDialog },
    ],
    { minWidth: 240 },
  );
}

export function exportMenu(anchor) {
  const run = (fmt) => async () => {
    try {
      const out = await api.exportReport(state.project.id, fmt);
      if (out) toast(`Exported ${basename(out)}`, { tone: 'ok', action: { label: 'Show', onclick: () => reveal(out) } });
    } catch (err) {
      errorDialog(err.message, 'Export failed');
    }
  };
  openMenu(
    anchor,
    [
      { header: 'Export manifest' },
      { label: 'PDF report', icon: 'file', onclick: run('pdf') },
      { label: 'Text (.txt)', icon: 'list', onclick: run('txt') },
      { label: 'Spreadsheet (.csv)', icon: 'dashboard', onclick: run('csv') },
      { label: 'JSON', icon: 'data', onclick: run('json') },
      { label: 'Web page (.html)', icon: 'external', onclick: run('html') },
    ],
    { align: 'right', minWidth: 210 },
  );
}

export function recentMenu(anchor) {
  const recent = state.store.recent.slice(0, 12);
  const items = [{ header: 'Recent projects' }];
  if (!recent.length) items.push({ label: 'Nothing here yet', disabled: true });
  for (const r of recent) items.push({ label: r.name, icon: 'project', onclick: () => openProject(r.path) });
  items.push('sep', { label: 'Scan a folder…', icon: 'batch', onclick: () => scanFolder() });
  openMenu(anchor, items, { align: 'right', minWidth: 260 });
}

export function summarize(assets) {
  const size = assets.reduce((t, a) => t + (a.exists ? a.size : 0), 0);
  return `${plural(assets.length, 'item')} · ${fmtBytes(size)}`;
}

