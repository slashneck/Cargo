// Window title bar: brand, where you are, and global actions.

import { h, btn, iconBtn, plural } from '../util.js';
import { icon, logo } from '../icons.js';
import { state, emit, labels } from '../state.js';
import { chooseAndOpen, goHome, recentMenu, rescan, reveal, openInAE } from '../actions.js';
import { helpDialog, updateDialog } from '../dialogs.js';

export function renderTitlebar() {
  const parts = [h('button.brand', { type: 'button', title: 'Home', onclick: () => state.mode !== 'scanning' && goHome() }, logo(), 'Cargo')];
  if (state.mode === 'project' && state.project) {
    const p = state.project;
    parts.push(
      h(
        'div.crumb.no-drag',
        state.fromBatch ? btn('Batch', { cls: 'ghost sm', icon: 'chevronLeft', onclick: () => { state.mode = 'batch'; emit('all'); } }) : null,
        h('span.crumb-name.ellipsis', { title: p.filePath }, p.name),
        h('span.crumb-path.ellipsis', { title: p.filePath }, p.dir),
        p.creatorTool ? h('span.badge', { title: 'Last saved with' }, p.creatorTool.replace(/^Adobe /, '').replace(/\s*\((Windows|Macintosh)\)/, '')) : null,
        p.format === 'aepx' ? h('span.badge.accent', 'XML') : null,
        iconBtn('refresh', { title: 'Rescan (Ctrl+R)', cls: 'ghost sm', onclick: () => rescan() }),
        iconBtn('reveal', { title: 'Show project in folder', cls: 'ghost sm', onclick: () => reveal(p.filePath) }),
        btn(labels().open, { cls: 'ghost sm', icon: 'external', title: labels().openLong, onclick: () => openInAE() }),
      ),
    );
  } else if (state.mode === 'batch') {
    parts.push(h('div.crumb', h('span.crumb-name', 'Batch'), h('span.crumb-path', plural(state.batch.length, 'project'))));
  }
  parts.push(h('div.grow'));
  parts.push(
    h(
      'div.row.no-drag',
      { style: { gap: '4px' } },
      state.update ? btn(`Update ${state.update.version}`, { cls: 'sm update-pill', icon: 'export', title: 'A new version of Cargo is available', onclick: () => updateDialog() }) : null,
      btn('Open', { cls: 'ghost sm', icon: 'open', title: 'Open a project (Ctrl+O)', onclick: chooseAndOpen }),
      state.batch.length && state.mode !== 'batch' ? btn('Batch', { cls: 'ghost sm', icon: 'batch', onclick: () => { state.mode = 'batch'; emit('all'); } }) : null,
      h('button.btn.ghost.sm', { type: 'button', title: 'Recent projects', onclick: (e) => recentMenu(e.currentTarget) }, icon('clock'), h('span', 'Recent'), icon('chevronDown', 'sm')),
      iconBtn('help', { title: 'Help', cls: 'ghost sm', onclick: helpDialog }),
    ),
  );
  return parts;
}
