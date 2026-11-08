// Insights dashboard: sizes, savings, transfer estimates, breakdowns.

import { h, btn, fmtBytes, fmtTime, pct, plural, CATEGORY_PLURAL, CATEGORY_COLORS } from '../util.js';
import { icon, CATEGORY_ICONS } from '../icons.js';
import { state, emit, invalidate, compDependencies, labels, appName } from '../state.js';
import { focusAsset, filterByComp } from '../actions.js';
import { deleteUnusedDialog, missingDialog, packageDialog } from '../dialogs.js';

// Rough real-world throughput, bytes per second.
const SPEEDS = [
  ['USB 3 drive', 120 * 1024 * 1024],
  ['1 Gbit network', 100 * 1024 * 1024],
  ['100 Mbit upload', 11 * 1024 * 1024],
  ['20 Mbit upload', 2.3 * 1024 * 1024],
];

function kpi(label, value, sub, { cls = '', ic } = {}) {
  return h(`div.card.kpi${cls ? '.' + cls : ''}`, h('div.label', ic ? icon(ic, 'sm') : null, label), h('div.value', value), sub ? h('div.sub', sub) : null);
}

export function renderInsights() {
  const p = state.project;
  const t = p.totals;
  const files = p.assets.filter((a) => a.kind === 'file');
  const missing = files.filter((a) => !a.exists);
  const usedMissing = missing.filter((a) => a.used);
  const thirdParty = p.effects.filter((e) => !e.builtIn && e.count > 0);
  const deadPct = pct(t.unusedSize, t.totalSize);

  const cards = h(
    'div.cards',
    kpi('Total on disk', fmtBytes(t.totalSize), `${plural(t.fileCount, 'file')} · project file ${fmtBytes(p.fileSize)}`, { ic: 'drive' }),
    kpi('Used', fmtBytes(t.usedSize), `${plural(t.usedCount, 'item')} in ${plural(p.comps.filter((c) => c.kind !== 'arrangement').length, labels().comp.toLowerCase())}`, { ic: 'checkCircle' }),
    kpi('Reclaimable', fmtBytes(t.unusedSize), t.unusedSize ? `${deadPct.toFixed(0)}% of the project is dead weight` : 'Nothing unused — nice', { cls: 'accent', ic: 'trash' }),
    kpi('Missing', String(missing.length), missing.length ? `${usedMissing.length} used by the project` : 'Every file was found', { ic: 'alert', cls: missing.length ? 'warn' : '' }),
  );

  // Before / after
  const max = Math.max(1, t.totalSize);
  const compareRow = (label, value, segments) =>
    h('div.compare-row', h('div.top', h('span.dim', label), h('b', fmtBytes(value))), h('div.compare-bar', ...segments.map(([v, color, op]) => h('span', { style: { width: `${pct(v, max)}%`, background: color, opacity: op ?? 1 } }))));
  const compare = h(
    'div.card',
    h('h3', 'Before and after cleanup', t.unusedSize ? h('span.dim', `saves ${fmtBytes(t.unusedSize)}`) : null),
    h(
      'div.compare',
      compareRow('Now', t.totalSize, [[t.usedSize, 'var(--text)'], [t.unusedSize, 'var(--bad)', 0.8]]),
      compareRow('After deleting unused', t.usedSize, [[t.usedSize, 'var(--text)']]),
      compareRow('Package (used files only)', t.usedSize + p.fileSize, [[t.usedSize + p.fileSize, 'var(--accent)']]),
    ),
    h('div.legend', { style: { marginTop: '14px' } }, h('span', h('i', { style: { background: 'var(--text)' } }), 'Used'), h('span', h('i', { style: { background: 'var(--bad)' } }), 'Unused'), h('span', h('i', { style: { background: 'var(--accent)' } }), 'Package')),
    t.unusedSize ? h('div', { style: { marginTop: '14px' } }, btn('Delete unused…', { cls: 'danger sm', icon: 'trash', onclick: deleteUnusedDialog })) : null,
  );

  const transfer = h(
    'div.card',
    h('h3', 'Time to hand off', h('span.dim', 'estimate')),
    h(
      'div.speed-table',
      h('div.h', 'Connection'),
      h('div.h', { style: { textAlign: 'right' } }, 'Everything'),
      h('div.h', { style: { textAlign: 'right' } }, 'Used only'),
      ...SPEEDS.flatMap(([label, speed]) => [h('div.dim', label), h('div.v', fmtTime(t.totalSize / speed)), h('div.v', { style: { color: 'var(--accent)' } }, fmtTime(t.usedSize / speed))]),
      h('div.dim', 'Zipping (no compression)'),
      h('div.v', fmtTime(t.totalSize / (220 * 1024 * 1024))),
      h('div.v', { style: { color: 'var(--accent)' } }, fmtTime(t.usedSize / (220 * 1024 * 1024))),
    ),
    h('div', { style: { marginTop: '14px' } }, btn('Package project…', { cls: 'primary sm', icon: 'package', onclick: () => packageDialog() })),
  );

  // Categories
  const cats = Object.entries(t.byCategory)
    .filter(([c]) => c !== 'solid')
    .sort((a, b) => b[1].size - a[1].size || b[1].count - a[1].count);
  const catMax = Math.max(1, ...cats.map(([, v]) => v.size));
  const categories = h(
    'div.card',
    h('h3', 'By type', h('span.dim', 'size · count')),
    cats.length
      ? h(
          'div.bars',
          ...cats.map(([c, v]) =>
            h(
              'div.bar-row',
              {
                style: { cursor: 'pointer' },
                title: `Show ${CATEGORY_PLURAL[c] || c}`,
                onclick: () => {
                  state.filter = { ...state.filter, library: c, status: null, folderId: null, compId: null };
                  state.tab = 'assets';
                  invalidate();
                  emit('all');
                },
              },
              h('div.l', icon(CATEGORY_ICONS[c] || 'file', 'sm'), CATEGORY_PLURAL[c] || c),
              h('div.track', h('span', { style: { width: `${pct(v.size, catMax)}%`, background: CATEGORY_COLORS[c] || '#888' } })),
              h('div.n', fmtBytes(v.size)),
              h('div.c', String(v.count)),
            ),
          ),
        )
      : h('div.dim', 'No footage.'),
  );

  const largest = [...files].filter((a) => a.exists).sort((a, b) => b.size - a.size).slice(0, 10);
  const top = h(
    'div.card',
    h('h3', 'Largest files', h('span.dim', 'click to show')),
    largest.length
      ? h(
          'div.list-rows',
          ...largest.map((a, i) =>
            h(
              'div.list-row',
              { onclick: () => focusAsset(a.id), title: a.resolvedPath },
              h('span.rank', String(i + 1)),
              h(`span.dot.${a.status}`),
              h('span.ellipsis.grow', { style: { color: 'var(--text-2)' } }, a.name),
              h('span.size', fmtBytes(a.size)),
            ),
          ),
        )
      : h('div.dim', 'No files found on disk.'),
  );

  // Heaviest top-level comps
  const assetsById = new Map(p.assets.map((a) => [a.id, a]));
  const roots = p.comps.filter((c) => c.usedIn.length === 0);
  const compSizes = roots
    .map((c) => {
      const { footage } = compDependencies(c.id);
      let size = 0;
      for (const id of footage) {
        const a = assetsById.get(id);
        if (a && a.exists) size += a.size;
      }
      return { c, size, count: footage.size };
    })
    .sort((a, b) => b.size - a.size)
    .slice(0, 8);
  const compMax = Math.max(1, ...compSizes.map((x) => x.size));
  const comps = h(
    'div.card',
    h('h3', p.format === 'flp' ? 'Playlist and patterns' : 'Top-level compositions', h('span.dim', 'files they use')),
    compSizes.length
      ? h(
          'div.bars',
          ...compSizes.map(({ c, size, count }) =>
            h(
              'div.bar-row',
              { style: { cursor: 'pointer', gridTemplateColumns: '150px 1fr 72px 36px' }, onclick: () => filterByComp(c.id), title: `Show the ${count} files “${c.name}” uses` },
              h('div.l.ellipsis', icon('comp', 'sm'), h('span.ellipsis', c.name)),
              h('div.track', h('span', { style: { width: `${pct(size, compMax)}%`, background: 'var(--accent)' } })),
              h('div.n', fmtBytes(size)),
              h('div.c', String(count)),
            ),
          ),
        )
      : h('div.dim', `No ${labels().comps.toLowerCase()}.`),
  );

  const notices = [];
  if (usedMissing.length) notices.push(h('div.notice.warn', icon('alert'), h('div.grow', h('b', `${plural(usedMissing.length, 'used file')} ${usedMissing.length === 1 ? 'is' : 'are'} missing.`), ` Packages won’t include them and ${appName()} won’t find them.`), btn('Find missing…', { cls: 'sm', onclick: missingDialog })));
  if (thirdParty.length) notices.push(h('div.notice.info', icon('plug'), h('div', h('b', `${plural(thirdParty.length, p.format === 'flp' ? 'VST plugin' : 'third-party effect')}: `), thirdParty.map((e) => e.displayName).join(', '), '. Whoever opens this project needs these plugins.')));
  if (t.placeholderCount) notices.push(h('div.notice.warn', icon('placeholder'), h('div', h('b', `${plural(t.placeholderCount, 'placeholder')}`), ' stand in for footage that was never found.')));
  for (const w of p.warnings) notices.push(h('div.notice.warn', icon('alert'), h('div', w)));
  if (!notices.length) notices.push(h('div.notice.ok', icon('checkCircle'), h('div', h('b', 'Healthy project. '), 'Every used file was found and no third-party plugins are needed.')));

  return h('div.pane', h('div.pane-inner', ...notices, cards, h('div.grid-2', compare, transfer), h('div.grid-3', categories, top, comps)));
}
