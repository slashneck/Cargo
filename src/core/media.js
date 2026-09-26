'use strict';

// File-type knowledge: categories, previewability, and compression hints.

const CATEGORY_EXTS = {
  video: ['mov', 'mp4', 'm4v', 'avi', 'mxf', 'webm', 'mkv', 'wmv', 'flv', 'mts', 'm2ts', 'mpg', 'mpeg', 'm2v', 'r3d', 'braw', 'crm', 'ari', 'dv', '3gp', 'hevc', 'vob', 'swf'],
  audio: ['wav', 'mp3', 'aif', 'aiff', 'aifc', 'm4a', 'aac', 'ogg', 'flac', 'wma', 'bwf', 'ac3'],
  image: ['png', 'jpg', 'jpeg', 'tif', 'tiff', 'psd', 'psb', 'exr', 'sxr', 'dpx', 'cin', 'tga', 'bmp', 'gif', 'webp', 'heic', 'heif', 'hdr', 'rla', 'rpf', 'iff', 'pic', 'pct', 'pict', 'sgi', 'rgb', 'dng', 'cr2', 'cr3', 'nef', 'arw', 'raf', 'orf', 'rw2', 'jp2', 'ico', 'avif'],
  graphics: ['ai', 'eps', 'pdf', 'svg'],
  data: ['json', 'mgjson', 'csv', 'tsv', 'txt', 'srt', 'vtt', 'xml'],
  '3d': ['obj', 'glb', 'gltf', 'fbx', 'c4d', 'abc', 'usd', 'usdz'],
  project: ['aep', 'aepx', 'prproj', 'mogrt'],
};

const EXT_TO_CATEGORY = new Map();
for (const [cat, exts] of Object.entries(CATEGORY_EXTS)) {
  for (const e of exts) EXT_TO_CATEGORY.set(e, cat);
}

const CATEGORY_LABELS = {
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
  folder: 'Folders',
  other: 'Other',
};

// Formats that can be sequences when AE imports numbered stills.
const SEQUENCE_EXTS = new Set([...CATEGORY_EXTS.image, 'ai', 'eps', 'pdf', 'svg']);

// Formats Chromium can display or play directly.
const PREVIEW_IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico']);
const PREVIEW_VIDEO = new Set(['mp4', 'm4v', 'webm', 'mov', 'ogv', 'mkv']);
const PREVIEW_AUDIO = new Set(['wav', 'mp3', 'm4a', 'aac', 'ogg', 'flac', 'opus']);

// Already-compressed media gains nothing from deflate; store it for speed.
const COMPRESSIBLE = new Set(['aep', 'aepx', 'json', 'mgjson', 'csv', 'tsv', 'txt', 'srt', 'vtt', 'xml', 'jsx', 'jsxbin', 'svg', 'obj', 'gltf', 'md', 'html']);

function extOf(p) {
  const name = String(p).split(/[\\/]/).pop() || '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function categoryOf(ext) {
  return EXT_TO_CATEGORY.get(ext) || 'other';
}

function previewKind(ext) {
  if (PREVIEW_IMAGE.has(ext)) return 'image';
  if (PREVIEW_VIDEO.has(ext)) return 'video';
  if (PREVIEW_AUDIO.has(ext)) return 'audio';
  return null;
}

module.exports = {
  CATEGORY_LABELS,
  SEQUENCE_EXTS,
  COMPRESSIBLE,
  extOf,
  categoryOf,
  previewKind,
};
