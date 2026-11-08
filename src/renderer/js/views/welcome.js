// Start screen: drop zone, recent projects and package history.

import { h, btn, iconBtn, fmtBytes, fmtRelative, plural, pct, basename } from '../util.js';
import { icon, logo } from '../icons.js';
import { state } from '../state.js';
import { chooseAndOpen, openProject, scanFolder, refreshStore, reveal } from '../actions.js';
import { emit } from '../state.js';

const api = window.cargo;

const HISTORY_ICONS = { zip: 'zip', folder: 'folder', archive: 'archive', organize: 'organize', 'organize-move': 'organize', cleanup: 'trash' };
const HISTORY_LABELS = { zip: 'Zip package', folder: 'Folder package', archive: 'Archive', organize: 'Organized (copy)', 'organize-move': 'Organized (move)', cleanup: 'Deleted unused' };

export function renderWelcome() {
  const { recent, packages } = state.store;
  return h(
    'div.welcome',
    h(
      'div.welcome-inner',
      h(
        'div.dropzone',
        { onclick: (e) => { if (!e.target.closest('button')) chooseAndOpen(); } },
        h('div.mark', logo()),
        h('h1', 'Drop a project'),
        h('p', 'Cargo reads After Effects (.aep, .aepx) and FL Studio (.flp) projects without opening them, shows every file they use, and packages, archives or cleans them up.'),
        h('div.actions', btn('Open Project', { cls: 'primary lg', icon: 'open', onclick: chooseAndOpen, kbd: 'Ctrl+O' }), btn('Scan a Folder…', { cls: 'lg', icon: 'batch', onclick: () => scanFolder() })),
      ),
      h(
        'section',
        h('div.section-title', h('span', 'Recent projects'), recent.length ? btn('Clear', { cls: 'ghost sm', onclick: async () => { await refreshStore(await api.clearRecent()); emit('all'); } }) : null),
        recent.length
          ? h('div.recent-grid', ...recent.slice(0, 9).map(recentCard))
          : h('div.empty-note', 'Projects you scan show up here.'),
      ),
      packages.length
        ? h(
            'section',
            h('div.section-title', h('span', 'History'), btn('Clear', { cls: 'ghost sm', onclick: async () => { await refreshStore(await api.clearHistory()); emit('all'); } })),
            h('div.history', ...packages.slice(0, 8).map(historyRow)),
          )
        : null,
    ),
  );
}

function appBadge(file) {
  const ext = (/\.([a-z]+)$/i.exec(file || '') || ['', ''])[1].toLowerCase();
  return h(`span.app-badge.${ext}`, ext === 'flp' ? 'FL' : 'AE');
}

function recentCard(r) {
  const t = r.totals || {};
  const total = t.totalSize || 0;
  return h(
    'button.recent-card',
    { type: 'button', onclick: () => openProject(r.path), title: r.path },
    h('div.name.ellipsis', appBadge(r.path), ' ', r.name),
    h('div.path.ellipsis', r.path),
    h('div.mini-bar', h('span.u', { style: { width: `${pct(t.usedSize, total)}%` } }), h('span.x', { style: { width: `${pct(t.unusedSize, total)}%` } })),
    h(
      'div.meta',
      h('span', fmtBytes(total)),
      h('span', plural(t.assetCount || 0, 'item')),
      t.missingCount ? h('span', { style: { color: 'var(--warn)' } }, `${t.missingCount} missing`) : null,
      h('span.grow'),
      h('span.dimmer', fmtRelative(r.lastScan)),
    ),
    h(
      'span.remove',
      iconBtn('x', {
        title: 'Remove from recent',
        cls: 'ghost sm',
        onclick: async (e) => {
          e.stopPropagation();
          await refreshStore(await api.removeRecent(r.path));
          emit('all');
        },
      }),
    ),
  );
}

function historyRow(p) {
  const canShow = p.output && p.output !== 'Recycle Bin';
  return h(
    'div.history-row',
    icon(HISTORY_ICONS[p.kind] || 'package'),
    h('div.name.ellipsis', p.project),
    h('div.ellipsis.mono', { title: p.output }, p.output === 'Recycle Bin' ? 'Recycle Bin' : basename(p.output || '')),
    h('div.num', fmtBytes(p.bytes || 0)),
    h('div.dimmer', `${HISTORY_LABELS[p.kind] || p.kind} · ${fmtRelative(p.date)}`),
    canShow ? iconBtn('reveal', { title: 'Show in folder', cls: 'ghost sm', onclick: () => reveal(p.output) }) : h('span'),
  );
}

export function renderScanning() {
  const p = state.scanProgress || {};
  const frac = p.total ? p.done / p.total : null;
  return h(
    'div.scan-screen',
    h(
      'div.scan-card',
      h('div.mark', logo({ animated: true })),
      h('h2', `Scanning ${basename(p.path || '')}`),
      h('div.dim', p.phase || 'Reading project'),
      h(`div.progress${frac === null ? '.indeterminate' : ''}`, h('span', { style: { width: `${frac === null ? 30 : frac * 100}%` } })),
      h('div.dimmer', p.total ? `${p.done} of ${plural(p.total, 'file')} checked` : ''),
    ),
  );
}
