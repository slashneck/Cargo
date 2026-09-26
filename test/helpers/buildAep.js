'use strict';

// Builds small synthetic .aep files with the same chunk layout After Effects
// writes, so tests can exercise the parser without shipping real projects.

function chunk(id, data) {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const head = Buffer.alloc(8);
  head.write(id, 0, 4, 'latin1');
  head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, body, body.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

function list(type, children) {
  return chunk('LIST', Buffer.concat([Buffer.from(type, 'latin1'), ...children]));
}

function utf8(s) {
  return chunk('Utf8', Buffer.from(s, 'utf8'));
}

function idta(type, id) {
  const b = Buffer.alloc(84);
  b.writeUInt16BE(type, 0);
  b.writeUInt32BE(id, 16);
  return chunk('idta', b);
}

function tdmn(name) {
  const b = Buffer.alloc(40);
  b.write(name, 0, 'latin1');
  return chunk('tdmn', b);
}

function folder(id, name, children) {
  return list('Item', [idta(1, id), utf8(name), list('Sfdr', children)]);
}

function footage(id, { name = '', path = null, width = 1920, height = 1080, duration = 0, fps = 0, fileType = 'MooV', solid = null } = {}) {
  const sspc = Buffer.alloc(200);
  sspc.write(fileType, 22, 'latin1');
  sspc.writeUInt16BE(width, 32);
  sspc.writeUInt16BE(height, 36);
  sspc.writeUInt32BE(Math.round(duration * 600), 38);
  sspc.writeUInt32BE(600, 42);
  sspc.writeUInt32BE(Math.floor(fps), 56);
  sspc.writeUInt16BE(Math.round((fps % 1) * 65536), 60);
  const opti = Buffer.alloc(300);
  const pin = [chunk('sspc', sspc), utf8('')];
  if (solid) {
    opti.write('Soli', 0, 'latin1');
    opti.writeUInt16BE(9, 4);
    opti.writeFloatBE(1, 10);
    opti.writeFloatBE(solid.color[0], 14);
    opti.writeFloatBE(solid.color[1], 18);
    opti.writeFloatBE(solid.color[2], 22);
    opti.write(solid.name, 26, 'utf8');
    pin.push(chunk('opti', opti));
  } else {
    opti.write(fileType, 0, 'latin1');
    pin.push(chunk('opti', opti));
    pin.push(list('Als2', [chunk('alas', JSON.stringify({ fullpath: path, target_is_folder: false }))]));
  }
  return list('Item', [idta(7, id), utf8(name), list('Pin ', pin)]);
}

function comp(id, name, { width = 1920, height = 1080, fps = 25, duration = 10, layers = [] } = {}) {
  const cdta = Buffer.alloc(204);
  cdta.writeUInt32BE(1000, 4);
  cdta.writeUInt32BE(Math.round(fps * 1000), 8);
  cdta.writeUInt32BE(Math.round(duration * 600), 44);
  cdta.writeUInt32BE(600, 48);
  cdta.writeUInt16BE(width, 140);
  cdta.writeUInt16BE(height, 142);
  cdta.writeUInt16BE(Math.round(fps), 156);
  const layerChunks = layers.map((l, i) => {
    const ldta = Buffer.alloc(160);
    ldta.writeUInt32BE(i + 1, 0);
    ldta.writeUInt32BE(l.source || 0, 40);
    const props = [];
    if (l.effects && l.effects.length) {
      const parade = [];
      for (const mn of l.effects) parade.push(tdmn(mn), list('sspc', [chunk('fnam', utf8(mn))]));
      props.push(list('tdgp', [tdmn('ADBE Effect Parade'), list('tdgp', parade)]));
    }
    return list('Layr', [chunk('ldta', ldta), utf8(l.name || ''), ...props]);
  });
  return list('Item', [idta(4, id), utf8(name), chunk('cdta', cdta), ...layerChunks]);
}

function project(items, { xmp = '<x:xmpmeta><xmp:CreatorTool>Adobe After Effects 2024 (Windows)</xmp:CreatorTool></x:xmpmeta>', extraTop = [] } = {}) {
  const body = Buffer.concat([
    Buffer.from('Egg!', 'latin1'),
    chunk('svap', Buffer.from([0, 0, 0, 1])),
    chunk('head', Buffer.alloc(19)), // odd length on purpose: exercises padding
    ...extraTop,
    list('Fold', [chunk('fdta', Buffer.alloc(14)), ...items]),
  ]);
  const head = Buffer.alloc(8);
  head.write('RIFX', 0, 4, 'latin1');
  head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, body, Buffer.from(xmp, 'utf8')]);
}

module.exports = { chunk, list, utf8, tdmn, folder, footage, comp, project };
