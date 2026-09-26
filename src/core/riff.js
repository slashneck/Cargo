'use strict';

// RIFX reader/writer for After Effects .aep files.
//
// An .aep is a big-endian RIFF container ("RIFX", form type "Egg!") followed
// by an XMP packet. Every node in the tree keeps its original byte range, so a
// tree that has not been edited serializes back to the exact input bytes. Only
// nodes that were edited (and their ancestors) are rebuilt, which keeps
// rewriting footage paths safe even for chunk types we do not understand.

const LIST_ID = 'LIST';

// Lists whose payload is known to be raw data rather than sub-chunks.
const OPAQUE_LISTS = new Set(['btdk']);

class AepFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AepFormatError';
  }
}

function fourcc(buf, offset) {
  return buf.toString('latin1', offset, offset + 4);
}

/**
 * Parse a buffer into a chunk tree.
 * @param {Buffer} buf
 * @returns {{root: object, buffer: Buffer, trailing: Buffer, warnings: string[]}}
 */
function parseRifx(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) {
    throw new AepFormatError('The file is too small to be an After Effects project.');
  }
  const magic = fourcc(buf, 0);
  if (magic !== 'RIFX') {
    if (magic === 'RIFF') {
      throw new AepFormatError('This is a little-endian RIFF file (e.g. WAV/AVI), not an After Effects project.');
    }
    if (buf.toString('utf8', 0, 5) === '<?xml') {
      throw new AepFormatError('This looks like an XML project (.aepx). Open it through the .aepx importer.');
    }
    throw new AepFormatError('Not an After Effects project: the file header is missing.');
  }
  const formType = fourcc(buf, 8);
  if (formType !== 'Egg!') {
    throw new AepFormatError(`Unexpected RIFX form type "${formType}" (expected an After Effects project).`);
  }

  const warnings = [];
  const declared = buf.readUInt32BE(4);
  let end = 8 + declared;
  if (end > buf.length) {
    warnings.push('The project file appears to be truncated; some items may be missing.');
    end = buf.length;
  }

  const root = {
    id: 'RIFX',
    listType: formType,
    start: 0,
    dataStart: 8,
    size: declared,
    end,
    rawEnd: end,
    parent: null,
    children: [],
    slack: null,
    opaque: false,
    dirty: false,
  };
  const ok = parseChildren(buf, 12, end, root, warnings);
  if (!ok) {
    warnings.push('The project structure is damaged; only part of it could be read.');
  }

  return {
    root,
    buffer: buf,
    trailing: buf.subarray(end),
    warnings,
  };
}

// Parses children of `parent` in [from, to). Returns false if a chunk
// overran its container (the caller then treats the list as opaque).
function parseChildren(buf, from, to, parent, warnings) {
  const kids = [];
  let off = from;
  while (off + 8 <= to) {
    const id = fourcc(buf, off);
    const size = buf.readUInt32BE(off + 4);
    const dataStart = off + 8;
    const end = dataStart + size;
    if (end > to) {
      parent.children = kids;
      parent.slack = buf.subarray(off, to);
      return false;
    }
    const rawEnd = Math.min(end + (size & 1), to);
    const node = {
      id,
      listType: null,
      start: off,
      dataStart,
      size,
      end,
      rawEnd,
      parent,
      children: null,
      slack: null,
      opaque: false,
      dirty: false,
    };
    if (id === LIST_ID && size >= 4) {
      node.listType = fourcc(buf, dataStart);
      if (OPAQUE_LISTS.has(node.listType)) {
        node.opaque = true;
      } else {
        node.children = [];
        if (!parseChildren(buf, dataStart + 4, end, node, warnings)) {
          // Could not make sense of this list; keep it byte-for-byte.
          node.children = null;
          node.slack = null;
          node.opaque = true;
        }
      }
    }
    kids.push(node);
    off = rawEnd;
  }
  parent.children = kids;
  parent.slack = off < to ? buf.subarray(off, to) : null;
  return true;
}

/** Payload of a leaf chunk (edited data if the chunk was modified). */
function chunkData(tree, node) {
  if (node.newData) return node.newData;
  return tree.buffer.subarray(node.dataStart, node.end);
}

/** Replace the payload of a leaf chunk. Marks ancestors dirty. */
function setChunkData(node, data) {
  if (node.id === LIST_ID) throw new Error('Cannot set raw data on a LIST chunk');
  node.newData = Buffer.from(data);
  for (let n = node; n; n = n.parent) n.dirty = true;
}

function header(id, size) {
  const h = Buffer.alloc(8);
  h.write(id, 0, 4, 'latin1');
  h.writeUInt32BE(size >>> 0, 4);
  return h;
}

function serializeNode(tree, node, parts) {
  const buf = tree.buffer;
  if (!node.dirty) {
    parts.push(buf.subarray(node.start, node.rawEnd));
    return node.rawEnd - node.start;
  }
  if (node.children === null) {
    const data = node.newData || buf.subarray(node.dataStart, node.end);
    parts.push(header(node.id, data.length), data);
    let written = 8 + data.length;
    if (data.length & 1) {
      parts.push(Buffer.alloc(1));
      written += 1;
    }
    return written;
  }
  const headerIndex = parts.length;
  parts.push(null); // placeholder for header
  const lt = Buffer.from(node.listType, 'latin1');
  parts.push(lt);
  let size = 4;
  for (const child of node.children) size += serializeNode(tree, child, parts);
  if (node.slack) {
    parts.push(node.slack);
    size += node.slack.length;
  }
  parts[headerIndex] = header(LIST_ID, size);
  let written = 8 + size;
  if (size & 1) {
    parts.push(Buffer.alloc(1));
    written += 1;
  }
  return written;
}

/** Serialize the tree back to a complete .aep buffer. */
function serializeRifx(tree) {
  const { root } = tree;
  if (!root.dirty) return tree.buffer;
  const parts = [null, Buffer.from(root.listType, 'latin1')];
  let size = 4;
  for (const child of root.children) size += serializeNode(tree, child, parts);
  if (root.slack) {
    parts.push(root.slack);
    size += root.slack.length;
  }
  parts[0] = header('RIFX', size);
  parts.push(tree.trailing);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Small helpers for navigating the tree

function isList(node, listType) {
  return node.id === LIST_ID && (listType === undefined || node.listType === listType);
}

function childLists(node, listType) {
  return (node.children || []).filter((c) => isList(c, listType));
}

function firstChild(node, id) {
  return (node.children || []).find((c) => c.id === id) || null;
}

function firstList(node, listType) {
  return (node.children || []).find((c) => isList(c, listType)) || null;
}

/** Depth-first search; `visit` returning false stops descending into that node. */
function walk(node, visit) {
  const stack = [node];
  while (stack.length) {
    const n = stack.pop();
    if (visit(n) === false) continue;
    if (n.children) {
      for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
    }
  }
}

function cString(buf) {
  const zero = buf.indexOf(0);
  return (zero === -1 ? buf : buf.subarray(0, zero)).toString('latin1');
}

function utf8String(buf) {
  let end = buf.length;
  while (end > 0 && buf[end - 1] === 0) end--;
  return buf.toString('utf8', 0, end);
}

module.exports = {
  AepFormatError,
  parseRifx,
  serializeRifx,
  chunkData,
  setChunkData,
  isList,
  childLists,
  firstChild,
  firstList,
  walk,
  cString,
  utf8String,
};
