// Batch view: many projects at once, with totals and footage shared between them.

import { h, btn, fmtBytes, fmtDate, plural, pct, basename, dirname, checkbox } from '../util.js';
import { icon } from '../icons.js';
import { state, emit } from '../state.js';
import { openMenu, errorDialog, toast } from '../ui.js';
import { showProject, addProjectsToBatch, scanFolder, reveal } from '../actions.js';
import { batchPackageDialog } from '../dialogs.js';

const api = window.cargo;
const selected = new Set();
let sort = { key: 'size', dir: -1 };

const SORTS = [
  ['size:-1', 'Biggest first'],
  ['size:1', 'Smallest first'],
  ['modified:-1', 'Newest first'],
  ['modified:1', 'Oldest first'],
  ['name:1', 'Name A–Z'],
  ['name:-1', 'Name Z–A'],
  ['unused:-1', 'Most unused'],
  ['missing:-1', 'Most missing'],
  ['footage:-1', 'Most footage'],
];

const SORT_VALUE = {
  name: (p) => p.name.toLowerCase(),
  size: (p) => p.totals.totalSize,
  used: (p) => p.totals.usedSize,
  unused: (p) => p.totals.unusedSize,
  missing: (p) => p.totals.missingCount + p.totals.unusedMissingCount,
  footage: (p) => p.totals.fileAssetCount,
  modified: (p) => p.mtime || 0,
};

function exportMenu(anchor, ids) {
  const run = (fmt) => async () => {
    try {
      const out = await api.batchExport(ids, fmt);
      if (out) toast(`Exported ${basename(out)}`, { tone: 'ok', action: { label: 'Show', onclick: () => reveal(out) } });
    } catch (err) {
      errorDialog(err.message, 'Export failed');
    }
  };
  openMenu(
    anchor,
    [
      { header: `Report for ${plural(ids.length, 'project')}` },
      { label: 'PDF', icon: 'file', onclick: run('pdf') },
      { label: 'Spreadsheet (.csv)', icon: 'dashboard', onclick: run('csv') },
      { label: 'Text (.txt)', icon: 'list', onclick: run('txt') },
      { label: 'JSON', icon: 'data', onclick: run('json') },
    ],
    { align: 'right', minWidth: 220 },
  );
}

/** Sizes across projects, counting each file once. A file is reclaimable only if no project uses it. */
function uniqueTotals(projects) {
  const files = new Map();
  for (const p of projects) {
    for (const a of p.assets) {
      if (!a.key || !a.exists) continue;
      const e = files.get(a.key) || { size: a.size, used: false };
      e.used = e.used || a.used;
      files.set(a.key, e);
    }
  }
  let total = 0;
  let used = 0;
  for (const f of files.values()) {
    total += f.size;
    if (f.used) used += f.size;
  }
  return { total, used, unused: total - used };
}

/** Files used by more than one of the scanned projects. */
function sharedFiles(projects) {
  const map = new Map();
  for (const p of projects) {
    for (const a of p.assets) {
      if (!a.key || !a.used || !a.exists) continue;
      let e = map.get(a.key);
      if (!e) map.set(a.key, (e = { key: a.key, name: a.name, path: a.resolvedPath, size: a.size, projects: new Set() }));
      e.projects.add(p.name);
    }
  }
  return [...map.values()].filter((e) => e.projects.size > 1).sort((a, b) => b.size - a.size);
}

function sortedRows() {
  const val = SORT_VALUE[sort.key] || SORT_VALUE.size;
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const ok = [];
  const failed = [];
  for (const b of state.batch) {
    const p = b.ok ? state.projects.get(b.id) : null;
    if (p) ok.push({ b, p });
    else failed.push({ b, p: null });
  }
  ok.sort((x, y) => {
    const a = val(x.p);
    const c = val(y.p);
    const d = typeof a === 'string' ? collator.compare(a, c) : a - c;
    return d * sort.dir || collator.compare(x.p.name, y.p.name);
  });
  return [...ok, ...failed];
}

function header(label, key, cls = '') {
  const on = sort.key === key;
  return h(
    `th${cls ? '.' + cls : ''}`,
    {
      style: { cursor: 'pointer', color: on ? 'var(--text)' : undefined },
      title: `Sort by ${label.toLowerCase()}`,
      onclick: () => {
        sort = { key, dir: on ? -sort.dir : key === 'name' ? 1 : -1 };
        emit('content');
      },
    },
    label,
    on ? h('span', { style: { marginLeft: '4px' } }, sort.dir > 0 ? '↑' : '↓') : null,
  );
}

export function renderBatch() {
  const ok = state.batch.filter((b) => b.ok).map((b) => state.projects.get(b.id)).filter(Boolean);
  for (const id of [...selected]) if (!state.projects.has(id)) selected.delete(id);
  const ids = selected.size ? [...selected] : ok.map((p) => p.id);
  const sum = (k) => ok.reduce((t, p) => t + p.totals[k], 0);
  const { total, used, unused } = uniqueTotals(ok);
  const shared = sharedFiles(ok);

  const sortSelect = h(
    'select.select',
    {
      title: 'Sort projects',
      onchange: (e) => {
        const [key, dir] = e.target.value.split(':');
        sort = { key, dir: Number(dir) };
        emit('content');
      },
    },
    ...SORTS.map(([v, label]) => h('option', { value: v, selected: v === `${sort.key}:${sort.dir}` }, label)),
    SORTS.some(([v]) => v === `${sort.key}:${sort.dir}`) ? null : h('option', { value: `${sort.key}:${sort.dir}`, selected: true }, 'Custom'),
  );

  const head = h(
    'div.toolbar',
    btn('Add projects…', { icon: 'plus', onclick: addProjectsToBatch }),
    btn('Scan a folder…', { icon: 'folder', onclick: () => scanFolder() }),
    h('div.row', { style: { gap: '6px', marginLeft: '8px' } }, icon('sort', 'sm'), sortSelect),
    h('div.grow'),
    h('span.result-count', selected.size ? `${selected.size} selected` : `${plural(ok.length, 'project')}`),
    h('button.btn', { type: 'button', onclick: (e) => exportMenu(e.currentTarget, ids), disabled: !ids.length }, icon('export'), h('span', 'Export report'), icon('chevronDown', 'sm')),
    btn(selected.size ? `Package ${selected.size}…` : 'Package all…', { cls: 'primary', icon: 'package', disabled: !ids.length, onclick: () => batchPackageDialog(ids) }),
    btn('Clear', {
      cls: 'ghost',
      onclick: () => {
        for (const b of state.batch) if (b.id && (!state.project || state.project.id !== b.id)) api.close(b.id).catch(() => {});
        state.batch = [];
        state.projects.clear();
        selected.clear();
        state.mode = state.project ? 'project' : 'welcome';
        state.fromBatch = false;
        emit('all');
      },
    }),
  );

  const cards = h(
    'div.cards',
    h('div.card.kpi', h('div.label', icon('batch', 'sm'), 'Projects'), h('div.value', String(ok.length)), h('div.sub', `${plural(sum('fileAssetCount'), 'footage item')}`)),
    h('div.card.kpi', h('div.label', icon('drive', 'sm'), 'Total on disk'), h('div.value', fmtBytes(total)), h('div.sub', `${fmtBytes(used)} used · shared files counted once`)),
    h('div.card.kpi.accent', h('div.label', icon('trash', 'sm'), 'Reclaimable'), h('div.value', fmtBytes(unused)), h('div.sub', `${pct(unused, total).toFixed(0)}% not used by any of these projects`)),
    h(`div.card.kpi${sum('missingCount') ? '.warn' : ''}`, h('div.label', icon('alert', 'sm'), 'Missing'), h('div.value', String(sum('missingCount') + sum('unusedMissingCount'))), h('div.sub', 'files across all projects')),
  );

  const allSel = ok.length > 0 && ok.every((p) => selected.has(p.id));
  const rows = sortedRows().map(({ b, p }) => {
    if (!p) {
      return h('tr', h('td'), h('td', h('div.strong', basename(b.path)), h('div.mono.dimmer', b.path)), h('td', { colSpan: 8 }, h('span.pill.unused', icon('alert', 'sm'), b.error || 'Could not be read')));
    }
    const t = p.totals;
    return h(
      'tr',
      { style: { cursor: 'pointer' }, ondblclick: () => showProject(p.id) },
      h('td', checkbox({ checked: selected.has(p.id), onchange: (on) => { if (on) selected.add(p.id); else selected.delete(p.id); emit('content'); } })),
      h('td', { onclick: () => showProject(p.id) }, h('div.strong.row', { style: { gap: '7px' } }, h(`span.app-badge.${p.format}`, p.format === 'flp' ? 'FL' : 'AE'), p.name), h('div.mono.dimmer.ellipsis', { style: { maxWidth: '380px' }, title: p.filePath }, dirname(p.filePath))),
      h('td.dim', { style: { whiteSpace: 'nowrap' }, title: p.mtime ? fmtDate(p.mtime) : '' }, p.mtime ? fmtDate(p.mtime, false) : ''),
      h('td.r.num', String(t.fileAssetCount)),
      h('td.r.num', t.missingCount + t.unusedMissingCount ? h('span', { style: { color: 'var(--warn)' } }, String(t.missingCount + t.unusedMissingCount)) : '0'),
      h('td.r.num', fmtBytes(t.totalSize)),
      h('td.r.num', fmtBytes(t.usedSize)),
      h('td.r.num', { style: { color: t.unusedSize ? '#ff8080' : undefined } }, fmtBytes(t.unusedSize)),
      h('td', h('div.mini-bar', { style: { width: '90px' } }, h('span.u', { style: { width: `${pct(t.usedSize, t.totalSize)}%` } }), h('span.x', { style: { width: `${pct(t.unusedSize, t.totalSize)}%` } }))),
      h('td', btn('Open', { cls: 'sm', onclick: () => showProject(p.id) })),
    );
  });

  const table = h(
    'div.card',
    { style: { padding: 0, overflow: 'hidden' } },
    h(
      'table.simple-table',
      h(
        'thead',
        h(
          'tr',
          h('th', { style: { width: '34px' } }, checkbox({ checked: allSel, indeterminate: selected.size > 0 && !allSel, onchange: (on) => { selected.clear(); if (on) ok.forEach((p) => selected.add(p.id)); emit('content'); } })),
          header('Project', 'name'),
          header('Modified', 'modified'),
          header('Footage', 'footage', 'r'),
          header('Missing', 'missing', 'r'),
          header('Total', 'size', 'r'),
          header('Used', 'used', 'r'),
          header('Unused', 'unused', 'r'),
          h('th', ''),
          h('th', ''),
        ),
      ),
      h('tbody', ...rows),
    ),
  );

  const sharedCard = shared.length
    ? h(
        'div.card',
        h('h3', 'Footage shared between projects', h('span.dim', `${plural(shared.length, 'file')} · protected from deleting while these projects are open`)),
        h(
          'div.list-rows',
          ...shared.slice(0, 12).map((s) => h('div.list-row', { title: s.path, onclick: () => reveal(s.path) }, icon('link', 'sm'), h('span.ellipsis.grow', { style: { color: 'var(--text-2)' } }, s.name), h('span.dim.ellipsis', { style: { maxWidth: '320px' } }, [...s.projects].join(', ')), h('span.size', fmtBytes(s.size)))),
        ),
      )
    : null;

  const body = state.batch.length
    ? [cards, table, sharedCard]
    : [h('div.empty-note', 'Add projects or scan a folder to compare several projects at once.')];
  return h('div.col', { style: { flex: 1, minHeight: 0 } }, head, h('div.pane', h('div.pane-inner', ...body)));
}
