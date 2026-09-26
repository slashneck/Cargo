'use strict';

// .aepx is the XML flavour of an After Effects project. Each chunk becomes an
// element named after its id: leaf chunks carry their bytes as hex in `bdata`,
// LIST chunks become elements containing their children, Utf8 chunks become
// <string>, and footage aliases become <fileReference fullpath="...">.
// We convert that XML back into the chunk-tree shape the .aep parser uses.

const { buildProject } = require('./aep');

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s) {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function encodeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function parseAttrs(src) {
  const attrs = {};
  const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(src))) attrs[m[1]] = decodeEntities(m[3] ?? m[4] ?? '');
  return attrs;
}

/** Minimal XML reader producing {tag, attrs, children, text} elements. */
function parseXml(text) {
  const root = { tag: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/\s*([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(text))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) {
      top.text += m[1];
    } else if (m[2] !== undefined) {
      if (stack.length > 1) stack.pop();
    } else if (m[3] !== undefined) {
      const el = { tag: m[3], attrs: parseAttrs(m[4] || ''), children: [], text: '' };
      top.children.push(el);
      if (!m[5]) stack.push(el);
    } else if (m[6] !== undefined) {
      top.text += decodeEntities(m[6]);
    }
  }
  return root;
}

function hexToBuffer(hex) {
  const clean = hex.replace(/[^0-9a-f]/gi, '');
  return Buffer.from(clean.length % 2 ? clean.slice(0, -1) : clean, 'hex');
}

function fourcc(tag) {
  return (tag + '    ').slice(0, 4);
}

function toNode(el, parent) {
  const node = { id: null, listType: null, children: null, newData: null, parent, dirty: false };
  if (el.tag === 'string') {
    node.id = 'Utf8';
    node.newData = Buffer.from(el.text, 'utf8');
  } else if (el.tag === 'fileReference') {
    node.id = 'alas';
    const json = {
      fullpath: el.attrs.fullpath || '',
      target_is_folder: el.attrs.target_is_folder === '1' || el.attrs.target_is_folder === 'true',
    };
    node.newData = Buffer.from(JSON.stringify(json), 'utf8');
  } else if (el.attrs.bdata !== undefined && el.children.length === 0) {
    node.id = fourcc(el.tag);
    node.newData = hexToBuffer(el.attrs.bdata);
  } else {
    node.id = 'LIST';
    node.listType = fourcc(el.tag);
    node.children = el.children.map((c) => toNode(c, node));
  }
  return node;
}

function parseAepx(buf) {
  const text = buf.toString('utf8');
  const doc = parseXml(text);
  const project = doc.children.find((c) => /AfterEffectsProject/i.test(c.tag));
  if (!project) throw new Error('This XML file is not an After Effects project (.aepx).');
  const rootNode = { id: 'RIFX', listType: 'Egg!', children: null, newData: null, parent: null, dirty: false };
  rootNode.children = project.children.map((c) => toNode(c, rootNode));
  const tree = { root: rootNode, buffer: Buffer.alloc(0), trailing: Buffer.from(text), warnings: [] };
  const exprText = Buffer.from(decodeEntities(text), 'utf8');
  return buildProject(tree, 'aepx', exprText);
}

/**
 * Rewrites fileReference paths in .aepx text. Returns {buffer, changed}.
 * `fallback` and `scrubText` work like in rewriteFootagePaths; for XML the
 * scrub runs over the whole document.
 */
function rewriteAepxPaths(buf, mapping, { fallback = null, scrubText = null } = {}) {
  let changed = 0;
  let text = buf.toString('utf8').replace(/(<fileReference\b[^>]*?\sfullpath\s*=\s*)"([^"]*)"/g, (m, head, raw) => {
    const current = decodeEntities(raw);
    const next = mapping.has(current) ? mapping.get(current) : fallback ? fallback(current) : null;
    if (!next || next === current) return m;
    changed++;
    return `${head}"${encodeAttr(next)}"`;
  });
  if (scrubText) {
    // Keep the rewritten references intact; scrub everything else.
    const keep = [];
    text = text.replace(/<fileReference\b[^>]*>/g, (m) => {
      keep.push(m);
      return `<cargo-keep-${keep.length - 1}>`;
    });
    text = scrubText(text).replace(/<cargo-keep-(\d+)>/g, (_m, i) => keep[Number(i)]);
  }
  return { buffer: Buffer.from(text, 'utf8'), changed };
}

module.exports = { parseAepx, rewriteAepxPaths, parseXml };
