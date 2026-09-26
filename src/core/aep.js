'use strict';

// Turns the raw RIFX chunk tree of an .aep into project items: folders,
// compositions (with their layers) and footage (files, solids, placeholders).
//
// Layout notes (big-endian throughout), verified against AE-saved projects:
//   LIST Fold               project root folder
//     LIST Item             one per project item
//       idta                u16 type @0 (1 folder, 4 comp, 7 footage), u32 id @16
//       Utf8                item name (empty for file footage -> use file name)
//       LIST Sfdr           folder contents (nested LIST Item)
//       cdta                comp: fps = u32@8 / u32@4, duration = u32@44 / u32@48,
//                           width u16@140, height u16@142, fps (int) u16@156
//       LIST Layr           comp layer; ldta u32@40 = source item id, Utf8 = name
//       LIST Pin            footage: sspc, opti, LIST Als2 { alas (JSON path) }
//   LIST EfdG               effect definitions used in the project (tdmn + fnam)

const riff = require('./riff');

const ITEM_FOLDER = 1;
const ITEM_COMP = 4;
const ITEM_FOOTAGE = 7;

function u16(buf, off) {
  return off + 2 <= buf.length ? buf.readUInt16BE(off) : 0;
}
function u32(buf, off) {
  return off + 4 <= buf.length ? buf.readUInt32BE(off) : 0;
}
function f32(buf, off) {
  return off + 4 <= buf.length ? buf.readFloatBE(off) : 0;
}

function sane(value, min, max) {
  return Number.isFinite(value) && value >= min && value <= max ? value : null;
}

function round(value, digits) {
  if (value === null) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/** Reads a chunk whose payload is itself a single Utf8 chunk (e.g. fnam). */
function nestedUtf8(data) {
  if (data.length >= 8 && data.toString('latin1', 0, 4) === 'Utf8') {
    const len = Math.min(data.readUInt32BE(4), data.length - 8);
    return riff.utf8String(data.subarray(8, 8 + len));
  }
  return riff.utf8String(data);
}

function parseAlas(data) {
  const text = riff.utf8String(data).trim();
  if (!text) return null;
  try {
    const json = JSON.parse(text);
    if (json && typeof json.fullpath === 'string') {
      return { fullpath: json.fullpath, targetIsFolder: !!json.target_is_folder, json };
    }
  } catch {
    // Fall through to a lenient match below.
  }
  const m = /"fullpath"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  if (m) {
    try {
      return { fullpath: JSON.parse(`"${m[1]}"`), targetIsFolder: /"target_is_folder"\s*:\s*true/.test(text), json: null };
    } catch {
      return { fullpath: m[1], targetIsFolder: false, json: null };
    }
  }
  return null;
}

function parseCompData(data) {
  const base = u32(data, 4);
  const scaled = u32(data, 8);
  let fps = base > 0 ? scaled / base : null;
  if (!sane(fps, 0.5, 1000)) fps = sane(u16(data, 156), 1, 1000);
  const durDiv = u32(data, 48);
  const duration = durDiv > 0 ? u32(data, 44) / durDiv : null;
  return {
    width: sane(u16(data, 140), 1, 30000),
    height: sane(u16(data, 142), 1, 30000),
    fps: round(fps, 3),
    duration: round(sane(duration, 0, 86400 * 7), 3),
  };
}

function parseSourceSpec(data) {
  if (!data || data.length < 46) return {};
  const fileType = riff.cString(data.subarray(22, 26)).trim();
  const durDiv = u32(data, 42);
  const duration = durDiv > 0 ? u32(data, 38) / durDiv : null;
  const fps = u32(data, 56) + u16(data, 60) / 65536;
  return {
    fileType: /^[\x20-\x7e]{1,4}$/.test(fileType) ? fileType : null,
    width: sane(u16(data, 32), 1, 65535),
    height: sane(u16(data, 36), 1, 65535),
    duration: round(sane(duration, 0.0001, 86400 * 7), 3),
    fps: round(sane(fps, 0.5, 1000), 3),
  };
}

function parseOptions(data) {
  if (!data || data.length < 6) return {};
  const code = data.toString('latin1', 0, 4);
  const type = u16(data, 4);
  if (code === 'Soli') {
    return {
      solid: true,
      color: [f32(data, 14), f32(data, 18), f32(data, 22)].map((c) => Math.max(0, Math.min(1, c))),
      name: data.length > 26 ? riff.utf8String(data.subarray(26, Math.min(data.length, 26 + 256))).replace(/\0.*$/s, '') : '',
    };
  }
  if (type === 2) {
    return { placeholder: true, name: data.length > 10 ? riff.utf8String(data.subarray(10)).replace(/\0.*$/s, '') : '' };
  }
  return {};
}

function itemName(tree, itemNode) {
  const n = riff.firstChild(itemNode, 'Utf8');
  return n ? riff.utf8String(riff.chunkData(tree, n)) : '';
}

function matchName(tree, tdmnNode) {
  return riff.cString(riff.chunkData(tree, tdmnNode));
}

// Effects applied to a layer: the "ADBE Effect Parade" group holds pairs of
// (tdmn match name, LIST sspc effect instance).
function layerEffects(tree, layerNode) {
  const found = [];
  riff.walk(layerNode, (node) => {
    if (!node.children) return true;
    const kids = node.children;
    for (let i = 0; i < kids.length - 1; i++) {
      if (kids[i].id !== 'tdmn' || !riff.isList(kids[i + 1], 'tdgp')) continue;
      if (matchName(tree, kids[i]) !== 'ADBE Effect Parade') continue;
      const parade = kids[i + 1].children || [];
      for (let j = 0; j < parade.length - 1; j++) {
        if (parade[j].id === 'tdmn' && riff.isList(parade[j + 1], 'sspc')) {
          found.push(matchName(tree, parade[j]));
        }
      }
    }
    return true;
  });
  return found;
}

function projectEffectNames(tree) {
  const names = new Map();
  const efdg = riff.firstList(tree.root, 'EfdG');
  if (!efdg) return names;
  for (const def of riff.childLists(efdg, 'EfDf')) {
    const tdmn = riff.firstChild(def, 'tdmn');
    if (!tdmn) continue;
    const mn = matchName(tree, tdmn);
    const sspc = riff.firstList(def, 'sspc');
    const fnam = sspc && riff.firstChild(sspc, 'fnam');
    names.set(mn, fnam ? nestedUtf8(riff.chunkData(tree, fnam)) : '');
  }
  return names;
}

function readXmp(trailing) {
  if (!trailing || !trailing.length) return {};
  const text = trailing.toString('utf8');
  const pick = (re) => {
    const m = re.exec(text);
    return m ? m[1].trim() : null;
  };
  return {
    creatorTool: pick(/<xmp:CreatorTool>([^<]*)<\/xmp:CreatorTool>/) || pick(/xmp:CreatorTool="([^"]*)"/),
    createDate: pick(/<xmp:CreateDate>([^<]*)<\/xmp:CreateDate>/) || pick(/xmp:CreateDate="([^"]*)"/),
    modifyDate: pick(/<xmp:ModifyDate>([^<]*)<\/xmp:ModifyDate>/) || pick(/xmp:ModifyDate="([^"]*)"/),
  };
}

// Names referenced from expressions via footage("name"). Data files (JSON,
// CSV, MGJSON) are often only used this way and have no layer.
function expressionFootageRefs(buf) {
  const names = new Set();
  const needle = Buffer.from('footage(', 'latin1');
  let at = buf.indexOf(needle);
  let guard = 0;
  while (at !== -1 && guard++ < 100000) {
    const slice = buf.toString('utf8', at + needle.length, Math.min(buf.length, at + needle.length + 512));
    const m = /^\s*(["'])((?:(?!\1)[^\\\r\n]|\\.)*)\1/.exec(slice);
    if (m) names.add(m[2].replace(/\\(.)/g, '$1'));
    at = buf.indexOf(needle, at + needle.length);
  }
  return names;
}

function basename(p) {
  const parts = String(p).split(/[\\/]/);
  return parts[parts.length - 1] || String(p);
}

/**
 * Parse an .aep buffer into a project description.
 * The returned object keeps a non-enumerable `tree` for later rewriting.
 */
function parseAep(buf) {
  const tree = riff.parseRifx(buf);
  return buildProject(tree, 'aep', buf);
}

/**
 * Builds the project description from a chunk tree. Also used for .aepx,
 * whose XML is converted into the same tree shape.
 */
function buildProject(tree, format, exprSource) {
  const warnings = [...tree.warnings];

  const folders = [];
  const comps = [];
  const footage = [];
  const seenIds = new Set();
  let unknownCount = 0;

  const fold = riff.firstList(tree.root, 'Fold');
  if (!fold) warnings.push('No project panel was found in this file.');

  const visitItems = (listNode, parentId) => {
    for (const itemNode of riff.childLists(listNode, 'Item')) {
      const idtaNode = riff.firstChild(itemNode, 'idta');
      if (!idtaNode) {
        unknownCount++;
        continue;
      }
      const idta = riff.chunkData(tree, idtaNode);
      const type = u16(idta, 0);
      const id = u32(idta, 16);
      if (seenIds.has(id)) warnings.push(`Duplicate item id ${id}; results may be incomplete.`);
      seenIds.add(id);
      const name = itemName(tree, itemNode);

      if (type === ITEM_FOLDER) {
        folders.push({ id, name, parentId });
        const sub = riff.firstList(itemNode, 'Sfdr');
        if (sub) visitItems(sub, id);
      } else if (type === ITEM_COMP) {
        const cdta = riff.firstChild(itemNode, 'cdta');
        const comp = {
          id,
          name,
          parentId,
          ...(cdta ? parseCompData(riff.chunkData(tree, cdta)) : { width: null, height: null, fps: null, duration: null }),
          layers: [],
          effects: [],
        };
        riff.childLists(itemNode, 'Layr').forEach((layerNode, index) => {
          const ldta = riff.firstChild(layerNode, 'ldta');
          const sourceId = ldta ? u32(riff.chunkData(tree, ldta), 40) : 0;
          const effects = layerEffects(tree, layerNode);
          comp.layers.push({ index: index + 1, name: itemName(tree, layerNode), sourceId, effects });
          comp.effects.push(...effects);
        });
        comps.push(comp);
      } else if (type === ITEM_FOOTAGE) {
        footage.push(parseFootage(tree, itemNode, id, name, parentId));
      } else {
        unknownCount++;
      }
    }
  };

  if (fold) visitItems(fold, 0);
  if (unknownCount) warnings.push(`${unknownCount} project item(s) could not be identified and were skipped.`);

  // Fill in display names for footage without one.
  for (const f of footage) {
    if (!f.name) {
      if (f.path) f.name = basename(f.path);
      else if (f.solidName) f.name = f.solidName;
      else f.name = f.kind === 'placeholder' ? 'Placeholder' : `Item ${f.id}`;
    }
  }

  // Effects: combine per-layer usage with the project-level definitions.
  const effectDefs = projectEffectNames(tree);
  const effectUse = new Map();
  for (const comp of comps) {
    for (const layer of comp.layers) {
      for (const mn of layer.effects) {
        let e = effectUse.get(mn);
        if (!e) effectUse.set(mn, (e = { matchName: mn, count: 0, comps: new Set() }));
        e.count++;
        e.comps.add(comp.id);
      }
    }
  }
  for (const mn of effectDefs.keys()) {
    if (!effectUse.has(mn)) effectUse.set(mn, { matchName: mn, count: 0, comps: new Set() });
  }
  const effects = [...effectUse.values()]
    .map((e) => ({
      matchName: e.matchName,
      displayName: effectDefs.get(e.matchName) || prettyEffectName(e.matchName),
      count: e.count,
      comps: [...e.comps],
      builtIn: isBuiltInEffect(e.matchName),
      pseudo: e.matchName.startsWith('Pseudo/'),
    }))
    .sort((a, b) => b.count - a.count || a.displayName.localeCompare(b.displayName));

  const xmp = readXmp(tree.trailing);
  const project = {
    format,
    creatorTool: xmp.creatorTool || null,
    createDate: xmp.createDate || null,
    modifyDate: xmp.modifyDate || null,
    folders,
    comps,
    footage,
    effects,
    expressionRefs: [...expressionFootageRefs(exprSource)],
    warnings,
  };
  Object.defineProperty(project, 'tree', { value: tree, enumerable: false });
  return project;
}

function parseFootage(tree, itemNode, id, name, parentId) {
  const pin = riff.firstList(itemNode, 'Pin ');
  const item = {
    id,
    name,
    parentId,
    kind: 'unknown',
    path: null,
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
  if (!pin) return item;

  const sspc = riff.firstChild(pin, 'sspc');
  Object.assign(item, parseSourceSpec(sspc ? riff.chunkData(tree, sspc) : null));
  const opti = riff.firstChild(pin, 'opti');
  const options = parseOptions(opti ? riff.chunkData(tree, opti) : null);

  // Every alias under the footage item; the first one is the main source.
  const aliases = [];
  riff.walk(pin, (node) => {
    if (node.id === 'alas') {
      const alas = parseAlas(riff.chunkData(tree, node));
      if (alas) aliases.push(alas);
    }
    return true;
  });

  if (aliases.length) {
    item.kind = 'file';
    item.path = aliases[0].fullpath;
    item.targetIsFolder = aliases[0].targetIsFolder;
    item.extraPaths = aliases.slice(1).map((a) => a.fullpath).filter((p) => p && p !== item.path);
  } else if (options.solid) {
    item.kind = 'solid';
    item.solidColor = options.color;
    item.solidName = options.name;
    item.duration = null;
    item.fps = null;
  } else if (options.placeholder) {
    item.kind = 'placeholder';
    item.solidName = options.name;
  }
  return item;
}

// Match-name prefixes of effects that ship with After Effects (including the
// bundled Cycore, Keylight, Mocha, Color Finesse, Cineware and VR effects).
const BUILT_IN_PREFIXES = ['ADBE', 'CC ', 'APC ', 'Pseudo/', 'Keylight', 'SYNTHAP', 'Mettle', 'CINEMA 4D', 'MOCHA', 'Mocha'];

function isBuiltInEffect(mn) {
  return BUILT_IN_PREFIXES.some((p) => mn.startsWith(p));
}

function prettyEffectName(mn) {
  return mn.replace(/^ADBE\s+/, '').replace(/^Pseudo\/.*/, 'Pseudo Effect (preset)');
}

/**
 * Rewrites footage paths in a project. `mapping` maps the stored fullpath
 * (exactly as found in the file) to the new absolute path.
 *
 * Options for private copies:
 *   fallback(fullpath)  new path for aliases that aren't in `mapping`
 *                       (excluded footage, render outputs); null keeps it
 *   scrubText(string)   applied to every Utf8 string chunk
 *   xmp                 replacement for the XMP packet after the project data
 *
 * Returns the new file bytes and the number of aliases changed.
 */
function rewriteFootagePaths(buf, mapping, { fallback = null, scrubText = null, xmp = null } = {}) {
  const tree = riff.parseRifx(buf);
  let changed = 0;
  riff.walk(tree.root, (node) => {
    if (node.id === 'Utf8' && scrubText) {
      const data = riff.chunkData(tree, node);
      const text = data.toString('utf8');
      const clean = scrubText(text);
      if (clean !== text) riff.setChunkData(node, Buffer.from(clean, 'utf8'));
      return true;
    }
    if (node.id !== 'alas') return true;
    const data = riff.chunkData(tree, node);
    const alas = parseAlas(data);
    if (!alas) return true;
    const next = mapping.has(alas.fullpath) ? mapping.get(alas.fullpath) : fallback ? fallback(alas.fullpath) : null;
    if (!next || next === alas.fullpath) return true;
    const json = alas.json ? { ...alas.json, fullpath: next } : { fullpath: next, target_is_folder: alas.targetIsFolder };
    let payload = Buffer.from(JSON.stringify(json), 'utf8');
    // Keep a trailing NUL terminator if the original had one.
    if (data.length && data[data.length - 1] === 0) payload = Buffer.concat([payload, Buffer.alloc(1)]);
    riff.setChunkData(node, payload);
    changed++;
    return true;
  });
  if (xmp !== null) {
    tree.trailing = Buffer.from(xmp, 'utf8');
    tree.root.dirty = true;
  }
  return { buffer: riff.serializeRifx(tree), changed };
}

/** Rebuilds every chunk from scratch and checks the result equals the input. */
function verifyRoundTrip(buf) {
  const tree = riff.parseRifx(buf);
  riff.walk(tree.root, (n) => {
    n.dirty = true;
    return true;
  });
  const out = riff.serializeRifx(tree);
  return out.equals(buf);
}

module.exports = {
  parseAep,
  buildProject,
  expressionFootageRefs,
  rewriteFootagePaths,
  verifyRoundTrip,
  parseAlas,
  ITEM_FOLDER,
  ITEM_COMP,
  ITEM_FOOTAGE,
};
