// Virtualized asset table: only the rows in view exist in the DOM, so large
// projects (thousands of items) scroll smoothly.

import { h, replace, fmtBytes, fmtDuration, fmtDate, resolution, previewKind, mediaUrl, STATUS_HELP, CATEGORY_LABEL, checkbox } from '../util.js';
import { icon, CATEGORY_ICONS } from '../icons.js';
import { state, emit, visibleAssets, tagsFor, isFavorite } from '../state.js';

const ROW_H = 46;
const OVERSCAN = 8;

const COLUMNS = [
  { key: null, label: '', cls: 'c-check' },
  { key: 'status', label: '', cls: 'c-status', title: 'Sort by status' },
  { key: null, label: '', cls: 'c-thumb' },
  { key: 'name', label: 'Name', cls: 'c-name-h' },
  { key: 'type', label: 'Type', cls: 'c-type' },
  { key: 'size', label: 'Size', cls: 'r' },
  { key: 'resolution', label: 'Resolution', cls: 'r.c-res' },
  { key: 'duration', label: 'Duration', cls: 'r' },
  { key: 'modified', label: 'Modified', cls: 'c-mod' },
  { key: 'usedIn', label: 'Used', cls: 'r', title: 'Number of compositions using this item' },
  { key: null, label: 'Tags', cls: 'c-tags' },
];

const thumbs = new Map(); // key -> dataURL | '' | 'pending'
let thumbProject = null;

export function clearThumbCache() {
  thumbs.clear();
}

function thumbKey(a) {
  return `${state.project.id}:${a.id}:${a.mtime || 0}`;
}

export function loadThumb(a, onReady) {
  if (!a.exists) return null;
  const key = thumbKey(a);
  const cached = thumbs.get(key);
  if (cached !== undefined && cached !== 'pending') return cached;
  if (cached === 'pending') return null;
  thumbs.set(key, 'pending');
  window.cargo
    .thumbnail(state.project.id, a.id)
    .then((url) => {
      if (!url && previewKind(a.ext) === 'image' && !a.isSequence) url = mediaUrl(a.resolvedPath);
      thumbs.set(key, url || '');
      onReady(url || '');
    })
    .catch(() => thumbs.set(key, ''));
  return null;
}

export class AssetTable {
  constructor({ onOpen, onContext, onDelete }) {
    this.onOpen = onOpen;
    this.onDelete = onDelete;
    this.onContext = onContext;
    this.list = [];
    this.head = h('div.thead');
    this.inner = h('div.tbody-inner');
    this.empty = h('div.table-empty', { hidden: true });
    this.body = h('div.tbody', { tabIndex: 0 }, this.inner, this.empty);
    this.el = h('div.table', this.head, this.body);
    this.body.addEventListener('scroll', () => this.paint());
    this.body.addEventListener('keydown', (e) => this.onKey(e));
    this.resizeObserver = new ResizeObserver(() => this.paint());
    this.resizeObserver.observe(this.body);
    this.lastPaint = '';
  }

  destroy() {
    this.resizeObserver.disconnect();
  }

  update({ scrollToFocus = false } = {}) {
    if (thumbProject !== state.project.id) {
      thumbProject = state.project.id;
    }
    this.list = visibleAssets();
    this.renderHead();
    this.inner.style.height = `${this.list.length * ROW_H}px`;
    this.lastPaint = '';
    if (scrollToFocus) this.scrollTo(state.focusId);
    this.paint();
    this.renderEmpty();
  }

  renderEmpty() {
    const none = this.list.length === 0;
    this.empty.hidden = !none;
    if (!none) return;
    const filtered = state.filter.search || state.filter.status || state.filter.folderId || state.filter.compId || state.filter.library !== 'all';
    replace(
      this.empty,
      icon(filtered ? 'search' : 'package'),
      h('div', { style: { color: 'var(--text-2)', fontWeight: '500' } }, filtered ? 'Nothing matches these filters' : 'This project has no footage'),
      h('div', filtered ? 'Try clearing the search or picking “All assets”.' : 'Compositions, text and shape layers don’t need any files.'),
    );
  }

  renderHead() {
    const vis = this.list;
    const selectedVisible = vis.filter((a) => state.selection.has(a.id)).length;
    const all = checkbox({
      checked: vis.length > 0 && selectedVisible === vis.length,
      indeterminate: selectedVisible > 0 && selectedVisible < vis.length,
      onchange: (on) => {
        state.selection = on ? new Set(vis.map((a) => a.id)) : new Set();
        if (on && !state.focusId && vis[0]) state.focusId = vis[0].id;
        emit('table', 'preview', 'actions');
      },
    });
    all.title = 'Select all';
    replace(
      this.head,
      ...COLUMNS.map((c, i) => {
        if (i === 0) return h(`div.${c.cls}`, all);
        const sorted = c.key && state.sort.key === c.key;
        return h(
          `div${c.cls ? '.' + c.cls : ''}${sorted ? '.sorted' : ''}`,
          {
            title: c.title || (c.key ? `Sort by ${c.label.toLowerCase()}` : ''),
            onclick: c.key
              ? () => {
                  state.sort = { key: c.key, dir: sorted ? -state.sort.dir : c.key === 'size' || c.key === 'modified' || c.key === 'usedIn' ? -1 : 1 };
                  emit('table');
                }
              : null,
          },
          c.key === 'status' ? h('span.dot', { style: { background: '#555' } }) : c.label,
          sorted ? icon(state.sort.dir > 0 ? 'arrowUp' : 'arrowDown', 'sm') : null,
        );
      }),
    );
  }

  paint() {
    const top = this.body.scrollTop;
    const height = this.body.clientHeight || 600;
    const start = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
    const end = Math.min(this.list.length, Math.ceil((top + height) / ROW_H) + OVERSCAN);
    const sig = `${start}:${end}:${this.list.length}:${state.selection.size}:${state.focusId}:${[...state.selection].slice(0, 50).join(',')}`;
    if (sig === this.lastPaint) return;
    this.lastPaint = sig;
    const rows = [];
    for (let i = start; i < end; i++) rows.push(this.row(this.list[i], i));
    replace(this.inner, ...rows);
  }

  row(a, index) {
    const sel = state.selection.has(a.id);
    const focus = state.focusId === a.id;
    const tags = tagsFor(a);
    const thumbEl = h('div.thumb', icon(CATEGORY_ICONS[a.category] || 'file', 'sm'));
    if (a.kind === 'solid' && a.solidColor) {
      thumbEl.style.background = `rgb(${a.solidColor.map((c) => Math.round(c * 255)).join(',')})`;
      thumbEl.firstChild.remove();
    } else {
      const url = loadThumb(a, (u) => {
        if (u && thumbEl.isConnected) replace(thumbEl, h('img', { src: u, alt: '', draggable: false, onerror: () => replace(thumbEl, icon(CATEGORY_ICONS[a.category] || 'file', 'sm')) }));
      });
      if (url) replace(thumbEl, h('img', { src: url, alt: '', draggable: false }));
    }
    const sub = a.kind === 'file' ? a.resolvedPath : a.kind === 'solid' ? 'Solid' : a.kind === 'placeholder' ? 'Placeholder — no file' : '';
    const el = h(
      `div.trow.st-${a.status}${sel ? '.sel' : ''}${focus ? '.focus' : ''}`,
      { style: { top: `${index * ROW_H}px` }, dataset: { id: a.id } },
      h(
        'div.c-check',
        checkbox({
          checked: sel,
          onchange: (on) => {
            if (on) state.selection.add(a.id);
            else state.selection.delete(a.id);
            state.focusId = a.id;
            state.anchorId = a.id;
            emit('table', 'preview', 'actions');
          },
        }),
      ),
      h('div.c-status', { title: STATUS_HELP[a.status] }, h(`span.dot.${a.status}`)),
      h('div.c-thumb', thumbEl),
      h(
        'div.c-name',
        h(
          'div.name-main',
          isFavorite(a) ? h('span.star', { title: 'Favorite' }, icon('starFill', 'sm')) : null,
          h('span.ellipsis', a.name),
          a.relinked ? h('span', { title: `Relinked in Cargo (was ${a.path})`, style: { color: 'var(--accent)', display: 'flex' } }, icon('link', 'sm')) : null,
        ),
        h('div.name-sub', { title: sub }, a.status === 'missing' || a.status === 'unused-missing' ? h('span', { style: { color: 'var(--warn)' } }, `Missing — ${sub}`) : sub),
      ),
      h('div.c-type', { title: CATEGORY_LABEL[a.category] || '' }, a.ext ? h('span.fmt', a.ext.toUpperCase().slice(0, 5)) : h('span.dimmer', CATEGORY_LABEL[a.category] || '')),
      h('div.r.num', a.exists ? fmtBytes(a.size) : '—'),
      h('div.r.num.c-res', resolution(a)),
      h('div.r.num', a.isSequence ? `${a.frameCount} fr` : fmtDuration(a.duration)),
      h('div.c-mod.dim', { title: a.mtime ? fmtDate(a.mtime) : '' }, a.mtime ? fmtDate(a.mtime, false) : ''),
      h('div.r.num', { title: a.usedByExpression && !a.usedIn.length ? 'Used by an expression' : '' }, a.usedIn.length ? String(a.usedIn.length) : a.usedByExpression ? 'expr' : h('span.dimmer', '—')),
      h('div.c-tags', ...tags.slice(0, 3).map((t) => h(`span.tag.${t.replace(/[^a-z]/gi, '')}`, t)), tags.length > 3 ? h('span.dimmer', `+${tags.length - 3}`) : null),
    );
    el.addEventListener('mousedown', (e) => {
      if (e.button === 2 && state.selection.has(a.id)) return;
      if (e.target.closest('.check')) return;
      this.select(a.id, e);
    });
    el.addEventListener('dblclick', (e) => {
      if (!e.target.closest('.check')) this.onOpen(a);
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!state.selection.has(a.id)) this.select(a.id, {});
      this.onContext(a, { x: e.clientX, y: e.clientY });
    });
    return el;
  }

  select(id, e) {
    const ids = this.list.map((a) => a.id);
    if (e.shiftKey && state.anchorId !== null && ids.includes(state.anchorId)) {
      const a = ids.indexOf(state.anchorId);
      const b = ids.indexOf(id);
      const range = ids.slice(Math.min(a, b), Math.max(a, b) + 1);
      state.selection = new Set(e.ctrlKey || e.metaKey ? [...state.selection, ...range] : range);
    } else if (e.ctrlKey || e.metaKey) {
      if (state.selection.has(id)) state.selection.delete(id);
      else state.selection.add(id);
      state.anchorId = id;
    } else {
      state.selection = new Set([id]);
      state.anchorId = id;
    }
    state.focusId = id;
    this.body.focus({ preventScroll: true });
    emit('table', 'preview', 'actions');
  }

  scrollTo(id) {
    const i = this.list.findIndex((a) => a.id === id);
    if (i < 0) return;
    const top = i * ROW_H;
    const view = this.body.clientHeight;
    if (top < this.body.scrollTop) this.body.scrollTop = top;
    else if (top + ROW_H > this.body.scrollTop + view) this.body.scrollTop = top + ROW_H - view;
  }

  onKey(e) {
    const ids = this.list.map((a) => a.id);
    if (!ids.length) return;
    let i = ids.indexOf(state.focusId);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'PageDown' || e.key === 'PageUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const page = Math.max(1, Math.floor(this.body.clientHeight / ROW_H) - 1);
      if (i < 0) i = 0;
      else if (e.key === 'ArrowDown') i = Math.min(ids.length - 1, i + 1);
      else if (e.key === 'ArrowUp') i = Math.max(0, i - 1);
      else if (e.key === 'PageDown') i = Math.min(ids.length - 1, i + page);
      else if (e.key === 'PageUp') i = Math.max(0, i - page);
      else if (e.key === 'Home') i = 0;
      else if (e.key === 'End') i = ids.length - 1;
      this.select(ids[i], { shiftKey: e.shiftKey });
      this.scrollTo(ids[i]);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      state.selection = new Set(ids);
      emit('table', 'preview', 'actions');
    } else if (e.key === 'Delete' && state.selection.size) {
      e.preventDefault();
      this.onDelete([...state.selection]);
    } else if (e.key === 'Enter' && i >= 0) {
      e.preventDefault();
      this.onOpen(this.list[i]);
    } else if (e.key === 'Escape' && state.selection.size) {
      state.selection = new Set();
      emit('table', 'preview', 'actions');
    } else if (e.key === 'ContextMenu' && i >= 0) {
      e.preventDefault();
      const row = this.inner.querySelector(`[data-id="${ids[i]}"]`);
      const r = row ? row.getBoundingClientRect() : { left: 200, bottom: 200 };
      this.onContext(this.list[i], { x: r.left + 120, y: r.bottom - 10 });
    }
  }
}
