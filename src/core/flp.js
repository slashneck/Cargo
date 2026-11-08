'use strict';

// FL Studio project (.flp) reader and writer.
//
// An .flp is an "FLhd" header (format, channel count, PPQ) and an "FLdt"
// chunk with a flat stream of events. Each event is a 1-byte id followed by
// 1, 2 or 4 bytes of data (ids below 64, 128 and 192), or by a varint length
// and that many bytes (ids 192-255: strings and structs). Strings are UTF-16
// since FL Studio 11.5 and ANSI before.
//
// What Cargo needs from it (ids verified against FL Studio 10.9 to 25.2):
//   64  channel starts (value: channel id)     21  channel type
//   196 channel sample path                    94  child channel of a layer
//   201 plugin internal name                   203 plugin / channel name
//   213 plugin state (VST name, vendor, path)  98  mixer slot ends
//   65  pattern starts                         224 pattern notes (24 bytes each)
//   99  arrangement starts                     233 playlist items
//   236 mixer insert (marks the mixer section) 199 FL Studio version
//   200 licensee                               202 project data folder
//   237 creation date and time spent
//
// Playlist items are 32 bytes up to FL 20.8, 60 bytes from 20.99 and 80 bytes
// from 24.2. Each holds 20480 at offset 4 and an index at offset 6: at or
// below 20480 it is a channel (audio and automation clips), above it a
// pattern (index - 20480).

const EV = {
  CHANNEL_TYPE: 21,
  CHANNEL_NEW: 64,
  PATTERN_NEW: 65,
  CHILD: 94,
  SLOT_INDEX: 98,
  ARRANGEMENT_NEW: 99,
  NAME: 192,
  PATTERN_NAME: 193,
  TITLE: 194,
  SAMPLE_PATH: 196,
  VERSION: 199,
  LICENSEE: 200,
  PLUGIN_INTERNAL: 201,
  DATA_PATH: 202,
  PLUGIN_NAME: 203,
  GENRE: 206,
  ARTISTS: 207,
  PLUGIN_DATA: 213,
  NOTES: 224,
  PLAYLIST: 233,
  INSERT_FLAGS: 236,
  TIMESTAMP: 237,
  TRACK_NAME: 239,
  ARRANGEMENT_NAME: 241,
};

// Text events: 192-207 plus a few newer ones.
const TEXT_IDS = new Set([...Array.from({ length: 16 }, (_, i) => 192 + i), 231, 239, 241]);

const PATTERN_BASE = 20480;
const NOTE_SIZE = 24;
const WRAPPER = 'Fruity Wrapper';

// Audio and other files that samplers and effects load.
const AUDIO_EXT = 'wav|wave|mp3|flac|ogg|oga|aif|aiff|aifc|wv|m4a|aac|rex|rx2|sf2|sfz|mid|midi|fst|zip|ds|dwp|wma|opus';
const EMBEDDED_PATH = new RegExp(`(?:%[A-Za-z]+%|[A-Za-z]:\\\\|\\\\\\\\)[^\\x00-\\x1f"<>|*?]{1,400}?\\.(?:${AUDIO_EXT})(?![A-Za-z0-9])`, 'gi');

class FlpFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FlpFormatError';
  }
}

// Decoding UTF-16 straight from a buffer slice that starts at an odd memory
// offset crashes Node (heap corruption, seen with Node 24). Copy such slices first.
function utf16(d) {
  return (d.byteOffset % 2 ? Buffer.from(d) : d).toString('utf16le');
}

function readVarint(buf, off, end) {
  let value = 0;
  let shift = 0;
  for (;;) {
    if (off >= end || shift > 35) throw new FlpFormatError('The project file is damaged (bad event length).');
    const b = buf[off++];
    value += (b & 0x7f) * 2 ** shift;
    if (!(b & 0x80)) break;
    shift += 7;
  }
  return { value, off };
}

function varint(n) {
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return Buffer.from(out);
}

/** Splits an .flp into its events. Every event keeps its byte range. */
function readEvents(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new FlpFormatError('The file is too small to be an FL Studio project.');
  if (buf.toString('latin1', 0, 4) !== 'FLhd') throw new FlpFormatError('Not an FL Studio project: the file header is missing.');
  if (buf.readUInt32LE(4) !== 6) throw new FlpFormatError('Unexpected FL Studio project header.');
  if (buf.toString('latin1', 14, 18) !== 'FLdt') throw new FlpFormatError('Not an FL Studio project: the data chunk is missing.');
  const warnings = [];
  const declared = buf.readUInt32LE(18);
  let end = 22 + declared;
  if (end > buf.length) {
    warnings.push('The project file appears to be truncated; some channels may be missing.');
    end = buf.length;
  }
  const events = [];
  let off = 22;
  while (off < end) {
    const id = buf[off];
    const start = off;
    let dataStart = off + 1;
    let len;
    if (id < 64) len = 1;
    else if (id < 128) len = 2;
    else if (id < 192) len = 4;
    else {
      const v = readVarint(buf, dataStart, end);
      len = v.value;
      dataStart = v.off;
    }
    if (dataStart + len > end) {
      warnings.push('The project file is damaged near the end; the rest of it was skipped.');
      events.push({ id: -1, start, dataStart: start, end, raw: true });
      off = end;
      break;
    }
    events.push({ id, start, dataStart, end: dataStart + len });
    off = dataStart + len;
  }
  return {
    buffer: buf,
    format: buf.readInt16LE(8),
    channelCount: buf.readUInt16LE(10),
    ppq: buf.readUInt16LE(12),
    events,
    trailing: buf.subarray(end),
    warnings,
  };
}

function data(file, e) {
  return e.newData || file.buffer.subarray(e.dataStart, e.end);
}

function u16(file, e) {
  const d = data(file, e);
  return d.length >= 2 ? d.readUInt16LE(0) : d[0] || 0;
}

function parseVersion(text) {
  const parts = String(text || '').split('.').map((n) => parseInt(n, 10) || 0);
  return { major: parts[0] || 0, minor: parts[1] || 0, text };
}

function isUnicode(version) {
  return version.major > 11 || (version.major === 11 && version.minor >= 5);
}

function textOf(file, e, unicode) {
  const d = data(file, e);
  return (unicode ? utf16(d) : d.toString('latin1')).replace(/\0+$/, '');
}

function encodeText(text, unicode) {
  return unicode ? Buffer.from(`${text}\0`, 'utf16le') : Buffer.from(`${text}\0`, 'latin1');
}

/** Item size of the playlist event: by version, confirmed by the 20480 marker in every item. */
function playlistItemSize(d, version) {
  const preferred = version.major > 24 || (version.major === 24 && version.minor >= 2) ? 80 : version.major > 20 || (version.major === 20 && version.minor >= 99) ? 60 : 32;
  const valid = (size) => {
    if (!d.length || d.length % size) return false;
    for (let o = 0; o < d.length; o += size) if (d.readUInt16LE(o + 4) !== PATTERN_BASE) return false;
    return true;
  };
  for (const size of [preferred, 80, 60, 32]) if (valid(size)) return size;
  return null;
}

/** Name, vendor and file of a VST inside a "Fruity Wrapper" state block. */
function parseWrapper(d) {
  const out = {};
  if (d.length < 4) return out;
  let off = 4;
  while (off + 12 <= d.length) {
    const id = d.readUInt32LE(off);
    const size = Number(d.readBigUInt64LE(off + 4));
    const start = off + 12;
    if (size < 0 || start + size > d.length) break;
    const text = () => d.toString('utf8', start, start + size).replace(/\0+$/, '');
    if (id === 54) out.name = text();
    else if (id === 55) out.path = text();
    else if (id === 56) out.vendor = text();
    off = start + size;
  }
  return out;
}

/** Sample files named inside a plugin's state (Slicex, DirectWave, Convolver…). */
function embeddedPaths(d) {
  const found = new Set();
  const scan = (text) => {
    for (const m of text.matchAll(EMBEDDED_PATH)) found.add(m[0]);
  };
  scan(d.toString('latin1'));
  scan(utf16(d));
  if (d.length > 1) scan(utf16(d.subarray(1)));
  return [...found].filter((p) => !/[Ā-￿]{3,}/.test(p) || /^[A-Za-z]:\\|^%/.test(p));
}

/**
 * Parses an .flp into the project description Cargo uses for every format:
 * footage (sample files), comps (arrangements and patterns), effects
 * (plugins) and which footage the song actually plays.
 */
function parseFlp(buf) {
  const file = readEvents(buf);
  const warnings = [...file.warnings];
  let version = parseVersion('');
  let unicode = true;

  const meta = { title: '', genre: '', artists: '', dataPath: '', licensee: '' };
  const channels = new Map();
  const patterns = new Map();
  const arrangements = [];
  const mixerPlugins = [];
  let channel = null;
  let pattern = null;
  let arrangement = null;
  let inMixer = false;
  let insert = -1;
  let slot = null;

  const plugin = () => (inMixer ? (slot ||= { insert }) : channel && (channel.plugin ||= {}));

  for (const e of file.events) {
    if (e.raw) continue;
    switch (e.id) {
      case EV.VERSION:
        version = parseVersion(data(file, e).toString('ascii').replace(/\0+$/, ''));
        unicode = isUnicode(version);
        break;
      case EV.CHANNEL_NEW:
        if (inMixer) break;
        channel = { iid: u16(file, e), type: null, name: '', samplePath: null, children: [], plugin: null, embedded: [] };
        channels.set(channel.iid, channel);
        break;
      case EV.CHANNEL_TYPE:
        if (channel && !inMixer) channel.type = data(file, e)[0];
        break;
      case EV.CHILD:
        if (channel && !inMixer) channel.children.push(u16(file, e));
        break;
      case EV.NAME:
        if (channel && !inMixer && !channel.name) channel.name = textOf(file, e, unicode);
        break;
      case EV.SAMPLE_PATH:
        if (channel && !inMixer) channel.samplePath = textOf(file, e, unicode);
        break;
      case EV.PLUGIN_INTERNAL: {
        const p = plugin();
        if (p) p.internal = textOf(file, e, unicode);
        break;
      }
      case EV.PLUGIN_NAME: {
        const p = plugin();
        if (p) p.name = textOf(file, e, unicode);
        if (channel && !inMixer) channel.name = textOf(file, e, unicode);
        break;
      }
      case EV.PLUGIN_DATA: {
        const p = plugin();
        if (!p) break;
        const d = data(file, e);
        if (p.internal === WRAPPER) p.vst = parseWrapper(d);
        const paths = embeddedPaths(d);
        if (paths.length) (inMixer ? (p.embedded ||= []) : channel.embedded).push(...paths);
        break;
      }
      case EV.INSERT_FLAGS:
        inMixer = true;
        insert++;
        slot = null;
        break;
      case EV.SLOT_INDEX:
        if (inMixer && slot && slot.internal !== undefined) mixerPlugins.push({ ...slot, slot: u16(file, e) });
        slot = null;
        break;
      case EV.PATTERN_NEW: {
        const iid = u16(file, e);
        pattern = patterns.get(iid) || { iid, name: '', notes: new Map() };
        patterns.set(iid, pattern);
        break;
      }
      case EV.PATTERN_NAME:
        if (pattern) pattern.name = textOf(file, e, unicode);
        break;
      case EV.NOTES: {
        if (!pattern) break;
        const d = data(file, e);
        for (let o = 0; o + NOTE_SIZE <= d.length; o += NOTE_SIZE) {
          const ch = d.readUInt16LE(o + 6);
          pattern.notes.set(ch, (pattern.notes.get(ch) || 0) + 1);
        }
        break;
      }
      case EV.ARRANGEMENT_NEW:
        arrangement = { iid: u16(file, e), name: '', items: [] };
        arrangements.push(arrangement);
        break;
      case EV.ARRANGEMENT_NAME:
        if (arrangement) arrangement.name = textOf(file, e, unicode);
        break;
      case EV.PLAYLIST: {
        const d = data(file, e);
        if (!d.length) break;
        if (!arrangement) {
          arrangement = { iid: 0, name: '', items: [] };
          arrangements.push(arrangement);
        }
        const size = playlistItemSize(d, version);
        if (!size) {
          warnings.push('The playlist uses a layout Cargo doesn’t know yet; usage may be incomplete.');
          break;
        }
        for (let o = 0; o < d.length; o += size) {
          const index = d.readUInt16LE(o + 6);
          arrangement.items.push(index <= PATTERN_BASE ? { kind: 'channel', ref: index } : { kind: 'pattern', ref: index - PATTERN_BASE });
        }
        break;
      }
      case EV.TITLE:
        meta.title = textOf(file, e, unicode);
        break;
      case EV.GENRE:
        meta.genre = textOf(file, e, unicode);
        break;
      case EV.ARTISTS:
        meta.artists = textOf(file, e, unicode);
        break;
      case EV.DATA_PATH:
        meta.dataPath = textOf(file, e, unicode);
        break;
      case EV.LICENSEE:
        meta.licensee = textOf(file, e, unicode);
        break;
      default:
        break;
    }
  }
  if (!version.text) warnings.push('The FL Studio version could not be read.');

  return buildProject({ channels, patterns, arrangements, mixerPlugins, version, meta, warnings, file });
}

// Ids for the generic model: footage and comps share one id space.
const ID = { channel: (iid) => 100000 + iid, embedded: (n) => 200000 + n, pattern: (iid) => 800000 + iid, arrangement: (iid) => 900000 + iid };

function baseName(p) {
  const parts = String(p).split(/[\\/]/);
  return parts[parts.length - 1] || String(p);
}

/** The plugin's identity in the plugin list: "Vendor · Name" for VSTs, the internal name otherwise. */
function pluginKey(p) {
  if (!p || !p.internal) return null;
  if (p.internal !== WRAPPER) return p.internal;
  return [p.vst && p.vst.vendor, pluginLabel(p)].filter(Boolean).join(' · ');
}

function pluginLabel(p) {
  if (!p) return null;
  if (p.internal === WRAPPER) return (p.vst && p.vst.name) || p.name || 'VST plugin';
  return p.internal || null;
}

function buildProject({ channels, patterns, arrangements, mixerPlugins, version, meta, warnings, file }) {
  // What the song plays: patterns and clips placed in any arrangement. A
  // project with an empty playlist (pattern mode only) counts every pattern.
  const placedPatterns = new Set();
  const placedChannels = new Set();
  for (const a of arrangements) {
    for (const item of a.items) {
      if (item.kind === 'pattern') placedPatterns.add(item.ref);
      else placedChannels.add(item.ref);
    }
  }
  if (!placedPatterns.size && !placedChannels.size) for (const iid of patterns.keys()) placedPatterns.add(iid);
  const usedChannels = new Set(placedChannels);
  for (const iid of placedPatterns) {
    const p = patterns.get(iid);
    if (p) for (const ch of p.notes.keys()) usedChannels.add(ch);
  }
  // Layer channels trigger their children.
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of channels.values()) {
      if (!usedChannels.has(c.iid)) continue;
      for (const child of c.children) {
        if (!usedChannels.has(child)) {
          usedChannels.add(child);
          grew = true;
        }
      }
    }
  }

  const footage = [];
  const usedIds = new Set();
  const footageForChannel = new Map();
  let embeddedCount = 0;
  const addFootage = (item, used) => {
    footage.push(item);
    if (used) usedIds.add(item.id);
  };
  for (const c of channels.values()) {
    const channelName = c.name || pluginLabel(c.plugin) || `Channel ${c.iid + 1}`;
    if (c.samplePath) {
      const item = fileItem(ID.channel(c.iid), c.samplePath, channelName, 'channel');
      addFootage(item, usedChannels.has(c.iid));
      footageForChannel.set(c.iid, item.id);
    }
    for (const p of new Set(c.embedded)) {
      if (p === c.samplePath) continue;
      addFootage(fileItem(ID.embedded(embeddedCount++), p, `${channelName} (${pluginLabel(c.plugin) || 'plugin'})`, 'plugin'), usedChannels.has(c.iid));
    }
  }
  for (const m of mixerPlugins) {
    for (const p of new Set(m.embedded || [])) {
      addFootage(fileItem(ID.embedded(embeddedCount++), p, `Mixer insert ${m.insert} (${pluginLabel(m) || 'effect'})`, 'plugin'), true);
    }
  }

  // Patterns and arrangements play the part of compositions.
  const comps = [];
  for (const p of patterns.values()) {
    const layers = [];
    for (const [iid, count] of p.notes) {
      const c = channels.get(iid);
      const label = pluginLabel(c && c.plugin);
      const key = pluginKey(c && c.plugin);
      layers.push({ index: layers.length + 1, name: c ? c.name || label || `Channel ${iid + 1}` : `Channel ${iid + 1}`, sourceId: footageForChannel.get(iid) || 0, effects: key ? [key] : [], notes: count });
    }
    comps.push({ id: ID.pattern(p.iid), name: p.name || `Pattern ${p.iid}`, parentId: 0, kind: 'pattern', width: null, height: null, fps: null, duration: null, layers, effects: layers.flatMap((l) => l.effects) });
  }
  for (const a of arrangements) {
    const counts = new Map();
    for (const item of a.items) {
      const id = item.kind === 'pattern' ? ID.pattern(item.ref) : footageForChannel.get(item.ref);
      if (id) counts.set(id, (counts.get(id) || 0) + 1);
    }
    const layers = [...counts].map(([sourceId, n], i) => ({ index: i + 1, name: '', sourceId, effects: [], clips: n }));
    comps.push({ id: ID.arrangement(a.iid), name: a.name || (arrangements.length > 1 ? `Arrangement ${a.iid + 1}` : 'Playlist'), parentId: 0, kind: 'arrangement', width: null, height: null, fps: null, duration: null, layers, effects: [] });
  }

  // Plugins, with third-party (VST) ones marked.
  const plugins = new Map();
  const addPlugin = (p, where, compIds = []) => {
    if (!p || !p.internal) return;
    const isVst = p.internal === WRAPPER;
    const display = pluginLabel(p);
    const key = isVst ? `vst:${(p.vst && p.vst.vendor) || ''}:${display}` : `fl:${p.internal}`;
    let e = plugins.get(key);
    if (!e) {
      plugins.set(key, (e = { matchName: pluginKey(p), displayName: display, count: 0, comps: new Set(), builtIn: !isVst, pseudo: false, where: new Set() }));
    }
    e.count++;
    e.where.add(where);
    compIds.forEach((id) => e.comps.add(id));
  };
  for (const c of channels.values()) {
    const inPatterns = [...patterns.values()].filter((p) => p.notes.has(c.iid)).map((p) => ID.pattern(p.iid));
    addPlugin(c.plugin, 'instrument', inPatterns);
  }
  for (const m of mixerPlugins) addPlugin(m, 'effect');
  const effects = [...plugins.values()]
    .map((e) => ({ ...e, comps: [...e.comps], where: [...e.where] }))
    .sort((a, b) => Number(a.builtIn) - Number(b.builtIn) || b.count - a.count || a.displayName.localeCompare(b.displayName));

  const project = {
    format: 'flp',
    app: 'FL Studio',
    creatorTool: version.text ? `FL Studio ${version.text}` : 'FL Studio',
    createDate: null,
    modifyDate: null,
    folders: [],
    comps,
    footage,
    effects,
    expressionRefs: [],
    usedIds,
    dataPath: meta.dataPath || null,
    title: meta.title || null,
    warnings,
  };
  Object.defineProperty(project, 'file', { value: file, enumerable: false });
  return project;
}

function fileItem(id, rawPath, group, origin) {
  return {
    id,
    name: baseName(rawPath),
    parentId: 0,
    group,
    origin,
    kind: 'file',
    path: rawPath,
    extraPaths: [],
    targetIsFolder: false,
    fileType: null,
    width: null,
    height: null,
    duration: null,
    fps: null,
    solidColor: null,
    solidName: null,
  };
}

/** Writes the events back; edited events get their new data. */
function serializeFlp(file) {
  const parts = [file.buffer.subarray(0, 22)];
  let size = 0;
  for (const e of file.events) {
    let chunk;
    if (!e.newData) chunk = file.buffer.subarray(e.start, e.end);
    else if (e.id < 192) chunk = Buffer.concat([Buffer.from([e.id]), e.newData]);
    else chunk = Buffer.concat([Buffer.from([e.id]), varint(e.newData.length), e.newData]);
    parts.push(chunk);
    size += chunk.length;
  }
  const head = Buffer.from(parts[0]);
  head.writeUInt32LE(size, 18);
  parts[0] = head;
  parts.push(file.trailing);
  return Buffer.concat(parts);
}

/**
 * Rewrites sample paths. `mapping` maps the stored path (exactly as in the
 * file, placeholders included) to a new one. Options as for .aep files:
 *   fallback(path)     new path for sample references not in `mapping`
 *   scrubText(string)  applied to every other text event
 *   privateCopy        also clears the licensee, data folder and dates
 * Paths inside plugin states are left alone.
 */
function rewriteFlpPaths(buf, mapping, { fallback = null, scrubText = null, privateCopy = false } = {}) {
  const file = readEvents(buf);
  let unicode = true;
  let changed = 0;
  let inMixer = false;
  for (const e of file.events) {
    if (e.raw) continue;
    if (e.id === EV.VERSION) unicode = isUnicode(parseVersion(data(file, e).toString('ascii').replace(/\0+$/, '')));
    if (e.id === EV.INSERT_FLAGS) inMixer = true;
    if (e.id === EV.SAMPLE_PATH && !inMixer) {
      const current = textOf(file, e, unicode);
      const next = mapping.has(current) ? mapping.get(current) : fallback && current ? fallback(current) : null;
      if (next && next !== current) {
        e.newData = encodeText(next, unicode);
        changed++;
      }
      continue;
    }
    if (privateCopy && (e.id === EV.LICENSEE || e.id === EV.DATA_PATH)) {
      e.newData = encodeText('', unicode);
      continue;
    }
    if (privateCopy && e.id === EV.TIMESTAMP) {
      e.newData = Buffer.alloc(data(file, e).length);
      continue;
    }
    if (scrubText && TEXT_IDS.has(e.id)) {
      const text = textOf(file, e, unicode);
      const clean = scrubText(text);
      if (clean !== text) e.newData = encodeText(clean, unicode);
    }
  }
  return { buffer: serializeFlp(file), changed };
}

/** Rebuilds every event and checks the result equals the input. */
function verifyRoundTrip(buf) {
  const file = readEvents(buf);
  for (const e of file.events) {
    if (e.raw) continue;
    e.newData = Buffer.from(buf.subarray(e.dataStart, e.end));
  }
  return serializeFlp(file).equals(buf);
}

module.exports = { parseFlp, rewriteFlpPaths, verifyRoundTrip, readEvents, FlpFormatError, EV, PATTERN_BASE };
