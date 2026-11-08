// Right panel: preview and details of the focused asset (or a summary of a
// multi-selection).

import { h, btn, iconBtn, fmtBytes, fmtDuration, fmtDate, fmtFps, resolution, previewKind, mediaUrl, STATUS_LABEL, CATEGORY_LABEL, plural, replace } from '../util.js';
import { icon, CATEGORY_ICONS } from '../icons.js';
import { state, selectedAssets, tagsFor, isFavorite, compById, labels } from '../state.js';
import { reveal, openFile, copyText, setFavorite, tagMenu, removeTag, locate, clearRelink, showComp, summarize } from '../actions.js';
import { loadThumb } from './table.js';

let lastKey = null;

export function renderPreview(el, { force = false } = {}) {
  const sel = selectedAssets();
  const focus = state.project.assets.find((a) => a.id === state.focusId);
  const key = sel.length > 1 ? `multi:${sel.map((a) => a.id).join(',')}:${state.storeVersion}` : focus ? `one:${focus.id}:${focus.mtime}:${focus.resolvedPath}:${state.storeVersion}` : 'none';
  if (!force && key === lastKey && el.firstChild) return;
  lastKey = key;
  if (sel.length > 1) return replace(el, ...multi(sel));
  if (!focus) {
    return replace(
      el,
      h('div.preview-empty', icon('image'), h('div', { style: { color: 'var(--text-2)', fontWeight: 500 } }, 'Nothing selected'), h('div', 'Select an asset to preview it and see where it’s used.')),
    );
  }
  replace(el, media(focus), details(focus));
}

function media(a) {
  const box = h('div.preview-media');
  if (a.kind === 'solid' && a.solidColor) {
    box.append(h('div.solid', { style: { background: `rgb(${a.solidColor.map((c) => Math.round(c * 255)).join(',')})` } }));
    return box;
  }
  const kind = previewKind(a.ext);
  const fallback = (text) =>
    h('div.placeholder', icon(CATEGORY_ICONS[a.category] || 'file'), h('div', text));
  if (!a.exists) {
    box.append(fallback(a.kind === 'file' ? 'File not found' : a.kind === 'placeholder' ? 'Placeholder — no file' : 'No preview'));
    return box;
  }
  if (kind === 'video' && !a.isSequence) {
    const video = h('video', { src: mediaUrl(a.resolvedPath), controls: true, muted: true, preload: 'metadata', playsInline: true });
    video.addEventListener('error', () => showThumbOr(box, a, fallback('This format can’t be previewed here. Double-click to open it.')));
    box.append(video);
    return box;
  }
  if (kind === 'image' && !a.isSequence) {
    const img = h('img', { src: mediaUrl(a.resolvedPath), alt: a.name, draggable: false });
    img.addEventListener('error', () => showThumbOr(box, a, fallback('No preview for this file')));
    box.append(img);
    return box;
  }
  if (kind === 'audio') {
    box.append(h('div.placeholder', icon('audio'), h('div', fmtDuration(a.duration) || 'Audio')));
    box.append(h('audio', { src: mediaUrl(a.resolvedPath), controls: true, preload: 'metadata' }));
    return box;
  }
  showThumbOr(box, a, fallback(a.isSequence ? `${a.frameCount} frames` : 'No preview for this format'));
  return box;
}

function showThumbOr(box, a, fallback) {
  replace(box, fallback);
  const got = loadThumb(a, (url) => {
    if (url && box.isConnected) replace(box, h('img', { src: url, alt: '', draggable: false }));
  });
  if (got) replace(box, h('img', { src: got, alt: '', draggable: false }));
}

function metaRow(k, v) {
  return v ? [h('div.k', k), h('div.v', v)] : [];
}

function details(a) {
  const tags = tagsFor(a);
  const fav = isFavorite(a);
  const comps = a.usedIn.map(compById).filter(Boolean);
  return h(
    'div.preview-body',
    h('div', h('div.preview-title', a.name), h('div.row', { style: { marginTop: '8px' } }, h(`span.pill.${a.status}`, h(`span.dot.${a.status}`), STATUS_LABEL[a.status]), a.relinked ? h('span.pill', { title: `Originally ${a.path}` }, icon('link', 'sm'), 'Relinked') : null)),
    h(
      'div.meta-grid',
      ...metaRow('Type', `${CATEGORY_LABEL[a.category] || ''}${a.ext ? ` · ${a.ext.toUpperCase()}` : ''}`),
      ...metaRow('Size', a.exists ? fmtBytes(a.size) : null),
      ...metaRow('Resolution', resolution(a)),
      ...metaRow('Duration', a.duration ? fmtDuration(a.duration) : null),
      ...metaRow('Frame rate', a.fps ? fmtFps(a.fps) : null),
      ...metaRow('Frames', a.isSequence ? `${a.frameCount}${a.sequenceGaps ? ` (${a.sequenceGaps} missing)` : ''}` : null),
      ...metaRow('Pattern', a.sequencePattern),
      ...metaRow('Modified', a.mtime ? fmtDate(a.mtime) : null),
      ...metaRow(a.leftover ? 'Found in' : labels().folder, a.folderPath || (a.kind === 'file' && state.project.format !== 'flp' ? 'Project root' : null)),
    ),
    a.resolvedPath
      ? h('div', h('div.preview-section-title', 'Location'), h('div.path-box', h('div.mono', a.resolvedPath), iconBtn('copy', { title: 'Copy path', cls: 'ghost sm', onclick: () => copyText(a.resolvedPath, 'Path copied') })), a.relinked ? h('div.dimmer', { style: { marginTop: '6px', fontSize: '11px' } }, `The project still points to ${a.path}`) : null)
      : null,
    h(
      'div.preview-actions',
      a.kind === 'file' && a.exists ? btn('Show in folder', { cls: 'sm', icon: 'reveal', onclick: () => reveal(a.resolvedPath) }) : null,
      a.kind === 'file' && a.exists ? btn('Open', { cls: 'sm', icon: 'external', onclick: () => openFile(a) }) : null,
      a.kind === 'file' && !a.exists ? btn('Locate file…', { cls: 'sm primary', icon: 'locate', onclick: () => locate(a) }) : null,
      a.relinked ? btn('Undo relink', { cls: 'sm', icon: 'x', onclick: () => clearRelink([a]) }) : null,
      a.key ? btn(fav ? 'Favorited' : 'Favorite', { cls: `sm${fav ? ' ghost active' : ''}`, icon: fav ? 'starFill' : 'star', onclick: () => setFavorite([a], !fav) }) : null,
    ),
    a.key
      ? h(
          'div',
          h('div.preview-section-title', 'Tags'),
          h(
            'div.tag-row',
            ...tags.map((t) => h(`span.tag.${t.replace(/[^a-z]/gi, '')}`, t, h('button', { type: 'button', title: `Remove ${t}`, onclick: () => removeTag([a], t) }, icon('x', 'sm')))),
            btn('Add tag', { cls: 'ghost sm', icon: 'plus', onclick: (e) => tagMenu(e.currentTarget, [a]) }),
          ),
        )
      : null,
    h(
      'div',
      h('div.preview-section-title', h('span', 'Used in'), h('span', { style: { textTransform: 'none', letterSpacing: 0 } }, comps.length ? plural(comps.length, 'comp') : '')),
      comps.length
        ? h('div.link-list', ...comps.slice(0, 30).map((c) => h('button.link-item', { type: 'button', onclick: () => showComp(c.id) }, icon('comp', 'sm'), h('span.ellipsis', c.name))))
        : h('div.dimmer', a.usedByExpression ? 'Referenced by an expression (footage("…")).' : a.leftover ? 'Not used by this project or any of the other projects Cargo checked.' : a.kind === 'file' ? 'Not used in the project.' : '—'),
    ),
  );
}

function multi(sel) {
  const files = sel.filter((a) => a.kind === 'file');
  const byStatus = {};
  for (const a of sel) byStatus[a.status] = (byStatus[a.status] || 0) + 1;
  const allFav = sel.every(isFavorite);
  return [
    h('div.preview-media', h('div.placeholder', icon('all'), h('div', { style: { color: 'var(--text)', fontSize: '14px', fontWeight: 600 } }, plural(sel.length, 'item')), h('div', summarize(sel)))),
    h(
      'div.preview-body',
      h('div.meta-grid', ...Object.entries(byStatus).flatMap(([s, n]) => [h('div.k.row', h(`span.dot.${s}`), STATUS_LABEL[s]), h('div.v', String(n))])),
      h(
        'div.preview-actions',
        btn(allFav ? 'Unfavorite all' : 'Favorite all', { cls: 'sm', icon: 'star', onclick: () => setFavorite(sel, !allFav) }),
        btn('Tag…', { cls: 'sm', icon: 'tag', onclick: (e) => tagMenu(e.currentTarget, sel) }),
        btn('Copy paths', { cls: 'sm', icon: 'copy', onclick: () => copyText(files.map((a) => a.resolvedPath).join('\n'), 'Paths copied') }),
      ),
      h('div.dimmer', 'Tip: tag files as “keep” to protect them from Delete Unused.'),
    ),
  ];
}
