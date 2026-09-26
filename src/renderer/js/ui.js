// Overlays: modals, menus, toasts, and the progress dialog for long jobs.

import { h, btn, iconBtn, fmtBytes, fmtTime, uid, replace } from './util.js';
import { icon } from './icons.js';

const layers = () => document.getElementById('layers');
const openModals = [];

export function hasOpenModal() {
  return openModals.length > 0;
}

/**
 * Opens a modal. Returns {el, body, foot, close(result), result: Promise}.
 * `footer` may be an array of nodes or a function (close) => nodes.
 */
export function modal({ title, subtitle, icon: ic, tone, body, footer, width = '', dismissible = true, onClose } = {}) {
  let resolve;
  const result = new Promise((r) => (resolve = r));
  const bodyEl = h('div.modal-body');
  const footEl = h('div.modal-foot');
  let closed = false;
  const close = (value) => {
    if (closed) return;
    closed = true;
    backdrop.remove();
    const i = openModals.indexOf(api);
    if (i >= 0) openModals.splice(i, 1);
    document.removeEventListener('keydown', onKey, true);
    if (onClose) onClose(value);
    resolve(value);
    if (previousFocus && previousFocus.isConnected) previousFocus.focus();
  };
  const onKey = (e) => {
    if (openModals[openModals.length - 1] !== api) return;
    if (e.key === 'Escape' && api.dismissible) {
      e.stopPropagation();
      e.preventDefault();
      close(null);
    }
  };
  const box = h(
    `div.modal${width ? '.' + width : ''}`,
    { tabIndex: -1, role: 'dialog', 'aria-modal': 'true' },
    h(
      'div.modal-head',
      ic ? h(`div.icon-wrap${tone ? '.' + tone : ''}`, icon(ic, 'lg')) : null,
      h('div.grow', h('h2', title), subtitle ? h('p', subtitle) : null),
      dismissible ? iconBtn('x', { title: 'Close', onclick: () => close(null), cls: 'ghost sm close' }) : null,
    ),
    bodyEl,
    footEl,
  );
  const backdrop = h('div.modal-backdrop', box);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop && api.dismissible) close(null);
  });
  const previousFocus = document.activeElement;
  const api = {
    el: box,
    body: bodyEl,
    foot: footEl,
    close,
    result,
    dismissible,
    setBody: (...nodes) => replace(bodyEl, ...nodes),
    setFooter: (nodes) => {
      replace(footEl, ...(typeof nodes === 'function' ? nodes(close) : nodes));
      footEl.hidden = !footEl.firstChild;
    },
  };
  if (body) api.setBody(...(Array.isArray(body) ? body : [body]));
  api.setFooter(footer || []);
  openModals.push(api);
  layers().append(backdrop);
  document.addEventListener('keydown', onKey, true);
  requestAnimationFrame(() => {
    const first = box.querySelector('[autofocus]') || box.querySelector('.modal-foot .btn.primary') || box;
    first.focus();
  });
  return api;
}

export function confirmDialog({ title, message, confirm = 'OK', cancel = 'Cancel', danger = false, icon: ic = danger ? 'alert' : 'info', details } = {}) {
  const m = modal({
    title,
    icon: ic,
    tone: danger ? 'bad' : '',
    body: [h('div', { style: { color: 'var(--text-2)', lineHeight: '1.6' } }, message), details || null],
    footer: (close) => [h('div.info'), btn(cancel, { onclick: () => close(false) }), btn(confirm, { cls: danger ? 'danger solid' : 'primary', onclick: () => close(true) })],
  });
  return m.result.then((v) => !!v);
}

export function errorDialog(err, title = 'That didn’t work') {
  const message = typeof err === 'string' ? err : err && err.message ? err.message : String(err);
  const m = modal({
    title,
    icon: 'alert',
    tone: 'bad',
    body: h('div.selectable', { style: { color: 'var(--text-2)', lineHeight: '1.6', whiteSpace: 'pre-wrap' } }, message),
    footer: (close) => [h('div.info'), btn('OK', { cls: 'primary', onclick: () => close(true) })],
  });
  return m.result;
}

// ---------------------------------------------------------------- toasts

export function toast(message, { tone = '', action, timeout = 4200 } = {}) {
  const ic = tone === 'bad' ? 'alert' : tone === 'ok' ? 'checkCircle' : 'info';
  const el = h(
    `div.toast${tone ? '.' + tone : ''}`,
    icon(ic),
    h('div.grow', message),
    action ? btn(action.label, { cls: 'sm', onclick: () => { action.onclick(); el.remove(); } }) : null,
    iconBtn('x', { title: 'Dismiss', cls: 'ghost sm', onclick: () => el.remove() }),
  );
  document.getElementById('toasts').append(el);
  if (timeout) setTimeout(() => el.remove(), timeout);
  return el;
}

// ---------------------------------------------------------------- menus

let activeMenu = null;

export function closeMenu() {
  if (activeMenu) {
    activeMenu.remove();
    activeMenu = null;
    document.removeEventListener('mousedown', outside, true);
    document.removeEventListener('keydown', menuKeys, true);
    window.removeEventListener('blur', closeMenu);
    window.removeEventListener('resize', closeMenu);
  }
}

function outside(e) {
  if (activeMenu && !activeMenu.contains(e.target)) closeMenu();
}

function menuKeys(e) {
  if (!activeMenu) return;
  const items = [...activeMenu.querySelectorAll('.menu-item:not(:disabled)')];
  const i = items.indexOf(document.activeElement);
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeMenu();
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    (items[i + 1] || items[0])?.focus();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    (items[i - 1] || items[items.length - 1])?.focus();
  }
}

/**
 * items: {label, icon, onclick, disabled, danger, kbd} | 'sep' | {header: 'Label'} | {node}
 * at: {x, y} or an element to anchor below.
 */
export function openMenu(at, items, { align = 'left', minWidth } = {}) {
  closeMenu();
  const el = h('div.menu', { role: 'menu', style: minWidth ? { minWidth: `${minWidth}px` } : null });
  for (const it of items) {
    if (!it) continue;
    if (it === 'sep') el.append(h('div.menu-sep'));
    else if (it.header) el.append(h('div.menu-label', it.header));
    else if (it.node) el.append(it.node);
    else {
      el.append(
        h(
          `button.menu-item${it.danger ? '.danger' : ''}`,
          {
            type: 'button',
            role: 'menuitem',
            disabled: it.disabled,
            onclick: () => {
              closeMenu();
              it.onclick && it.onclick();
            },
          },
          it.icon ? icon(it.icon) : h('span', { style: { width: '16px' } }),
          h('span.ellipsis', it.label),
          it.kbd ? h('span.kbd', it.kbd) : null,
        ),
      );
    }
  }
  document.body.append(el);
  activeMenu = el;
  const rect = el.getBoundingClientRect();
  let x;
  let y;
  if (at instanceof Element) {
    const r = at.getBoundingClientRect();
    x = align === 'right' ? r.right - rect.width : r.left;
    y = r.bottom + 4;
    if (y + rect.height > window.innerHeight - 8) y = r.top - rect.height - 4;
  } else {
    x = at.x;
    y = at.y;
    if (y + rect.height > window.innerHeight - 8) y = Math.max(8, y - rect.height);
  }
  x = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
  y = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  setTimeout(() => {
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('keydown', menuKeys, true);
    window.addEventListener('blur', closeMenu);
    window.addEventListener('resize', closeMenu);
  });
  return el;
}

// ---------------------------------------------------------------- jobs

/**
 * Runs `fn(jobId)` and shows a progress dialog if it takes more than a moment.
 * Resolves with fn's result, rejects with its error (err.cancelled on cancel).
 */
export async function runJob(title, fn, { subtitle, cancellable = true, icon: ic = 'package', delay = 200 } = {}) {
  const jobId = uid();
  const phase = h('div', { style: { color: 'var(--text)', fontWeight: '500' } }, 'Starting…');
  const bar = h('span', { style: { width: '0%' } });
  const barWrap = h('div.progress.indeterminate', bar);
  const left = h('span', '');
  const right = h('span', '');
  const current = h('div.progress-current.ellipsis', '');
  let m = null;
  let cancelBtn = null;
  const samples = [];

  const show = () => {
    if (m) return;
    cancelBtn = cancellable
      ? btn('Cancel', {
          onclick: async () => {
            cancelBtn.disabled = true;
            cancelBtn.lastChild.textContent = 'Cancelling…';
            await window.cargo.cancelJob(jobId);
          },
        })
      : null;
    m = modal({
      title,
      subtitle,
      icon: ic,
      dismissible: false,
      body: [phase, barWrap, h('div.progress-meta', left, right), current],
      footer: [h('div.info'), cancelBtn],
    });
  };
  const timer = setTimeout(show, delay);

  const off = window.cargo.onProgress((p) => {
    if (p.jobId !== jobId) return;
    if (p.phase) phase.textContent = p.phase;
    let fraction = null;
    if (p.totalBytes) fraction = p.bytes / p.totalBytes;
    else if (p.total) fraction = p.done / p.total;
    if (fraction !== null && Number.isFinite(fraction)) {
      barWrap.classList.remove('indeterminate');
      bar.style.width = `${Math.min(100, fraction * 100).toFixed(1)}%`;
    } else {
      barWrap.classList.add('indeterminate');
    }
    if (p.totalBytes) {
      const now = performance.now();
      samples.push({ t: now, b: p.bytes });
      while (samples.length > 2 && now - samples[0].t > 4000) samples.shift();
      const first = samples[0];
      const speed = now > first.t ? ((p.bytes - first.b) / (now - first.t)) * 1000 : 0;
      left.textContent = `${fmtBytes(p.bytes)} of ${fmtBytes(p.totalBytes)}`;
      right.textContent = speed > 0 ? `${fmtBytes(speed)}/s · ${fmtTime((p.totalBytes - p.bytes) / speed)} left` : '';
    } else if (p.total) {
      left.textContent = `${p.done} of ${p.total}`;
      right.textContent = '';
    } else if (p.done !== undefined) {
      left.textContent = `${p.done} found`;
    }
    current.textContent = p.current || '';
    current.title = p.current || '';
  });

  try {
    return await fn(jobId);
  } finally {
    clearTimeout(timer);
    off();
    if (m) m.close();
  }
}
