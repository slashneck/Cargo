'use strict';

// Builds small synthetic FL Studio projects (.flp) with the same event
// layout FL Studio writes, for tests.

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

function ev(id, value) {
  if (id < 64) return Buffer.from([id, value & 0xff]);
  if (id < 128) {
    const b = Buffer.alloc(3);
    b[0] = id;
    b.writeUInt16LE(value, 1);
    return b;
  }
  if (id < 192) {
    const b = Buffer.alloc(5);
    b[0] = id;
    b.writeUInt32LE(value >>> 0, 1);
    return b;
  }
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([Buffer.from([id]), varint(data.length), data]);
}

function text(id, s) {
  return ev(id, Buffer.from(`${s}\0`, 'utf16le'));
}

/** A "Fruity Wrapper" state naming a VST. */
function vstState({ name, vendor, path }) {
  const parts = [Buffer.from([8, 0, 0, 0])];
  const sub = (id, s) => {
    const data = Buffer.from(s, 'utf8');
    const head = Buffer.alloc(12);
    head.writeUInt32LE(id, 0);
    head.writeBigUInt64LE(BigInt(data.length), 4);
    parts.push(head, data);
  };
  if (name) sub(54, name);
  if (path) sub(55, path);
  if (vendor) sub(56, vendor);
  return Buffer.concat(parts);
}

function notes(channels) {
  const out = Buffer.alloc(24 * channels.length);
  channels.forEach((ch, i) => {
    out.writeUInt32LE(i * 96, i * 24);
    out.writeUInt16LE(ch, i * 24 + 6);
    out.writeUInt32LE(96, i * 24 + 8);
    out.writeUInt16LE(60, i * 24 + 12);
  });
  return out;
}

function playlist(items, size = 80) {
  const out = Buffer.alloc(size * items.length);
  items.forEach((item, i) => {
    const o = i * size;
    out.writeUInt32LE(i * 384, o);
    out.writeUInt16LE(20480, o + 4);
    out.writeUInt16LE(item.pattern !== undefined ? 20480 + item.pattern : item.channel, o + 6);
    out.writeUInt32LE(384, o + 8);
    out.writeUInt16LE(500 - i, o + 12);
  });
  return out;
}

/**
 * @param {object} p
 * @param {string} [p.version]
 * @param {{iid:number, name?:string, sample?:string, plugin?:string, vst?:object, embedded?:string, children?:number[]}[]} p.channels
 * @param {{iid:number, name?:string, channels:number[]}[]} [p.patterns]
 * @param {({pattern:number}|{channel:number})[]} [p.playlist]
 * @param {{plugin:string, embedded?:string}[]} [p.mixer]
 */
function project({ version = '25.2.3.5164', title = 'Test Song', licensee = 'Someone Licensed', dataPath = '', channels = [], patterns = [], playlist: items = [], mixer = [] } = {}) {
  const events = [ev(199, Buffer.from(`${version}\0`, 'ascii')), text(200, licensee), text(194, title)];
  if (dataPath) events.push(text(202, dataPath));
  events.push(ev(237, Buffer.alloc(16, 1)));
  for (const c of channels) {
    events.push(ev(64, c.iid), ev(21, c.sample ? 0 : 4));
    events.push(text(201, c.vst ? 'Fruity Wrapper' : c.plugin || ''));
    if (c.name) events.push(text(203, c.name));
    if (c.vst) events.push(ev(213, vstState(c.vst)));
    if (c.embedded) events.push(ev(213, Buffer.concat([Buffer.alloc(9, 7), Buffer.from(`${c.embedded}\0`, 'utf16le')])));
    for (const child of c.children || []) events.push(ev(94, child));
    if (c.sample !== undefined) events.push(text(196, c.sample));
  }
  for (const p of patterns) {
    events.push(ev(65, p.iid));
    if (p.name) events.push(text(193, p.name));
    if (p.channels.length) events.push(ev(224, notes(p.channels)));
  }
  if (items.length) {
    const size = Number(version.split('.')[0]) >= 25 ? 80 : 32;
    events.push(ev(99, 0), text(241, 'Arrangement'), ev(233, playlist(items, size)));
  }
  mixer.forEach((m, i) => {
    events.push(ev(236, Buffer.alloc(12)));
    events.push(text(201, m.plugin));
    events.push(text(203, m.plugin));
    if (m.embedded) events.push(ev(213, Buffer.concat([Buffer.alloc(5, 3), Buffer.from(`${m.embedded}\0`, 'latin1')])));
    events.push(ev(98, i));
  });
  const data = Buffer.concat(events);
  const head = Buffer.alloc(22);
  head.write('FLhd', 0, 'latin1');
  head.writeUInt32LE(6, 4);
  head.writeInt16LE(0, 8);
  head.writeUInt16LE(channels.length, 10);
  head.writeUInt16LE(96, 12);
  head.write('FLdt', 14, 'latin1');
  head.writeUInt32LE(data.length, 18);
  return Buffer.concat([head, data]);
}

module.exports = { project, ev, text };
