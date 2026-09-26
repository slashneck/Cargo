// The larger dialogs: package, archive, organize, delete unused, find missing, help.

import { state, emit } from './state.js';
import { modal, runJob, errorDialog, toast, confirmDialog } from './ui.js';
import { h, btn, iconBtn, replace, checkbox, fmtBytes, fmtTime, plural, debounce, basename, dirname, STATUS_LABEL } from './util.js';
import { icon } from './icons.js';
import { refreshStore, applyProjectUpdate, reveal, openProject, rescan, saveRelinked } from './actions.js';

const api = window.cargo;

const LAYOUTS = [
  ['type', 'By type — Video, Audio, Images…'],
  ['project', 'Mirror the After Effects project folders'],
  ['resolution', 'By type and resolution'],
  ['date', 'By date modified (year / month)'],
  ['flat', 'Everything in one folder'],
];

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function safeName(s) {
  return String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'Project';
}

function select(options, value, onchange) {
  const el = h('select.select', { onchange: () => onchange(el.value) }, ...options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
  return el;
}

function seg(options, value, onchange) {
  const wrap = h('div.seg');
  const paint = (v) => {
    replace(
      wrap,
      ...options.map(([val, label, ic]) =>
        h(`button${val === v ? '.on' : ''}`, { type: 'button', onclick: () => { paint(val); onchange(val); } }, ic ? icon(ic, 'sm') : null, label),
      ),
    );
  };
  paint(value);
  return wrap;
}

function folderField(label, value, onchange, { title = 'Choose a folder', placeholder = 'Choose a folder…' } = {}) {
  const input = h('input.input.mono', { value: value || '', placeholder, readOnly: true, title: value || '' });
  const choose = async () => {
    const dir = await api.openFolder({ title, defaultPath: input.value || undefined });
    if (dir) {
      input.value = dir;
      input.title = dir;
      onchange(dir);
    }
  };
  input.addEventListener('click', choose);
  return h('div.field', h('label', label), h('div.field-row', input, btn('Browse…', { onclick: choose })));
}

function estimate(bytes) {
  // Rough store-mode zip / copy speed of an SSD.
  return fmtTime(bytes / (220 * 1024 * 1024));
}

async function saveSettings(patch) {
  for (const [k, v] of Object.entries(patch)) await api.setSetting(k, v);
  await refreshStore();
}

// ---------------------------------------------------------------- package

/**
 * The “Private package” option and the two options it rules out: pointing
 * the project at the package's real location (that path contains user and
 * folder names) and shipping the untouched original project.
 */
function privacyOptions(opts, { withOriginal = true } = {}) {
  const relinkBox = checkbox({ checked: opts.relink, label: 'Point the packaged project to the packaged files', hint: 'Your original project is never changed. A “Relink Footage” script is included as a fallback.', onchange: (v) => { opts.relink = v; paint(); } });
  const originalBox = withOriginal ? checkbox({ checked: opts.includeOriginal, label: 'Also include the untouched original project', hint: 'Saved in an “Original Project” folder', onchange: (v) => (opts.includeOriginal = v) }) : null;
  const note = h('div.notice.info', icon('shield'), h('div', 'The packaged project points to a neutral folder named after the package, and its save history is removed. Extract the package to C:\\ or run the included “Relink Footage” script to reconnect the footage.'));
  const privateBox = checkbox({ checked: opts.privateMode, label: 'Private package', hint: 'Keeps paths, your user and computer name, dates and version info out of the package.', onchange: (v) => { opts.privateMode = v; paint(); } });
  const setDisabled = (label, disabled) => {
    if (!label) return;
    label.classList.toggle('disabled', disabled);
    label.querySelector('input').disabled = disabled;
  };
  function paint() {
    setDisabled(relinkBox, opts.privateMode);
    setDisabled(originalBox, opts.privateMode || !opts.relink);
    if (originalBox) originalBox.hidden = !opts.relink && !opts.privateMode;
    note.hidden = !opts.privateMode;
  }
  paint();
  return h('div.col', { style: { gap: '10px' } }, privateBox, note, relinkBox, originalBox);
}

export async function packageDialog({ assetIds = null, title = null } = {}) {
  const p = state.project;
  const s = state.store.settings;
  const opts = {
    format: s.packageFormat || 'zip',
    destDir: s.packageDest || dirname(p.filePath),
    includeUnused: !!s.packageIncludeUnused,
    layout: s.packageLayout || 'type',
    relink: s.packageRelink !== false,
    privateMode: s.packagePrivate !== false,
    includeOriginal: false,
    name: `${safeName(title || p.name)}_Package_${today()}`,
    assetIds,
  };

  const summary = h('div.summary-box');
  const fileNote = h('div');
  const sample = h('div.file-list', { style: { maxHeight: '150px' } });
  const packBtn = btn('Package', { cls: 'primary', icon: 'package' });

  const refresh = debounce(async () => {
    try {
      const pv = await api.packagePreview(p.id, opts);
      replace(
        summary,
        h('div', h('div.k', 'Files'), h('div.v', String(pv.files))),
        h('div', h('div.k', 'Size'), h('div.v', fmtBytes(pv.bytes))),
        h('div', h('div.k', opts.format === 'zip' ? 'Zipping takes about' : 'Copying takes about'), h('div.v', estimate(pv.bytes))),
      );
      replace(
        fileNote,
        pv.missing ? h('div.notice.warn', icon('alert'), h('div', h('b', `${plural(pv.missing, 'missing file')}`), ' can’t be included. Use Find Missing first if you have them somewhere.')) : null,
        pv.unused && !opts.includeUnused ? h('div.notice.info', { style: { marginTop: pv.missing ? '8px' : 0 } }, icon('info'), h('div', `${plural(pv.unused, 'unused item')} (${fmtBytes(pv.unusedBytes)}) will be left out.`)) : null,
      );
      replace(sample, ...pv.sample.slice(0, 200).map((rel) => h('div.fl-row', { style: { gridTemplateColumns: '18px minmax(0,1fr)' } }, icon('file', 'sm'), h('span.mono.ellipsis', { title: rel }, rel))));
      if (!pv.files) replace(sample, h('div.fl-row', h('span'), h('span.dim', 'No files to include.')));
      packBtn.disabled = !opts.destDir;
    } catch (err) {
      replace(summary, h('div.dim', err.message));
    }
  }, 120);

  const nameInput = h('input.input', { value: opts.name, oninput: () => (opts.name = nameInput.value) });

  const m = modal({
    title: assetIds ? `Package “${title}”` : 'Package project',
    subtitle: assetIds ? 'The project plus only the files this composition uses.' : 'The project file and every file it uses, ready to hand off, archive or sell.',
    icon: 'package',
    width: 'wide',
    body: [
      h('div.fields-2', h('div.field', h('div.label', 'Format'), seg([['zip', 'Zip file', 'zip'], ['folder', 'Folder', 'folder']], opts.format, (v) => { opts.format = v; refresh(); })), h('div.field', h('label', 'Name'), nameInput)),
      folderField('Save to', opts.destDir, (v) => { opts.destDir = v; refresh(); }, { title: 'Where should the package go?' }),
      h('div.fields-2',
        h('div.field', h('label', 'Organize files'), select(LAYOUTS.filter(([k]) => k !== 'date'), opts.layout, (v) => { opts.layout = v; refresh(); })),
        h('div.field', h('div.label', 'Include'), checkbox({ checked: opts.includeUnused, label: 'Unused footage too', hint: 'Off keeps the package small', onchange: (v) => { opts.includeUnused = v; refresh(); } })),
      ),
      privacyOptions(opts),
      summary,
      fileNote,
      h('details', h('summary', { style: { cursor: 'pointer', color: 'var(--text-3)' } }, 'Preview the package layout'), h('div', { style: { marginTop: '8px' } }, sample)),
    ],
    footer: (close) => [h('div.info', 'A manifest (MANIFEST.txt) is added automatically.'), btn('Cancel', { onclick: () => close(null) }), packBtn],
  });
  packBtn.addEventListener('click', () => m.close('go'));
  refresh();
  if ((await m.result) !== 'go') return;

  await saveSettings({ packageFormat: opts.format, packageDest: opts.destDir, packageIncludeUnused: opts.includeUnused, packageLayout: opts.layout, packageRelink: opts.relink, packagePrivate: opts.privateMode });
  try {
    const r = await runJob(opts.format === 'zip' ? 'Creating zip' : 'Copying files', (jobId) => api.packageProject(p.id, opts, jobId), { subtitle: opts.name });
    await refreshStore();
    const missing = r.skipped.filter((k) => k.reason === 'missing').length;
    resultDialog({
      title: r.privateMode ? 'Private package ready' : 'Package ready',
      lines: [
        `${plural(r.files, 'file')} · ${fmtBytes(r.bytes)}`,
        r.privateMode ? `Paths in the packaged project point to ${r.neutral}` : r.relinked ? `${plural(r.relinked, 'footage path')} updated in the packaged project` : null,
        missing ? `${plural(missing, 'missing file')} not included` : null,
      ],
      output: r.output,
      warnings: [...r.warnings, ...r.failed.map((f) => `${basename(f.path)}: ${f.error}`)],
    });
  } catch (err) {
    if (err.cancelled) toast('Packaging cancelled. Nothing was left behind.');
    else errorDialog(err.message, 'Packaging failed');
  }
}

function resultDialog({ title, lines, output, warnings = [], extra = [] }) {
  const m = modal({
    title,
    icon: 'checkCircle',
    tone: 'ok',
    body: [
      h('div.col', { style: { gap: '4px', color: 'var(--text-2)' } }, ...lines.filter(Boolean).map((l) => h('div', l))),
      output ? h('div.path-box', h('div.mono', output), iconBtn('copy', { title: 'Copy path', cls: 'ghost sm', onclick: () => navigator.clipboard.writeText(output) })) : null,
      warnings.length ? h('div.notice.warn', icon('alert'), h('div', ...warnings.slice(0, 8).map((w) => h('div', w)), warnings.length > 8 ? h('div', `…and ${warnings.length - 8} more`) : null)) : null,
    ],
    footer: (close) => [h('div.info'), ...extra.map((e) => btn(e.label, { onclick: () => { close(); e.onclick(); } })), output ? btn('Show in folder', { icon: 'reveal', onclick: () => reveal(output) }) : null, btn('Done', { cls: 'primary', onclick: () => close(true) })],
  });
  return m.result;
}

// ---------------------------------------------------------------- delete unused

export async function deleteUnusedDialog() {
  const p = state.project;
  let plan;
  try {
    plan = await api.deletePlan(p.id);
  } catch (err) {
    return errorDialog(err.message);
  }
  if (!plan.groups.length) {
    return modal({
      title: 'Nothing to delete',
      icon: 'checkCircle',
      tone: 'ok',
      body: [
        h('div', { style: { color: 'var(--text-2)' } }, 'Every file on disk is used by this project, or you asked to keep it.'),
        plan.skipped.length ? skippedList(plan.skipped) : null,
      ],
      footer: (close) => [h('div.info'), btn('OK', { cls: 'primary', onclick: () => close() })],
    });
  }

  const chosen = new Set(plan.groups.map((g) => g.id));
  const total = h('span');
  const go = btn('Move to Recycle Bin', { cls: 'danger solid', icon: 'trash' });
  const updateTotals = () => {
    const groups = plan.groups.filter((g) => chosen.has(g.id));
    const files = groups.reduce((t, g) => t + g.files.length, 0);
    const size = groups.reduce((t, g) => t + g.size, 0);
    total.textContent = `${plural(files, 'file')} · ${fmtBytes(size)}`;
    go.lastChild.textContent = files ? `Move ${plural(files, 'file')} to Recycle Bin` : 'Nothing selected';
    go.disabled = !files;
  };
  const rows = plan.groups.map((g) =>
    h(
      'div.fl-row',
      checkbox({ checked: true, onchange: (on) => { if (on) chosen.add(g.id); else chosen.delete(g.id); updateTotals(); } }),
      h('div', { style: { minWidth: 0 } }, h('div.ellipsis', { style: { color: 'var(--text)' } }, g.name), h('div.ellipsis.dimmer', { title: g.folder, style: { fontSize: '11px' } }, g.files.length > 1 ? `${g.files.length} frames · ${g.folder}` : g.folder)),
      h('div.num', { style: { textAlign: 'right' } }, fmtBytes(g.size)),
    ),
  );
  updateTotals();
  const m = modal({
    title: 'Delete unused files',
    subtitle: 'Files that no composition in this project uses.',
    icon: 'trash',
    tone: 'bad',
    width: 'wide',
    body: [
      h('div.notice.info', icon('info'), h('div', 'Files go to the ', h('b', 'Recycle Bin'), ', so you can restore them. The project still lists these items — in After Effects, ', h('b', 'File › Dependencies › Remove Unused Footage'), ' removes them from the project too.')),
      h('div.file-list', { style: { maxHeight: '340px' } }, h('div.fl-row.fl-head', h('span'), h('span', `${plan.groups.length} unused items`), h('span', { style: { textAlign: 'right' } }, 'Size')), ...rows),
      plan.skipped.length ? skippedList(plan.skipped) : null,
      h('div.notice.warn', icon('alert'), h('div', 'Other projects that use these files are only protected if they are open in Cargo (Batch). Tag files as ', h('b', 'keep'), ' to always protect them.')),
    ],
    footer: (close) => [h('div.info', total), btn('Cancel', { onclick: () => close(null) }), go],
  });
  go.addEventListener('click', () => m.close('go'));
  if ((await m.result) !== 'go') return;
  const files = plan.groups.filter((g) => chosen.has(g.id)).flatMap((g) => g.files);
  try {
    const r = await runJob('Moving files to the Recycle Bin', (jobId) => api.trash(p.id, files, jobId), { icon: 'trash' });
    applyProjectUpdate(r.project);
    await refreshStore();
    emit('all');
    if (r.failed.length) errorDialog(`${plural(r.failed.length, 'file')} couldn’t be moved:\n${r.failed.slice(0, 10).map((f) => `${basename(f.path)} — ${f.error}`).join('\n')}`, 'Some files were kept');
    else toast(`Moved ${plural(r.trashed.length, 'file')} to the Recycle Bin · ${fmtBytes(r.freed)} freed once it’s emptied`, { tone: 'ok', timeout: 7000 });
  } catch (err) {
    if (!err.cancelled) errorDialog(err.message);
  }
}

// ---------------------------------------------------------------- delete selected / all

/** Deletes chosen items (or, without `assetIds`, all media of the project). */
export async function deleteAssetsDialog({ assetIds = null } = {}) {
  const p = state.project;
  const all = !assetIds;
  let plan;
  try {
    plan = await api.deleteAssetsPlan(p.id, assetIds);
  } catch (err) {
    return errorDialog(err.message);
  }
  if (!plan.groups.length) {
    toast(all ? 'None of this project’s files are on disk.' : 'The selected items have no files on disk.', { tone: 'bad' });
    return;
  }

  const chosen = new Set(plan.groups.filter((g) => !g.reasons.length).map((g) => g.id));
  let includeProject = false;
  const total = h('span');
  const usedNote = h('div.notice.warn', icon('alert'), h('div'));
  const go = btn('Move to Recycle Bin', { cls: 'danger solid', icon: 'trash' });
  const update = () => {
    const groups = plan.groups.filter((g) => chosen.has(g.id));
    const files = groups.reduce((t, g) => t + g.files.length, 0) + (includeProject ? 1 : 0);
    const size = groups.reduce((t, g) => t + g.size, 0) + (includeProject ? plan.projectSize : 0);
    const used = groups.filter((g) => g.used).length;
    total.textContent = `${plural(files, 'file')} · ${fmtBytes(size)}`;
    go.lastChild.textContent = files ? `Move ${plural(files, 'file')} to Recycle Bin` : 'Nothing selected';
    go.disabled = !files;
    usedNote.hidden = !used;
    replace(usedNote.lastChild, h('b', `${plural(used, 'item')} ${used === 1 ? 'is' : 'are'} used in compositions. `), 'After Effects will show them as missing.');
  };
  const rows = plan.groups.map((g) =>
    h(
      'div.fl-row',
      checkbox({ checked: chosen.has(g.id), onchange: (on) => { if (on) chosen.add(g.id); else chosen.delete(g.id); update(); } }),
      h(
        'div',
        { style: { minWidth: 0 } },
        h('div.row', { style: { gap: '8px' } }, h('span.ellipsis', { style: { color: 'var(--text)' } }, g.name), g.used ? h('span.pill.used', { title: g.usedIn.join(', ') }, g.usedInCount === 1 ? 'Used in 1 comp' : `Used in ${g.usedInCount} comps`) : h('span.pill.unused', 'Unused')),
        h('div.ellipsis.dimmer', { title: g.folder, style: { fontSize: '11px' } }, g.files.length > 1 ? `${g.files.length} frames · ${g.folder}` : g.folder),
        g.reasons.length ? h('div', { style: { color: 'var(--warn)', fontSize: '11px' } }, g.reasons.join(' · ')) : null,
      ),
      h('div.num', { style: { textAlign: 'right' } }, fmtBytes(g.size)),
    ),
  );
  const protectedCount = plan.groups.length - chosen.size;
  update();
  const m = modal({
    title: all ? 'Delete all media' : `Delete ${plural(plan.groups.length, 'item')}`,
    subtitle: all ? `Every file “${p.name}” uses, on disk.` : 'The files of the items you selected.',
    icon: 'trash',
    tone: 'bad',
    width: 'wide',
    body: [
      h('div.notice.info', icon('info'), h('div', 'Files go to the ', h('b', 'Recycle Bin'), ', so you can restore them.')),
      h('div.file-list', { style: { maxHeight: '320px' } }, h('div.fl-row.fl-head', h('span'), h('span', plural(plan.groups.length, 'item')), h('span', { style: { textAlign: 'right' } }, 'Size')), ...rows),
      protectedCount ? h('div.dim', `${plural(protectedCount, 'item')} ${protectedCount === 1 ? 'is' : 'are'} unticked because you marked ${protectedCount === 1 ? 'it' : 'them'} to keep, or another project needs ${protectedCount === 1 ? 'it' : 'them'}. Tick to delete anyway.`) : null,
      usedNote,
      all ? checkbox({ checked: false, label: `Also move the project file (${basename(plan.projectFile)}) to the Recycle Bin`, onchange: (v) => { includeProject = v; update(); } }) : null,
    ],
    footer: (close) => [h('div.info', total), btn('Cancel', { onclick: () => close(null) }), go],
  });
  go.addEventListener('click', () => m.close('go'));
  if ((await m.result) !== 'go') return;

  const groups = plan.groups.filter((g) => chosen.has(g.id));
  const files = groups.flatMap((g) => g.files);
  const used = groups.filter((g) => g.used).length;
  if (all || used) {
    const ok = await confirmDialog({
      title: all ? `Delete all media of “${p.name}”?` : 'Delete files the project uses?',
      message: `${plural(files.length + (includeProject ? 1 : 0), 'file')} (${fmtBytes(groups.reduce((t, g) => t + g.size, 0))}) go to the Recycle Bin.${used ? ` ${plural(used, 'item')} used in compositions will show as missing in After Effects.` : ''}`,
      confirm: 'Move to Recycle Bin',
      danger: true,
    });
    if (!ok) return;
  }
  try {
    const r = await runJob('Moving files to the Recycle Bin', (jobId) => api.trashAssets(p.id, files, { includeProject }, jobId), { icon: 'trash' });
    await refreshStore();
    if (r.project) applyProjectUpdate(r.project);
    else {
      state.project = null;
      state.mode = 'welcome';
      emit('all');
    }
    if (r.failed.length) errorDialog(`${plural(r.failed.length, 'file')} couldn’t be moved:\n${r.failed.slice(0, 10).map((f) => `${basename(f.path)} — ${f.error}`).join('\n')}`, 'Some files were kept');
    else toast(`Moved ${plural(r.trashed.length, 'file')} to the Recycle Bin · ${fmtBytes(r.freed)}`, { tone: 'ok', timeout: 6000 });
  } catch (err) {
    if (!err.cancelled) errorDialog(err.message);
  }
}

function skippedList(skipped) {
  return h(
    'details',
    h('summary', { style: { cursor: 'pointer', color: 'var(--text-3)' } }, `${plural(skipped.length, 'unused item')} will be kept`),
    h('div.file-list', { style: { marginTop: '8px', maxHeight: '160px' } }, ...skipped.map((k) => h('div.fl-row', { style: { gridTemplateColumns: '18px minmax(0,1fr) auto' } }, icon('shield', 'sm'), h('span.ellipsis', k.name), h('span.dim', k.reason)))),
  );
}

// ---------------------------------------------------------------- organize

export async function organizeDialog() {
  const p = state.project;
  const sep = state.info.platform === 'win32' ? '\\' : '/';
  const opts = { destDir: `${p.dir}${sep}Organized Footage`, layout: 'type', mode: 'copy', includeUnused: true };
  const moveNote = h('div.notice.warn', { hidden: true }, icon('alert'), h('div', h('b', 'Moving'), ' takes the files away from where the original project (and any other project) expects them. Only the new organized project will find them.'));
  const go = btn('Organize', { cls: 'primary', icon: 'organize' });
  const m = modal({
    title: 'Organize footage',
    subtitle: 'Sort this project’s files into tidy folders and save a project that points to them.',
    icon: 'organize',
    width: 'wide',
    body: [
      folderField('Destination', opts.destDir, (v) => (opts.destDir = v), { title: 'Where should the organized footage go?' }),
      h('div.fields-2', h('div.field', h('label', 'Sort into'), select(LAYOUTS, opts.layout, (v) => (opts.layout = v))), h('div.field', h('div.label', 'Files'), seg([['copy', 'Copy'], ['move', 'Move']], opts.mode, (v) => { opts.mode = v; moveNote.hidden = v !== 'move'; }))),
      checkbox({ checked: true, label: 'Include unused footage', onchange: (v) => (opts.includeUnused = v) }),
      h('div.notice.info', icon('info'), h('div', 'A new project, ', h('b', `${p.name}_organized.aep`), ', is saved next to the original and points to the organized files. The original project file is not changed.')),
      moveNote,
    ],
    footer: (close) => [h('div.info'), btn('Cancel', { onclick: () => close(null) }), go],
  });
  go.addEventListener('click', async () => {
    if (opts.mode === 'move') {
      const ok = await confirmDialog({ title: 'Move the files?', message: 'The original project will show these files as missing afterwards. Use the organized project from now on.', confirm: 'Move files', danger: true });
      if (!ok) return;
    }
    m.close('go');
  });
  if ((await m.result) !== 'go') return;
  try {
    const r = await runJob(opts.mode === 'move' ? 'Moving files' : 'Copying files', (jobId) => api.organize(p.id, opts, jobId), { icon: 'organize' });
    await refreshStore();
    if (opts.mode === 'move') await rescan({ quiet: true });
    resultDialog({
      title: 'Footage organized',
      lines: [`${plural(r.files, 'file')} ${opts.mode === 'move' ? 'moved' : 'copied'}`, `New project: ${basename(r.project)}`],
      output: r.output,
      warnings: [...r.warnings, ...r.failed.map((f) => `${basename(f.path)}: ${f.error}`)],
      extra: [{ label: 'Open organized project', onclick: () => openProject(r.project) }],
    });
  } catch (err) {
    if (err.cancelled) toast('Stopped. Files handled so far stay in the destination.');
    else errorDialog(err.message, 'Organizing failed');
  }
}

// ---------------------------------------------------------------- archive

export async function archiveDialog() {
  const p = state.project;
  const opts = { destDir: state.store.settings.archiveDest || '', layout: 'type', includeUnused: true, removeOriginals: false };
  const go = btn('Archive', { cls: 'primary', icon: 'archive', disabled: !opts.destDir });
  const m = modal({
    title: 'Archive project',
    subtitle: 'Move a finished project and all its footage to an archive drive or folder.',
    icon: 'archive',
    width: 'wide',
    body: [
      folderField('Archive location', opts.destDir, (v) => { opts.destDir = v; go.disabled = !v; }, { title: 'Choose the archive location', placeholder: 'e.g. an external drive…' }),
      h('div.fields-2', h('div.field', h('label', 'Organize files'), select(LAYOUTS.filter(([k]) => k !== 'date'), opts.layout, (v) => (opts.layout = v))), h('div.field', h('div.label', 'Include'), checkbox({ checked: true, label: 'Unused footage too', onchange: (v) => (opts.includeUnused = v) }))),
      checkbox({
        checked: false,
        cls: 'danger',
        label: 'Remove the originals after copying',
        hint: 'Only if every file was copied and verified. Originals go to the Recycle Bin (empty it to free the space). Favorites, “keep” files and files used by other projects open in Cargo stay.',
        onchange: (v) => (opts.removeOriginals = v),
      }),
      h('div.notice.info', icon('info'), h('div', `The archive gets the project (pointing to the archived files), all footage, a manifest and a relink script, in a folder named “${p.name}”.`)),
    ],
    footer: (close) => [h('div.info'), btn('Cancel', { onclick: () => close(null) }), go],
  });
  go.addEventListener('click', () => m.close('go'));
  if ((await m.result) !== 'go') return;
  await saveSettings({ archiveDest: opts.destDir });
  try {
    const r = await runJob('Archiving project', (jobId) => api.archive(p.id, opts, jobId), { icon: 'archive' });
    await refreshStore();
    const lines = [`${plural(r.files, 'file')} · ${fmtBytes(r.bytes)} archived`];
    if (opts.removeOriginals) lines.push(r.removed ? `${plural(r.removed, 'original')} moved to the Recycle Bin` : 'Originals were kept');
    if (r.kept.length) lines.push(`${plural(r.kept.length, 'file')} kept because they’re protected`);
    resultDialog({
      title: 'Project archived',
      lines,
      output: r.output,
      warnings: [...r.warnings, ...r.failed.map((f) => `${basename(f.path)}: ${f.error}`)],
      extra: [{ label: 'Open archived project', onclick: () => openProject(r.project) }],
    });
    if (opts.removeOriginals && r.removed) openProject(r.project);
  } catch (err) {
    if (err.cancelled) toast('Archiving cancelled. The partial archive folder was removed; originals are untouched.');
    else errorDialog(err.message, 'Archiving failed');
  }
}

// ---------------------------------------------------------------- find missing

export async function missingDialog() {
  const p = state.project;
  const missing = p.assets.filter((a) => a.kind === 'file' && !a.exists);
  if (!missing.length) {
    toast('No missing files in this project.', { tone: 'ok' });
    return;
  }
  const roots = [...(state.store.settings.searchRoots || [])];
  const picks = new Map(); // asset id -> chosen path
  const results = new Map(); // asset id -> candidates
  let searched = false;

  const rootsEl = h('div.col', { style: { gap: '4px' } });
  const listEl = h('div.file-list', { style: { maxHeight: '320px' } });
  const status = h('span');
  const relinkBtn = btn('Relink', { cls: 'primary', icon: 'link', disabled: true });

  const paintRoots = () => {
    replace(
      rootsEl,
      h('div.row.dim', icon('folder', 'sm'), h('span.ellipsis.mono', { title: p.dir }, p.dir), h('span.dimmer', '(project folder, and the folder above it)')),
      ...roots.map((r, i) => h('div.row', icon('folder', 'sm'), h('span.ellipsis.mono.grow', { title: r }, r), iconBtn('x', { title: 'Remove', cls: 'ghost sm', onclick: async () => { roots.splice(i, 1); await saveSettings({ searchRoots: roots }); paintRoots(); } }))),
      h('div', btn('Add a folder to search…', { cls: 'sm ghost', icon: 'plus', onclick: async () => { const d = await api.openFolder({ title: 'Search this folder for missing files' }); if (d && !roots.includes(d)) { roots.push(d); await saveSettings({ searchRoots: roots }); paintRoots(); } } })),
    );
  };

  const paintList = () => {
    const rows = missing.map((a) => {
      const cands = results.get(a.id) || [];
      const pick = picks.get(a.id);
      const check = checkbox({ checked: !!pick, onchange: (on) => { if (on && !pick) { const c = cands[0]; if (c) picks.set(a.id, c.path); } else if (!on) picks.delete(a.id); paintList(); } });
      if (!cands.length && !pick) check.querySelector('input').disabled = true;
      const top = cands[0];
      const conf = pick && top && pick === top.path ? (cands.length === 1 || top.score > (cands[1]?.score ?? -1) ? (top.score >= 2 ? 'high' : 'mid') : 'mid') : pick ? 'high' : 'none';
      const confLabel = conf === 'high' ? 'Good match' : conf === 'mid' ? 'Check this' : searched ? 'Not found' : 'Not searched';
      let chooser;
      if (cands.length > 1) {
        chooser = h('select.select', { onchange: (e) => { picks.set(a.id, e.target.value); paintList(); } }, ...cands.map((c) => h('option', { value: c.path, selected: c.path === pick }, `${c.path}  —  ${c.reason}`)));
      } else if (pick) {
        chooser = h('div.mono.ellipsis.grow', { title: pick, style: { color: 'var(--text-2)' } }, pick);
      } else {
        chooser = h('div.grow.dimmer', searched ? 'No file with this name was found in the search folders.' : 'Search or locate it yourself.');
      }
      return h(
        'div.missing-row',
        check,
        h(
          'div',
          { style: { minWidth: 0 } },
          h('div.row', h(`span.dot.${a.status}`), h('span.ellipsis', { style: { color: 'var(--text)', fontWeight: 500 } }, a.name), h('span.grow'), h(`span.conf.${conf}`, confLabel)),
          h('div.mono.ellipsis.dimmer', { title: a.path, style: { marginTop: '2px' } }, a.path),
          h('div.cands', chooser, btn('Locate…', { cls: 'sm', onclick: async () => { const f = await api.locateFile({ title: `Locate “${a.name}”`, defaultPath: dirname(pick || p.filePath), ext: a.ext }); if (f) { if (!cands.find((c) => c.path === f)) results.set(a.id, [{ path: f, score: 99, reason: 'Chosen by you' }, ...cands]); picks.set(a.id, f); paintList(); } } })),
        ),
      );
    });
    replace(listEl, ...rows);
    relinkBtn.disabled = picks.size === 0;
    relinkBtn.lastChild.textContent = picks.size ? `Relink ${plural(picks.size, 'file')}` : 'Relink';
    status.textContent = searched ? `${[...results.values()].filter((c) => c.length).length} of ${missing.length} found` : `${plural(missing.length, 'missing file')}`;
  };

  const search = async () => {
    try {
      const r = await runJob('Searching for missing files', (jobId) => api.findMissing(p.id, { roots, deep: true }, jobId), { icon: 'search' });
      searched = true;
      for (const res of r.results) {
        results.set(res.id, res.candidates);
        const best = res.candidates[0];
        const second = res.candidates[1];
        if (best && (!second || best.score > second.score) && !picks.has(res.id)) picks.set(res.id, best.path);
      }
      if (!r.complete) toast('The search stopped early to save time; add a more specific folder to look deeper.');
      paintList();
    } catch (err) {
      if (!err.cancelled) errorDialog(err.message);
    }
  };

  paintRoots();
  paintList();
  const m = modal({
    title: 'Find missing files',
    subtitle: 'Cargo looks on other drives, near the project, and in folders you add. Your project file is not changed.',
    icon: 'locate',
    tone: 'warn',
    width: 'xwide',
    body: [h('div.field', h('div.label', 'Search in'), rootsEl), h('div.row', btn('Search now', { icon: 'search', cls: 'primary', onclick: search }), h('span.dim', status)), listEl],
    footer: (close) => [h('div.info', 'After relinking, save a relinked copy of the project for After Effects.'), btn('Close', { onclick: () => close(null) }), relinkBtn],
  });
  relinkBtn.addEventListener('click', () => m.close('go'));
  if ((await m.result) !== 'go') return;
  const links = [...picks].map(([assetId, path]) => ({ assetId, path }));
  try {
    const project = await runJob('Relinking', (jobId) => api.relink(p.id, links, jobId), { icon: 'link', delay: 300, cancellable: false });
    applyProjectUpdate(project);
    toast(`Relinked ${plural(links.length, 'file')} in Cargo.`, { tone: 'ok', timeout: 9000, action: { label: 'Save relinked project', onclick: saveRelinked } });
  } catch (err) {
    errorDialog(err.message);
  }
}

// ---------------------------------------------------------------- batch package

export async function batchPackageDialog(ids) {
  const s = state.store.settings;
  const opts = { format: s.packageFormat || 'zip', destDir: s.packageDest || '', includeUnused: !!s.packageIncludeUnused, layout: s.packageLayout || 'type', relink: s.packageRelink !== false, privateMode: s.packagePrivate !== false };
  const total = ids.map((id) => state.projects.get(id)).filter(Boolean).reduce((t, p) => t + (opts.includeUnused ? p.totals.totalSize : p.totals.usedSize), 0);
  const go = btn(`Package ${plural(ids.length, 'project')}`, { cls: 'primary', icon: 'package', disabled: !opts.destDir });
  const m = modal({
    title: 'Package projects',
    subtitle: `Each project gets its own ${opts.format === 'zip' ? 'zip' : 'folder'}: Name_Package_${today()}.`,
    icon: 'package',
    width: 'wide',
    body: [
      h('div.field', h('div.label', 'Format'), seg([['zip', 'Zip files', 'zip'], ['folder', 'Folders', 'folder']], opts.format, (v) => (opts.format = v))),
      folderField('Save to', opts.destDir, (v) => { opts.destDir = v; go.disabled = !v; }),
      h('div.fields-2', h('div.field', h('label', 'Organize files'), select(LAYOUTS.filter(([k]) => k !== 'date'), opts.layout, (v) => (opts.layout = v))), h('div.field', h('div.label', 'Include'), checkbox({ checked: opts.includeUnused, label: 'Unused footage too', onchange: (v) => (opts.includeUnused = v) }))),
      privacyOptions(opts, { withOriginal: false }),
      h('div.dim', `About ${fmtBytes(total)} in total.`),
    ],
    footer: (close) => [h('div.info'), btn('Cancel', { onclick: () => close(null) }), go],
  });
  go.addEventListener('click', () => m.close('go'));
  if ((await m.result) !== 'go') return;
  await saveSettings({ packageFormat: opts.format, packageDest: opts.destDir, packageIncludeUnused: opts.includeUnused, packageLayout: opts.layout, packageRelink: opts.relink, packagePrivate: opts.privateMode });
  try {
    const results = await runJob('Packaging projects', (jobId) => api.batchPackage(ids, opts, jobId), { icon: 'package' });
    await refreshStore();
    const ok = results.filter((r) => r.ok);
    resultDialog({
      title: `${plural(ok.length, 'package')} ready`,
      lines: [`${fmtBytes(ok.reduce((t, r) => t + r.bytes, 0))} in total`],
      output: opts.destDir,
      warnings: results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.error}`),
    });
  } catch (err) {
    if (err.cancelled) toast('Packaging cancelled. Finished packages were kept.');
    else errorDialog(err.message, 'Packaging failed');
  }
}

// ---------------------------------------------------------------- help

export function helpDialog() {
  const legend = ['used', 'missing', 'unused', 'unused-missing', 'generated'].map((s) => h('div.row', h(`span.dot.${s}`), h('span', { style: { color: 'var(--text-2)', minWidth: '110px' } }, STATUS_LABEL[s]), h('span.dim', legendText[s])));
  const keys = [
    ['Ctrl+O', 'Open a project'],
    ['Ctrl+F', 'Search assets'],
    ['Ctrl+R', 'Rescan the project'],
    ['Ctrl+P', 'Package project'],
    ['Ctrl+E', 'Export manifest'],
    ['Ctrl+1…5', 'Switch tabs'],
    ['↑ ↓  Shift', 'Move and extend the selection'],
    ['Enter', 'Open the file'],
    ['Delete', 'Delete the selected files'],
    ['Ctrl+A', 'Select all visible assets'],
  ];
  const status = h('span.dim', '');
  const checkNow = btn('Check for updates', {
    cls: 'sm',
    icon: 'refresh',
    onclick: async () => {
      checkNow.disabled = true;
      status.textContent = 'Checking…';
      try {
        const update = await api.checkUpdate({ manual: true });
        if (update) {
          state.update = update;
          emit('all');
          status.textContent = '';
          m.close();
          updateDialog(update);
        } else {
          status.textContent = 'Cargo is up to date.';
        }
      } catch (err) {
        status.textContent = err.message;
      } finally {
        checkNow.disabled = false;
      }
    },
  });
  const m = modal({
    title: 'Cargo',
    subtitle: `After Effects project scanner & packager · version ${state.info.version}`,
    icon: 'help',
    width: 'wide',
    body: [
      h('div.help-grid',
        h('div', h('h4', 'Status colors'), h('div.col', { style: { gap: '8px' } }, ...legend)),
        h('div', h('h4', 'Keyboard'), h('div.kbd-list', ...keys.flatMap(([k, v]) => [h('kbd', k), h('span', v)]))),
      ),
      h('div.help-grid',
        h('div', h('h4', 'How “used” is decided'), h('ul', h('li', 'An item is used when a layer in any composition uses it.'), h('li', 'Data files referenced by expressions (footage("…")) count as used.'), h('li', 'Solids and placeholders have no file on disk.'))),
        h('div', h('h4', 'Good to know'), h('ul', h('li', 'Cargo never changes your .aep. Packages, archives and relinks write new copies.'), h('li', 'Deleted files go to the Recycle Bin.'), h('li', 'Fonts and plugins are listed but not packaged.'))),
      ),
      h(
        'div',
        h('h4', { style: { margin: '0 0 8px', color: 'var(--text)', fontSize: '12px' } }, 'Updates'),
        h(
          'div.row',
          { style: { gap: '12px', flexWrap: 'wrap' } },
          checkbox({
            checked: state.store.settings.autoUpdate !== false,
            label: 'Check for updates when Cargo starts',
            onchange: async (v) => {
              await refreshStore(await api.setSetting('autoUpdate', v));
            },
          }),
          h('div.grow'),
          status,
          checkNow,
        ),
      ),
    ],
    footer: (close) => [h('div.info', 'MIT licensed · open source'), btn('Cargo on GitHub', { icon: 'external', onclick: () => api.openExternal(state.info.homepage) }), btn('Close', { cls: 'primary', onclick: () => close() })],
  });
}

/** Shows a new version and installs it (or links to it for portable copies). */
export async function updateDialog(update = state.update) {
  if (!update) return;
  const notes = String(update.notes || '')
    .replace(/\r/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .trim();
  const go = update.canInstall ? btn('Download and install', { cls: 'primary', icon: 'export' }) : btn('Open download page', { cls: 'primary', icon: 'external' });
  const m = modal({
    title: `Cargo ${update.version} is available`,
    subtitle: `You have ${state.info.version}.${update.size ? ` The download is ${fmtBytes(update.size)}.` : ''}`,
    icon: 'refresh',
    width: 'wide',
    body: [
      notes ? h('div.file-list.selectable', { style: { maxHeight: '300px', padding: '12px 14px', whiteSpace: 'pre-wrap', lineHeight: 1.55, color: 'var(--text-2)' } }, notes) : null,
      update.canInstall ? h('div.dim', 'Cargo closes while the update installs and opens again when it’s done. Your settings, tags and history stay.') : h('div.dim', 'This copy of Cargo wasn’t installed with the setup, so it can’t update itself. Get the new version from GitHub.'),
    ],
    footer: (close) => [h('div.info'), btn('Later', { onclick: () => close(null) }), go],
  });
  go.addEventListener('click', () => m.close('go'));
  if ((await m.result) !== 'go') return;
  if (!update.canInstall) {
    api.openExternal(update.pageUrl);
    return;
  }
  try {
    await runJob(`Downloading Cargo ${update.version}`, (jobId) => api.downloadUpdate(jobId), { icon: 'export', delay: 0 });
    await api.installUpdate();
  } catch (err) {
    if (!err.cancelled) errorDialog(err.message, 'The update didn’t work');
  }
}

const legendText = {
  used: 'In use and found on disk',
  missing: 'In use, but the file is missing',
  unused: 'Not used in any composition',
  'unused-missing': 'Not used and missing',
  generated: 'Solid, placeholder or unreadable — no file',
};

