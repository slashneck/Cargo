// Left sidebar: type filters, status filters, tags, the project panel tree and stats.

import { h, fmtBytes, pct, plural, CATEGORY_PLURAL } from '../util.js';
import { icon, CATEGORY_ICONS } from '../icons.js';
import { state, emit, invalidate, tagsFor, isFavorite, folderDescendants } from '../state.js';

const CATEGORY_ORDER = ['video', 'audio', 'image', 'sequence', 'graphics', 'data', '3d', 'project', 'other', 'placeholder', 'solid'];

function setFilter(patch) {
  state.filter = { ...state.filter, ...patch };
  state.tab = 'assets';
  invalidate();
  emit('all');
}

function item({ label, ic, count, on, onclick, dot, title }) {
  return h(
    `button.side-item${on ? '.on' : ''}`,
    { type: 'button', onclick, title: title || label },
    dot ? h(`span.dot.${dot}`) : icon(ic),
    h('span.label', label),
    count !== undefined ? h('span.count', String(count)) : null,
  );
}

export function renderSidebar() {
  const p = state.project;
  const f = state.filter;
  const t = p.totals;
  const counts = {};
  for (const a of p.assets) counts[a.category] = (counts[a.category] || 0) + 1;
  const allCount = p.assets.filter((a) => state.store.settings.showGenerated || a.kind !== 'solid').length;

  const library = h(
    'div.side-group',
    h('div.side-title', 'Library'),
    item({ label: 'All assets', ic: 'all', count: allCount, on: f.library === 'all' && !f.folderId && !f.compId, onclick: () => setFilter({ library: 'all', folderId: null, compId: null }) }),
    ...CATEGORY_ORDER.filter((c) => counts[c]).map((c) => item({ label: CATEGORY_PLURAL[c], ic: CATEGORY_ICONS[c], count: counts[c], on: f.library === c, onclick: () => setFilter({ library: f.library === c ? 'all' : c }) })),
  );

  const files = p.assets.filter((a) => a.kind === 'file');
  const favCount = p.assets.filter(isFavorite).length;
  const tagCounts = new Map();
  for (const a of p.assets) for (const tg of tagsFor(a)) tagCounts.set(tg, (tagCounts.get(tg) || 0) + 1);
  const missingCount = files.filter((a) => !a.exists).length + (t.placeholderCount || 0);
  const status = h(
    'div.side-group',
    h('div.side-title', 'Status'),
    item({ label: 'Used', dot: 'used', count: files.filter((a) => a.used).length, on: f.status === 'used', onclick: () => setFilter({ status: f.status === 'used' ? null : 'used' }), title: 'Used in at least one composition' }),
    item({ label: 'Unused', dot: 'unused', count: files.filter((a) => !a.used).length, on: f.status === 'unused', onclick: () => setFilter({ status: f.status === 'unused' ? null : 'unused' }), title: 'Not used in any composition' }),
    item({ label: 'Missing', dot: 'missing', count: missingCount, on: f.status === 'missing', onclick: () => setFilter({ status: f.status === 'missing' ? null : 'missing' }), title: 'File not found on disk' }),
    item({ label: 'Favorites', ic: 'star', count: favCount, on: f.status === 'favorites', onclick: () => setFilter({ status: f.status === 'favorites' ? null : 'favorites' }) }),
    ...[...tagCounts].sort((a, b) => b[1] - a[1]).map(([tg, n]) => item({ label: tg, ic: 'tag', count: n, on: f.status === `tag:${tg}`, onclick: () => setFilter({ status: f.status === `tag:${tg}` ? null : `tag:${tg}` }) })),
  );

  const tree = h('div.side-group', h('div.side-title', h('span', 'Project'), h('span', { style: { textTransform: 'none', letterSpacing: 0, fontWeight: 400 } }, plural(p.comps.length, 'comp'))), h('div.tree', ...treeNodes(p, 0, 0)));

  const usedPct = pct(t.usedSize, t.totalSize);
  const stats = h(
    'div.side-stats',
    h('div.stack-bar', { title: `${fmtBytes(t.usedSize)} used · ${fmtBytes(t.unusedSize)} unused` }, h('span', { style: { width: `${usedPct}%`, background: 'var(--text)' } }), h('span', { style: { width: `${100 - usedPct}%`, background: 'var(--bad)', opacity: 0.75 } })),
    h(
      'div.stat-lines',
      h('div.k', h('span.dot.used'), 'Used'),
      h('div.v', fmtBytes(t.usedSize)),
      h('div.k', h('span.dot.unused'), 'Unused'),
      h('div.v', fmtBytes(t.unusedSize)),
      h('div.k', icon('drive', 'sm'), 'On disk'),
      h('div.v', `${fmtBytes(t.totalSize)}`),
      h('div.k', icon('all', 'sm'), 'Assets'),
      h('div.v', `${t.fileAssetCount}`),
    ),
  );

  return [h('div.sidebar-scroll', library, status, tree), stats];
}

function treeNodes(p, parentId, depth) {
  const f = state.filter;
  const nodes = [];
  const folders = p.folders.filter((x) => x.parentId === parentId).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const comps = p.comps.filter((x) => x.parentId === parentId).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  for (const folder of folders) {
    const key = `f${folder.id}`;
    const open = state.expanded.has(key);
    const ids = folderDescendants(folder.id);
    const count = p.assets.filter((a) => ids.has(a.parentId) && (state.store.settings.showGenerated || a.kind !== 'solid')).length;
    const row = h(
      `div.tree-row${open ? '.open' : ''}${f.folderId === folder.id ? '.on' : ''}`,
      { style: { paddingLeft: `${depth * 14 + 2}px` }, title: folder.path, onclick: () => setFilter({ folderId: f.folderId === folder.id ? null : folder.id, compId: null }) },
      h(
        'button.twist',
        {
          type: 'button',
          onclick: (e) => {
            e.stopPropagation();
            if (open) state.expanded.delete(key);
            else state.expanded.add(key);
            emit('sidebar');
          },
        },
        icon('chevronRight', 'sm'),
      ),
      icon(open ? 'folderOpen' : 'folder'),
      h('span.label', folder.name || 'Untitled folder'),
      count ? h('span.count', String(count)) : null,
    );
    nodes.push(row);
    if (open) nodes.push(...treeNodes(p, folder.id, depth + 1));
  }
  for (const comp of comps) {
    nodes.push(
      h(
        `div.tree-row.comp${f.compId === comp.id ? '.on' : ''}`,
        {
          style: { paddingLeft: `${depth * 14 + 18}px` },
          title: `${comp.name}\nClick to show the footage this composition uses`,
          onclick: () => setFilter({ compId: f.compId === comp.id ? null : comp.id, folderId: null }),
        },
        icon('comp'),
        h('span.label', comp.name),
        comp.usedIn.length === 0 ? h('span.count', { title: 'Top-level composition' }, '●') : null,
      ),
    );
  }
  return nodes;
}
