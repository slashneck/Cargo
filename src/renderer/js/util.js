// DOM and formatting helpers.

import { icon } from './icons.js';

/**
 * h('div.card#main', {onclick, title, style: {}, dataset: {}}, ...children)
 * Children may be strings, nodes, arrays, or null/false (skipped).
 */
export function h(tag, props, ...children) {
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  const m = /^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i.exec(tag);
  const el = document.createElement((m && m[1]) || 'div');
  if (m && m[2]) {
    for (const part of m[2].match(/[.#][\w-]+/g)) {
      if (part[0] === '.') el.classList.add(part.slice(1));
      else el.id = part.slice(1);
    }
  }
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'class') el.className += ` ${v}`;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k in el && k !== 'list' && k !== 'form') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function replace(el, ...children) {
  clear(el);
  append(el, children);
  return el;
}

/** Button with optional icon. */
export function btn(label, { icon: ic, cls = '', onclick, title, disabled, kbd } = {}) {
  return h(
    `button.btn${cls ? '.' + cls.split(' ').join('.') : ''}`,
    { onclick, title, disabled, type: 'button' },
    ic ? icon(ic) : null,
    label ? h('span', label) : null,
    kbd ? h('kbd', kbd) : null,
  );
}

export function iconBtn(ic, { title, onclick, cls = 'ghost', disabled } = {}) {
  return h(`button.btn.icon-only.${cls.split(' ').join('.')}`, { title, onclick, disabled, type: 'button', 'aria-label': title }, icon(ic));
}

export function checkbox({ checked = false, indeterminate = false, onchange, label, hint, cls = '' } = {}) {
  const input = h('input', { type: 'checkbox', checked });
  input.indeterminate = indeterminate;
  if (onchange) input.addEventListener('change', () => onchange(input.checked, input));
  return h(`label.check${cls ? '.' + cls : ''}`, input, label ? h('span', label, hint ? h('span.hint', hint) : null) : null);
}

// ---------------------------------------------------------------- format

export function fmtBytes(n, digits) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  const d = digits ?? (v >= 100 || i === 0 ? 0 : 1);
  return `${v.toFixed(d)} ${units[i]}`;
}

export function fmtDuration(sec) {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '';
  if (sec < 1) return `${Math.round(sec * 1000) / 1000}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const pad = (x) => String(x).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function fmtTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 1) return '< 1 s';
  if (seconds < 60) return `${Math.round(seconds)} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function fmtDate(ms, withTime = true) {
  if (!ms) return '';
  const d = new Date(ms);
  const date = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  return withTime ? `${date}, ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : date;
}

export function fmtRelative(ms) {
  if (!ms) return '';
  const diff = (Date.now() - ms) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} d ago`;
  return fmtDate(ms, false);
}

export function fmtNum(n) {
  return new Intl.NumberFormat().format(n);
}

export function plural(n, one, many = `${one}s`) {
  return `${fmtNum(n)} ${n === 1 ? one : many}`;
}

export function fmtFps(fps) {
  if (!fps) return '';
  return `${Math.round(fps * 1000) / 1000} fps`;
}

export function resolution(a) {
  return a.width && a.height ? `${a.width}×${a.height}` : '';
}

export function pct(part, whole) {
  if (!whole) return 0;
  return Math.max(0, Math.min(100, (part / whole) * 100));
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function dirname(p) {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return i > 0 ? p.slice(0, i) : p;
}

export function basename(p) {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return i >= 0 ? p.slice(i + 1) : p;
}

/** URL for serving a local file to <img>/<video> through the cargo-media protocol. */
export function mediaUrl(filePath) {
  const bytes = new TextEncoder().encode(filePath);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return `cargo-media://f/${btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

const PREVIEW_IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico']);
const PREVIEW_VIDEO = new Set(['mp4', 'm4v', 'webm', 'mov', 'mkv']);
const PREVIEW_AUDIO = new Set(['wav', 'mp3', 'm4a', 'aac', 'ogg', 'flac', 'opus']);

export function previewKind(ext) {
  if (PREVIEW_IMAGE.has(ext)) return 'image';
  if (PREVIEW_VIDEO.has(ext)) return 'video';
  if (PREVIEW_AUDIO.has(ext)) return 'audio';
  return null;
}

export const STATUS_LABEL = {
  used: 'Used',
  unused: 'Unused',
  missing: 'Missing',
  'unused-missing': 'Unused · missing',
  leftover: 'Not in project',
  generated: 'Solid',
  placeholder: 'Placeholder',
  unknown: 'Unknown',
};

export const STATUS_HELP = {
  used: 'Used in the project and found on disk',
  unused: 'In the project, but not used',
  leftover: 'On disk, but not used by this project or any other project Cargo checked',
  missing: 'Used in the project, but the file is missing',
  'unused-missing': 'Not used, and the file is missing',
  generated: 'Solid, created inside After Effects, no file',
  placeholder: 'Placeholder for footage that was never found',
  unknown: 'Could not be read',
};

export const CATEGORY_LABEL = {
  recording: 'Recording',
  render: 'Render',
  sample: 'Sample',
  stock: 'Stock sample',
  video: 'Video',
  audio: 'Audio',
  image: 'Image',
  sequence: 'Sequence',
  graphics: 'Graphics',
  data: 'Data',
  '3d': '3D',
  project: 'Project',
  solid: 'Solid',
  placeholder: 'Placeholder',
  other: 'Other',
};

export const CATEGORY_PLURAL = {
  recording: 'Recordings',
  render: 'Renders',
  sample: 'Samples',
  stock: 'Stock samples',
  video: 'Video',
  audio: 'Audio',
  image: 'Images',
  sequence: 'Sequences',
  graphics: 'Graphics',
  data: 'Data',
  '3d': '3D',
  project: 'Projects',
  solid: 'Solids',
  placeholder: 'Placeholders',
  other: 'Other',
};

export const CATEGORY_COLORS = {
  recording: '#ff7ab8',
  render: '#7aa7ff',
  sample: '#3ddc97',
  stock: '#6b6b6b',
  video: '#00d4ff',
  audio: '#3ddc97',
  image: '#c9a7ff',
  sequence: '#7aa7ff',
  graphics: '#ffc542',
  data: '#ff9f6b',
  '3d': '#ff7ab8',
  project: '#9aa0a6',
  other: '#6b6b6b',
  solid: '#444',
  placeholder: '#444',
};
