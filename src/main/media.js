'use strict';

// Serves local footage to the window through the cargo-media:// protocol
// (with byte ranges, so video can seek) and produces thumbnails using the
// operating system's thumbnail providers. Only files that belong to a
// scanned project can be served.

const fs = require('fs');
const fsp = fs.promises;
const { Readable } = require('stream');
const { protocol, nativeImage } = require('electron');
const { pathKey } = require('../core/fsutil');
const { extOf } = require('../core/media');

const SCHEME = 'cargo-media';

const MIME = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/webm',
  ogv: 'video/ogg',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  ico: 'image/x-icon',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
};

function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ]);
}

function decodePath(url) {
  const u = new URL(url);
  const b64 = u.pathname.replace(/^\/+/, '').replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64').toString('utf8');
}

/** @param {() => Set<string>} allowed returns the path keys that may be served */
function handleProtocol(allowed) {
  protocol.handle(SCHEME, async (request) => {
    let file;
    try {
      file = decodePath(request.url);
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    if (!allowed().has(pathKey(file))) return new Response('Forbidden', { status: 403 });
    let st;
    try {
      st = await fsp.stat(file);
    } catch {
      return new Response('Not found', { status: 404 });
    }
    const type = MIME[extOf(file)] || 'application/octet-stream';
    const range = /bytes=(\d*)-(\d*)/.exec(request.headers.get('range') || '');
    if (range && st.size > 0) {
      let start = range[1] ? parseInt(range[1], 10) : 0;
      let end = range[2] ? parseInt(range[2], 10) : st.size - 1;
      if (!range[1] && range[2]) {
        start = Math.max(0, st.size - parseInt(range[2], 10));
        end = st.size - 1;
      }
      end = Math.min(end, st.size - 1);
      if (start > end) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${st.size}` } });
      }
      return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), {
        status: 206,
        headers: {
          'Content-Type': type,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${st.size}`,
          'Accept-Ranges': 'bytes',
        },
      });
    }
    return new Response(Readable.toWeb(fs.createReadStream(file)), {
      status: 200,
      headers: { 'Content-Type': type, 'Content-Length': String(st.size), 'Accept-Ranges': 'bytes' },
    });
  });
}

// --- thumbnails -------------------------------------------------------------

const cache = new Map();
const CACHE_MAX = 600;
let active = 0;
const waiting = [];

function limit(fn) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      active++;
      try {
        resolve(await fn());
      } catch (err) {
        reject(err);
      } finally {
        active--;
        if (waiting.length) waiting.shift()();
      }
    };
    if (active < 3) run();
    else waiting.push(run);
  });
}

async function thumbnail(file, mtime) {
  if (typeof nativeImage.createThumbnailFromPath !== 'function') return null;
  const key = `${pathKey(file)}|${mtime || 0}`;
  if (cache.has(key)) return cache.get(key);
  let result = null;
  try {
    const img = await limit(() => nativeImage.createThumbnailFromPath(file, { width: 480, height: 480 }));
    if (img && !img.isEmpty()) result = img.toDataURL();
  } catch {
    result = null;
  }
  cache.set(key, result);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return result;
}

module.exports = { SCHEME, registerScheme, handleProtocol, thumbnail };
