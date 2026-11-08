// Stroke icons (24×24 grid, no fills) and the Cargo mark.

const P = {
  folder: '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/>',
  folderOpen: '<path d="M3 17.5V7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h7.5A1.5 1.5 0 0 1 20 9.5V11"/><path d="M3 17.5 5.2 12a1.5 1.5 0 0 1 1.4-1h13.2a1 1 0 0 1 .9 1.4l-2.3 5.7a1.5 1.5 0 0 1-1.4.9H4.5A1.5 1.5 0 0 1 3 17.5z"/>',
  video: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 5v14M17 5v14M3 9.5h4M3 14.5h4M17 9.5h4M17 14.5h4"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7"/>',
  wave: '<path d="M3 12h2M7 8v8M11 4v16M15 7v10M19 10v4M21 12h0"/>',
  audio: '<path d="M9 18V6l11-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  image: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="m21 16-5-5-9 8.5"/>',
  sequence: '<rect x="7" y="7" width="14" height="12" rx="1.5"/><path d="M4 16V5.5A1.5 1.5 0 0 1 5.5 4H17"/><path d="m11 11 4 2-4 2z"/>',
  graphics: '<path d="M12 3 4 17h16z"/><circle cx="12" cy="17" r="0"/><path d="M8.5 11h7"/>',
  data: '<path d="M8 4H6.5A1.5 1.5 0 0 0 5 5.5V10l-1.5 2L5 14v4.5A1.5 1.5 0 0 0 6.5 20H8M16 4h1.5A1.5 1.5 0 0 1 19 5.5V10l1.5 2-1.5 2v4.5a1.5 1.5 0 0 1-1.5 1.5H16"/>',
  cube: '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  project: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8.5 15.5 11 8.5h2l2.5 7M9.7 12.8h4.6"/>',
  comp: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18M8 5v4M13 5v4M18 5v4"/>',
  solid: '<rect x="4.5" y="4.5" width="15" height="15" rx="2"/><path d="M4.5 15 15 4.5M9 19.5 19.5 9"/>',
  placeholder: '<rect x="4.5" y="4.5" width="15" height="15" rx="2" stroke-dasharray="3 2.5"/><path d="M10 10a2 2 0 1 1 2.6 1.9c-.4.2-.6.5-.6.9v.7M12 16h.01"/>',
  all: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  other: '<circle cx="6" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="18" cy="12" r="1"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronLeft: '<path d="m15 6-6 6 6 6"/>',
  arrowUp: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  arrowDown: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  package: '<path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z"/><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9M7.8 5.2l8.4 4.6"/>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v9.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V9M10 13h4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M5.5 7l1 12a1.5 1.5 0 0 0 1.5 1.4h8a1.5 1.5 0 0 0 1.5-1.4l1-12M9 7V4.5h6V7"/>',
  organize: '<path d="M4 6h7M4 12h11M4 18h16"/><path d="m16 4 3 2-3 2"/>',
  export: '<path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 14v4.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V14"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8"/><path d="M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16"/><path d="M20 20v-4h-4"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
  reveal: '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/><path d="M12 11v5M9.5 13.5 12 11l2.5 2.5"/>',
  star: '<path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>',
  starFill: '<path fill="currentColor" d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>',
  tag: '<path d="M3.5 12.1V4.5a1 1 0 0 1 1-1h7.6a1 1 0 0 1 .7.3l8.2 8.2a1 1 0 0 1 0 1.4l-7.6 7.6a1 1 0 0 1-1.4 0L3.8 12.8a1 1 0 0 1-.3-.7z"/><circle cx="8" cy="8" r="1.4"/>',
  locate: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2M11 8v6M8 11h6"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 3 3 5-6"/>',
  alert: '<path d="M10.3 4.2 2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.3 2.4c-.5.2-.8.6-.8 1.1v.5M12 16.5h.01"/>',
  shield: '<path d="M12 3 5 6v5.5c0 4.3 3 7.9 7 9.5 4-1.6 7-5.2 7-9.5V6z"/><path d="m9 12 2 2 4-4"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>',
  plug: '<path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4"/>',
  dashboard: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  tree: '<rect x="3" y="3.5" width="7" height="5" rx="1"/><rect x="14" y="10" width="7" height="5" rx="1"/><rect x="14" y="17" width="7" height="4" rx="1"/><path d="M6.5 8.5v11h7.5M6.5 12.5h7.5"/>',
  duplicate: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8M14 11v6M11 14h6"/>',
  drive: '<rect x="3" y="13" width="18" height="7" rx="2"/><path d="M5.5 13 8 5h8l2.5 8M7 16.5h.01M10 16.5h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>',
  batch: '<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><path d="M17 14v6M14 17h6"/>',
  open: '<path d="M3 17.5V7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h7.5A1.5 1.5 0 0 1 20 9.5V11"/><path d="M3 17.5 5.2 12a1.5 1.5 0 0 1 1.4-1h13.2a1 1 0 0 1 .9 1.4l-2.3 5.7a1.5 1.5 0 0 1-1.4.9H4.5A1.5 1.5 0 0 1 3 17.5z"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  save: '<path d="M5 3.5h11l3.5 3.5v12A1.5 1.5 0 0 1 18 20.5H6A1.5 1.5 0 0 1 4.5 19V5A1.5 1.5 0 0 1 6 3.5z"/><path d="M8 3.5v5h7v-5M8 20.5v-6h8v6"/>',
  filter: '<path d="M4 5h16l-6 7.5V19l-4 1.5v-8z"/>',
  sort: '<path d="M7 4v16M3.5 16.5 7 20l3.5-3.5M17 20V4M13.5 7.5 17 4l3.5 3.5"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  zip: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M10 5h1M10 8h1M10 11h1M10 14h1v2h-1z"/>',
};

export function icon(name, cls = '') {
  const span = document.createElement('span');
  span.innerHTML = `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[name] || P.file}</svg>`;
  return span.firstChild;
}

/** The Cargo mark: a shipping container with a cyan scan line. */
export function logo({ animated = false } = {}) {
  const span = document.createElement('span');
  span.innerHTML = `<svg viewBox="0 0 64 64" fill="none" aria-hidden="true">
    <rect x="6.5" y="17.5" width="51" height="31" rx="4" stroke="#fff" stroke-width="3.4"/>
    <path d="M17 24v18M25 24v18M33 24v18M41 24v18" stroke="#fff" stroke-width="3" stroke-linecap="round"/>
    <path d="M49 17.5v31" stroke="#fff" stroke-width="3" />
    <g class="${animated ? 'scanline' : ''}">
      <path d="M2 33h60" stroke="#00d4ff" stroke-opacity=".28" stroke-width="8" stroke-linecap="round"/>
      <path d="M2 33h60" stroke="#00d4ff" stroke-width="3" stroke-linecap="round"/>
    </g>
  </svg>`;
  return span.firstChild;
}

export const CATEGORY_ICONS = {
  recording: 'mic',
  render: 'wave',
  sample: 'audio',
  stock: 'package',
  video: 'video',
  audio: 'audio',
  image: 'image',
  sequence: 'sequence',
  graphics: 'graphics',
  data: 'data',
  '3d': 'cube',
  project: 'project',
  solid: 'solid',
  placeholder: 'placeholder',
  other: 'file',
};
