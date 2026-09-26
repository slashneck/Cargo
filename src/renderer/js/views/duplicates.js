// Duplicate files: identical copies and near-duplicates (re-exports, proxies).

import { h, btn, iconBtn, fmtBytes, plural, STATUS_LABEL } from '../util.js';
import { icon } from '../icons.js';
import { state, emit } from '../state.js';
import { runJob, errorDialog, confirmDialog, toast } from '../ui.js';
import { reveal, focusAsset, applyProjectUpdate, refreshStore } from '../actions.js';

const api = window.cargo;

async function find() {
  try {
    state.duplicates = await runJob('Looking for duplicates', (jobId) => api.duplicates(state.project.id, jobId), { icon: 'duplicate' });
    emit('content');
  } catch (err) {
    if (!err.cancelled) errorDialog(err.message);
  }
}

async function trashCopies(group) {
  const removable = group.members.filter((m) => m.key !== group.keep && !m.used);
  if (!removable.length) return;
  const size = removable.reduce((t, m) => t + m.size, 0);
  const ok = await confirmDialog({
    title: `Move ${plural(removable.length, 'copy', 'copies')} to the Recycle Bin?`,
    message: `${removable.map((m) => m.name).join(', ')} (${fmtBytes(size)}). They aren’t used by any composition. You can restore them from the Recycle Bin.`,
    confirm: 'Move to Recycle Bin',
    danger: true,
  });
  if (!ok) return;
  try {
    const r = await runJob('Moving to the Recycle Bin', (jobId) => api.trash(state.project.id, removable.map((m) => m.path), jobId), { icon: 'trash' });
    applyProjectUpdate(r.project);
    await refreshStore();
    state.duplicates = null;
    state.tab = 'duplicates';
    emit('all');
    toast(`Moved ${plural(r.trashed.length, 'file')} to the Recycle Bin`, { tone: 'ok' });
    find();
  } catch (err) {
    if (!err.cancelled) errorDialog(err.message);
  }
}

function group(g) {
  const removable = g.members.filter((m) => m.key !== g.keep && !m.used);
  return h(
    'div.dup-group',
    h(
      'div.dup-head',
      icon(g.kind === 'identical' ? 'duplicate' : 'search'),
      h('div.grow', h('div', { style: { color: 'var(--text)', fontWeight: 500 } }, g.reason), h('div.dim', `${plural(g.members.length, 'file')} · ${fmtBytes(g.wasted)} ${g.kind === 'identical' ? 'wasted' : 'could be saved'}`)),
      removable.length ? btn(`Recycle ${plural(removable.length, 'unused copy', 'unused copies')}`, { cls: 'sm danger', icon: 'trash', onclick: () => trashCopies(g) }) : null,
    ),
    ...g.members.map((m) => {
      const keep = m.key === g.keep;
      return h(
        `div.dup-member${keep ? '.keep' : ''}`,
        keep ? h('span', { title: 'Suggested to keep', style: { color: 'var(--accent)', display: 'flex' } }, icon('check', 'sm')) : h('span'),
        h('div', { style: { minWidth: 0, cursor: 'pointer' }, onclick: () => focusAsset(m.assetIds[0]) }, h('div.ellipsis', { style: { color: 'var(--text)' } }, m.name, keep ? h('span.dim', '  · keep') : null), h('div.mono.ellipsis.dimmer', { title: m.path }, m.path)),
        h('span.num', { style: { textAlign: 'right' } }, fmtBytes(m.size)),
        h(`span.pill.${m.used ? 'used' : 'unused'}`, m.used ? STATUS_LABEL.used : STATUS_LABEL.unused),
        iconBtn('reveal', { title: 'Show in folder', cls: 'ghost sm', onclick: () => reveal(m.path) }),
      );
    }),
  );
}

export function renderDuplicates() {
  const d = state.duplicates;
  if (!d) {
    return h(
      'div.pane',
      h(
        'div.pane-inner',
        { style: { maxWidth: '640px', alignItems: 'center', textAlign: 'center', paddingTop: '48px' } },
        icon('duplicate', 'xl'),
        h('h2', { style: { color: 'var(--text)', margin: '6px 0 0', fontSize: '16px' } }, 'Find duplicate footage'),
        h('div.dim', { style: { lineHeight: 1.6 } }, 'Cargo compares file sizes and samples of their contents to find identical copies, and looks for re-exports with similar names or the same resolution and duration. Files are only read, never changed.'),
        btn('Find duplicates', { cls: 'primary lg', icon: 'search', onclick: find }),
      ),
    );
  }
  const wasted = d.identical.reduce((t, g) => t + g.wasted, 0);
  if (!d.identical.length && !d.similar.length) {
    return h('div.pane', h('div.pane-inner', h('div.notice.ok', icon('checkCircle'), h('div', h('b', 'No duplicates found. '), 'Every file in this project is unique.')), h('div', btn('Search again', { icon: 'refresh', onclick: find }))));
  }
  return h(
    'div.pane',
    h(
      'div.pane-inner',
      h('div.row', h('div.grow', h('div', { style: { color: 'var(--text)', fontSize: '14px', fontWeight: 600 } }, `${plural(d.identical.length, 'identical group')} · ${fmtBytes(wasted)} in extra copies`), h('div.dim', `${plural(d.similar.length, 'group')} of similar files`)), btn('Search again', { icon: 'refresh', cls: 'sm', onclick: find })),
      h('div.notice.info', icon('info'), h('div', 'The ', h('b', 'keep'), ' suggestion prefers files the project uses, then files inside the project folder, then the largest. Only unused copies can be recycled here; relink used copies in After Effects first.')),
      d.identical.length ? h('div.section-title', 'Identical copies') : null,
      ...d.identical.map(group),
      d.similar.length ? h('div.section-title', { style: { marginTop: '8px' } }, 'Similar files') : null,
      ...d.similar.map(group),
    ),
  );
}
