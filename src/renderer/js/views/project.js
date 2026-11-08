// Project workspace: banners, sidebar, tabs, tab content and the action bar.

import { h, btn, iconBtn, replace, fmtBytes, plural, CATEGORY_PLURAL, debounce } from '../util.js';
import { icon } from '../icons.js';
import { state, emit, invalidate, visibleAssets, compById, labels, appName } from '../state.js';
import { AssetTable } from './table.js';
import { renderSidebar } from './sidebar.js';
import { renderPreview } from './preview.js';
import { renderInsights } from './insights.js';
import { renderComps } from './comps.js';
import { renderEffects } from './effects.js';
import { renderDuplicates } from './duplicates.js';
import { openFile, assetContextMenu, exportMenu, saveRelinked, clearRelink, deleteMenu } from '../actions.js';
import { packageDialog, deleteUnusedDialog, deleteAssetsDialog, organizeDialog, archiveDialog, missingDialog, leftoversDialog } from '../dialogs.js';

const TABS = [
  ['assets', 'Assets', 'list'],
  ['insights', 'Insights', 'dashboard'],
  ['comps', null, 'tree'],
  ['effects', null, 'plug'],
  ['duplicates', 'Duplicates', 'duplicate'],
];

export class ProjectView {
  constructor() {
    this.banners = h('div');
    this.sidebar = h('aside.sidebar');
    this.tabs = h('div.tabs-bar');
    this.content = h('div.content');
    this.actions = h('div.actionbar');
    this.el = h('div.project', this.banners, h('div.project-body', this.sidebar, h('div.main', this.tabs, this.content)), this.actions);
    this.table = new AssetTable({ onOpen: openFile, onContext: assetContextMenu, onDelete: (assetIds) => deleteAssetsDialog({ assetIds }) });
    this.previewEl = h('aside.preview');
    this.search = null;
    this.chips = h('div.row', { style: { gap: '6px', flexWrap: 'nowrap', minWidth: 0 } });
    this.count = h('span.result-count');
    this.deleteSelected = h('button.btn.danger.sm', { type: 'button', hidden: true, title: 'Move the selected files to the Recycle Bin (Delete)', onclick: () => deleteAssetsDialog({ assetIds: [...state.selection] }) }, icon('trash', 'sm'), h('span'));
  }

  destroy() {
    this.table.destroy();
  }

  render(parts) {
    const all = parts.has('all');
    if (all) {
      this.renderBanners();
      replace(this.sidebar, ...renderSidebar());
      this.renderTabs();
      this.renderContent();
      this.renderActions();
      return;
    }
    if (parts.has('sidebar')) replace(this.sidebar, ...renderSidebar());
    if (parts.has('content')) this.renderContent();
    if (state.tab === 'assets') {
      if (parts.has('table') || parts.has('actions')) this.updateToolbar();
      if (parts.has('table')) {
        this.table.update({ scrollToFocus: parts.has('scrollToFocus') });
        this.updateToolbar();
      }
      if (parts.has('preview') && state.previewOpen) renderPreview(this.previewEl);
    }
    if (parts.has('actions')) this.renderActions();
  }

  renderBanners() {
    const p = state.project;
    const usedMissing = p.assets.filter((a) => a.status === 'missing').length;
    const relinked = p.assets.filter((a) => a.relinked);
    replace(
      this.banners,
      usedMissing
        ? h('div.banner.warn', icon('alert'), h('div.grow', h('b', `${plural(usedMissing, 'used file')} ${usedMissing === 1 ? 'is' : 'are'} missing. `), `${appName()} won’t find them, and packages can’t include them.`), btn('Find missing…', { cls: 'sm', icon: 'locate', onclick: missingDialog }))
        : null,
      relinked.length
        ? h('div.banner.info', icon('link'), h('div.grow', `${plural(relinked.length, 'file')} ${relinked.length === 1 ? 'is' : 'are'} relinked in Cargo. Save a relinked copy so ${appName()} finds ${relinked.length === 1 ? 'it' : 'them'} too.`), btn('Undo relinks', { cls: 'sm ghost', onclick: () => clearRelink(relinked) }), btn('Save relinked project', { cls: 'sm primary', icon: 'save', onclick: saveRelinked }))
        : null,
      p.totals.leftoverCount
        ? h(
            'div.banner.leftover',
            icon('mic'),
            h(
              'div.grow',
              h('b', `${plural(p.totals.leftoverCount, 'file')} (${fmtBytes(p.totals.leftoverSize)}) ${p.totals.leftoverCount === 1 ? 'isn’t' : 'aren’t'} in this project. `),
              !p.leftoverInfo || !p.leftoverInfo.projectsChecked
                ? 'No other project Cargo found uses them.'
                : p.leftoverInfo.projectsChecked === 1
                  ? 'The other project Cargo found doesn’t use them either.'
                  : `None of the ${p.leftoverInfo.projectsChecked} other projects Cargo found uses them either.`,
            ),
            btn('Show them', {
              cls: 'sm',
              onclick: () => {
                state.tab = 'assets';
                state.filter = { ...state.filter, status: 'leftover', library: 'all', folderId: null, compId: null };
                invalidate();
                emit('all');
              },
            }),
            btn('Where Cargo looked…', { cls: 'sm ghost', onclick: leftoversDialog }),
          )
        : null,
    );
  }

  renderTabs() {
    const p = state.project;
    const thirdParty = p.effects.filter((e) => !e.builtIn && e.count > 0).length;
    const counts = { assets: p.totals.fileAssetCount, comps: p.comps.filter((c) => c.kind !== 'arrangement').length, effects: p.effects.filter((e) => e.count > 0).length };
    replace(
      this.tabs,
      ...TABS.map(([key, fixed, ic], i) => {
        const label = fixed || (key === 'comps' ? labels().comps : labels().effects);
        return h(
          `button.tab${state.tab === key ? '.on' : ''}`,
          { type: 'button', title: `${label} (Ctrl+${i + 1})`, onclick: () => { state.tab = key; emit('all'); } },
          icon(ic, 'sm'),
          label,
          counts[key] !== undefined ? h(`span.badge${key === 'effects' && thirdParty ? '.warn' : ''}`, String(counts[key])) : null,
        );
      }),
      h('div.spacer'),
      h('span.dimmer', { style: { fontSize: '11px' } }, `Scanned in ${p.scanMs < 1000 ? `${p.scanMs} ms` : `${(p.scanMs / 1000).toFixed(1)} s`}`),
    );
  }

  renderContent() {
    if (state.tab !== 'assets') {
      const view = { insights: renderInsights, comps: renderComps, effects: renderEffects, duplicates: renderDuplicates }[state.tab];
      replace(this.content, view ? view() : null);
      this.search = null;
      return;
    }
    this.search = h('input.input', {
      placeholder: 'Search name, path, tag…',
      value: state.filter.search,
      spellcheck: false,
      oninput: debounce(() => {
        state.filter = { ...state.filter, search: this.search.value };
        invalidate();
        emit('table', 'sidebar');
      }, 120),
      onkeydown: (e) => {
        if (e.key === 'Escape' && this.search.value) {
          e.stopPropagation();
          this.search.value = '';
          state.filter = { ...state.filter, search: '' };
          invalidate();
          emit('table');
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          this.table.body.focus();
        }
      },
    });
    const toolbar = h(
      'div.toolbar',
      h('div.search', icon('search'), this.search, state.filter.search ? null : h('kbd', 'Ctrl F')),
      this.chips,
      h('div.grow'),
      this.deleteSelected,
      this.count,
      state.project.format === 'flp'
        ? null
        : h(
        'button.btn.ghost.sm',
        {
          type: 'button',
          title: 'Solids are created inside After Effects and have no file',
          onclick: async () => {
            await window.cargo.setSetting('showGenerated', !state.store.settings.showGenerated);
            state.store.settings.showGenerated = !state.store.settings.showGenerated;
            invalidate();
            emit('all');
          },
        },
        icon(state.store.settings.showGenerated ? 'check' : 'solid', 'sm'),
        h('span', 'Solids'),
      ),
      iconBtn('panel', { title: state.previewOpen ? 'Hide preview' : 'Show preview', cls: `ghost sm${state.previewOpen ? ' active' : ''}`, onclick: () => { state.previewOpen = !state.previewOpen; emit('content'); } }),
    );
    replace(this.content, h('div.table-wrap', toolbar, this.table.el), state.previewOpen ? this.previewEl : null);
    this.table.update({ scrollToFocus: true });
    this.updateToolbar();
    if (state.previewOpen) renderPreview(this.previewEl, { force: true });
  }

  updateToolbar() {
    const f = state.filter;
    const chip = (label, ic, clear) => h('span.chip', icon(ic, 'sm'), h('span.ellipsis', { style: { maxWidth: '180px' } }, label), h('button', { type: 'button', title: 'Clear filter', onclick: () => { clear(); invalidate(); emit('all'); } }, icon('x', 'sm')));
    const chips = [];
    if (f.library !== 'all') chips.push(chip(CATEGORY_PLURAL[f.library] || f.library, 'filter', () => (state.filter.library = 'all')));
    if (f.status) chips.push(chip(f.status.startsWith('tag:') ? `#${f.status.slice(4)}` : f.status === 'leftover' ? 'Not in project' : f.status[0].toUpperCase() + f.status.slice(1), 'filter', () => (state.filter.status = null)));
    if (f.folderId) {
      const folder = state.project.folders.find((x) => x.id === f.folderId);
      chips.push(chip(folder ? folder.name : 'Folder', 'folder', () => (state.filter.folderId = null)));
    }
    if (f.compId) {
      const c = compById(f.compId);
      chips.push(chip(c ? `Used by ${c.name}` : 'Comp', 'comp', () => (state.filter.compId = null)));
    }
    replace(this.chips, ...chips);
    const vis = visibleAssets();
    const size = vis.reduce((t, a) => t + (a.exists ? a.size : 0), 0);
    this.count.textContent = `${plural(vis.length, 'item')} · ${fmtBytes(size)}`;
    const selectedFiles = state.project.assets.filter((a) => state.selection.has(a.id) && a.kind === 'file' && a.exists).length;
    this.deleteSelected.hidden = !selectedFiles;
    this.deleteSelected.lastChild.textContent = `Delete ${selectedFiles} selected`;
  }

  renderActions() {
    const p = state.project;
    const t = p.totals;
    const missing = p.assets.filter((a) => a.kind === 'file' && !a.exists).length;
    replace(
      this.actions,
      btn(missing ? `Find Missing` : 'Find Missing', { cls: missing ? '' : 'ghost', icon: 'locate', onclick: missingDialog, disabled: !missing, title: missing ? 'Search for missing files' : 'No missing files' }),
      missing ? h('span.badge.warn', { style: { marginLeft: '-4px' } }, String(missing)) : null,
      h('div.sep'),
      h(
        'div.btn-group',
        btn(t.unusedSize ? `Delete Unused · ${fmtBytes(t.unusedSize)}` : 'Delete Unused', { cls: 'danger', icon: 'trash', onclick: deleteUnusedDialog, disabled: !t.unusedFileCount, title: 'Move unused files to the Recycle Bin' }),
        h('button.btn.danger.icon-only', { type: 'button', title: 'More ways to delete', 'aria-label': 'More ways to delete', onclick: (e) => deleteMenu(e.currentTarget) }, icon('chevronDown', 'sm')),
      ),
      btn('Organize', { icon: 'organize', onclick: organizeDialog, disabled: !t.fileCount, title: 'Sort footage into folders' }),
      btn('Archive', { icon: 'archive', onclick: archiveDialog, disabled: !t.fileCount, title: 'Move the project and its footage to an archive' }),
      h('div.grow'),
      h('button.btn', { type: 'button', title: 'Export manifest (Ctrl+E)', onclick: (e) => exportMenu(e.currentTarget), id: 'export-btn' }, icon('export'), h('span', 'Export'), icon('chevronDown', 'sm')),
      btn('Package Project', { cls: 'primary', icon: 'package', onclick: () => packageDialog(), title: 'Ctrl+P' }),
    );
  }

  focusSearch() {
    if (this.search) {
      this.search.focus();
      this.search.select();
    }
  }
}
