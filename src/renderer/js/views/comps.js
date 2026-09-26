// Composition dependency tree: what every comp pulls in, down to the files.

import { h, btn, fmtBytes, fmtDuration, fmtFps, plural } from '../util.js';
import { icon, CATEGORY_ICONS } from '../icons.js';
import { state, emit, compById, compDependencies } from '../state.js';
import { filterByComp, focusAsset } from '../actions.js';
import { packageDialog } from '../dialogs.js';

export function renderComps() {
  const p = state.project;
  if (!p.comps.length) {
    return h('div.pane', h('div.pane-inner', h('div.empty-note', 'This project has no compositions.')));
  }
  const roots = p.comps.filter((c) => c.usedIn.length === 0).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  // Comps only reachable through cycles would otherwise never show up.
  const reachable = new Set();
  for (const r of roots) for (const id of compDependencies(r.id).comps) reachable.add(id);
  const orphans = p.comps.filter((c) => !reachable.has(c.id));
  if (state.compFocus === null && roots[0]) state.compFocus = roots[0].id;
  if (state.compFocus !== null) revealPath(state.compFocus);

  const left = h(
    'div.split-left.dep-tree',
    h('div.side-title', { style: { padding: '4px 8px 8px' } }, h('span', 'Top-level compositions'), h('span', { style: { textTransform: 'none', letterSpacing: 0, fontWeight: 400 } }, `${roots.length} of ${p.comps.length}`)),
    ...roots.flatMap((c) => compNode(c, 0, new Set())),
    orphans.length ? h('div.side-title', { style: { padding: '14px 8px 8px' } }, 'Only used by each other') : null,
    ...orphans.flatMap((c) => compNode(c, 0, new Set())),
  );
  const right = h('div.split-right', details(compById(state.compFocus)));
  return h('div.split', left, right);
}

/** Expands every parent of `id` so it is visible in the tree. */
function revealPath(id) {
  const seen = new Set();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    const c = compById(cur);
    if (!c) continue;
    for (const parent of c.usedIn) {
      state.compExpanded.add(parent);
      stack.push(parent);
    }
  }
}

function compNode(c, depth, ancestors) {
  const p = state.project;
  const open = state.compExpanded.has(c.id);
  const cyclic = ancestors.has(c.id);
  const rows = [
    h(
      `div.tree-row.comp${open ? '.open' : ''}${state.compFocus === c.id ? '.on' : ''}`,
      {
        style: { paddingLeft: `${depth * 16 + 4}px` },
        onclick: () => {
          state.compFocus = c.id;
          emit('content');
        },
        ondblclick: () => filterByComp(c.id),
      },
      h(
        'button.twist',
        {
          type: 'button',
          disabled: cyclic || !c.sources.length,
          style: { visibility: c.sources.length && !cyclic ? 'visible' : 'hidden' },
          onclick: (e) => {
            e.stopPropagation();
            if (open) state.compExpanded.delete(c.id);
            else state.compExpanded.add(c.id);
            emit('content');
          },
        },
        icon('chevronRight', 'sm'),
      ),
      icon('comp'),
      h('span.label', c.name),
      h('span.size', `${c.layerCount} layers`),
    ),
  ];
  if (!open || cyclic) return rows;
  const next = new Set(ancestors).add(c.id);
  const assetsById = new Map(p.assets.map((a) => [a.id, a]));
  const children = c.sources
    .map((s) => ({ s, comp: compById(s.id), asset: assetsById.get(s.id) }))
    .sort((a, b) => Number(!!b.comp) - Number(!!a.comp) || (a.comp || a.asset || { name: '' }).name.localeCompare((b.comp || b.asset || { name: '' }).name));
  for (const { s, comp, asset } of children) {
    if (comp) rows.push(...compNode(comp, depth + 1, next));
    else if (asset) {
      rows.push(
        h(
          'div.tree-row',
          { style: { paddingLeft: `${(depth + 1) * 16 + 22}px` }, onclick: () => focusAsset(asset.id), title: asset.resolvedPath || asset.name },
          h(`span.dot.${asset.status}`, { style: { margin: '0 4px' } }),
          icon(CATEGORY_ICONS[asset.category] || 'file', 'sm'),
          h('span.label', asset.name),
          s.count > 1 ? h('span.size', `×${s.count}`) : null,
          h('span.size', asset.exists ? fmtBytes(asset.size) : asset.kind === 'file' ? 'missing' : ''),
        ),
      );
    }
  }
  return rows;
}

function details(c) {
  if (!c) return h('div.preview-empty', icon('comp'), h('div', 'Select a composition'));
  const p = state.project;
  const { footage, comps } = compDependencies(c.id);
  const assets = p.assets.filter((a) => footage.has(a.id));
  const files = assets.filter((a) => a.kind === 'file');
  const size = files.reduce((t, a) => t + (a.exists ? a.size : 0), 0);
  const missing = files.filter((a) => !a.exists);
  const parents = c.usedIn.map(compById).filter(Boolean);
  const effects = new Map();
  for (const id of comps) {
    const cc = compById(id);
    if (!cc) continue;
    for (const l of cc.layers) for (const e of l.effects) effects.set(e, (effects.get(e) || 0) + 1);
  }
  const effectInfo = new Map(p.effects.map((e) => [e.matchName, e]));
  const thirdParty = [...effects.keys()].filter((mn) => effectInfo.get(mn) && !effectInfo.get(mn).builtIn);

  return h(
    'div.col',
    { style: { gap: '16px', maxWidth: '760px' } },
    h('div', h('div.preview-title', { style: { fontSize: '18px' } }, c.name), h('div.dim', { style: { marginTop: '4px' } }, [c.width && c.height ? `${c.width}×${c.height}` : null, c.fps ? fmtFps(c.fps) : null, c.duration ? fmtDuration(c.duration) : null, plural(c.layerCount, 'layer')].filter(Boolean).join(' · '))),
    h(
      'div.cards',
      { style: { gridTemplateColumns: 'repeat(3, minmax(0,1fr))' } },
      h('div.card.kpi', h('div.label', 'Footage it needs'), h('div.value', fmtBytes(size)), h('div.sub', plural(files.length, 'file'))),
      h('div.card.kpi', h('div.label', 'Nested comps'), h('div.value', String(comps.size - 1)), h('div.sub', 'including deeper levels')),
      h(`div.card.kpi${missing.length ? '.warn' : ''}`, h('div.label', 'Missing'), h('div.value', String(missing.length)), h('div.sub', missing.length ? 'files not found' : 'all files found')),
    ),
    h('div.row', btn('Show its footage', { icon: 'list', onclick: () => filterByComp(c.id) }), btn('Package this comp…', { cls: 'primary', icon: 'package', onclick: () => packageDialog({ assetIds: [...footage], title: c.name }) })),
    thirdParty.length ? h('div.notice.info', icon('plug'), h('div', h('b', 'Needs plugins: '), thirdParty.map((mn) => effectInfo.get(mn).displayName).join(', '))) : null,
    parents.length
      ? h('div', h('div.preview-section-title', 'Used in'), h('div.link-list', ...parents.map((pc) => h('button.link-item', { type: 'button', onclick: () => { state.compFocus = pc.id; emit('content'); } }, icon('comp', 'sm'), pc.name))))
      : h('div.dimmer', 'Top-level composition — no other comp uses it.'),
    h(
      'div',
      h('div.preview-section-title', 'Layers'),
      h(
        'table.simple-table',
        h('thead', h('tr', h('th', '#'), h('th', 'Layer'), h('th', 'Source'), h('th', 'Effects'))),
        h(
          'tbody',
          ...c.layers.slice(0, 300).map((l) => {
            const src = l.sourceId ? compById(l.sourceId) || p.assets.find((a) => a.id === l.sourceId) : null;
            return h(
              'tr',
              h('td.dim', String(l.index)),
              h('td.strong', l.name || (src ? src.name : '—')),
              h('td', src ? h('span.row', icon(src.layerCount !== undefined ? 'comp' : CATEGORY_ICONS[src.category] || 'file', 'sm'), h('span.ellipsis', src.name)) : h('span.dimmer', 'Text, shape, camera or light')),
              h('td.dim', l.effects.map((mn) => (effectInfo.get(mn) || { displayName: mn }).displayName).join(', ')),
            );
          }),
        ),
      ),
    ),
  );
}

