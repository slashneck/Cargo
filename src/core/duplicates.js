'use strict';

// Duplicate detection.
//   identical: same size and same content fingerprint (hash of the size and
//              three 1 MB samples from the start, middle and end; files up to
//              3 MB are hashed whole)
//   similar:   same base name in different places, or the same resolution
//              and duration with a different file size (re-exports,
//              transcodes, proxies)

const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const path = require('path');
const { pathKey, pool } = require('./fsutil');

const SAMPLE = 1024 * 1024;

async function fingerprint(file, size) {
  const hash = crypto.createHash('sha1');
  hash.update(String(size));
  const fh = await fsp.open(file, 'r');
  try {
    if (size <= SAMPLE * 3) {
      const buf = Buffer.alloc(size);
      await fh.read(buf, 0, size, 0);
      hash.update(buf);
    } else {
      const buf = Buffer.alloc(SAMPLE);
      for (const pos of [0, Math.floor(size / 2 - SAMPLE / 2), size - SAMPLE]) {
        const { bytesRead } = await fh.read(buf, 0, SAMPLE, pos);
        hash.update(buf.subarray(0, bytesRead));
      }
    }
  } finally {
    await fh.close();
  }
  return hash.digest('hex');
}

function stemOf(name) {
  return name
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/\s*\(\d+\)$/, '')
    .replace(/[\s_.-]*(copy|kopie|final|proxy|v\d+|version\s*\d+)$/g, '')
    .replace(/[\s_.-]+$/, '');
}

/** Suggests which file of a group to keep. */
function pickKeeper(members, projectDir) {
  const inProject = (m) => pathKey(m.path).startsWith(pathKey(projectDir));
  return [...members].sort(
    (a, b) =>
      Number(b.used) - Number(a.used) ||
      Number(inProject(b)) - Number(inProject(a)) ||
      b.size - a.size ||
      a.path.length - b.path.length,
  )[0];
}

/**
 * @returns {Promise<{identical: object[], similar: object[]}>}
 */
async function findDuplicates(session, { onProgress = () => {}, signal } = {}) {
  // One entry per distinct single file (sequences and folders are skipped).
  const files = new Map();
  for (const a of session.assets) {
    if (a.kind !== 'file' || !a.exists || a.isSequence || a.isFolder || !a.size) continue;
    const key = pathKey(a.resolvedPath);
    const existing = files.get(key);
    if (existing) {
      existing.assetIds.push(a.id);
      existing.used = existing.used || a.used;
    } else {
      files.set(key, { key, path: a.resolvedPath, name: path.basename(a.resolvedPath), size: a.size, used: a.used, assetIds: [a.id], width: a.width, height: a.height, duration: a.duration, category: a.category });
    }
  }
  const list = [...files.values()];

  // Identical content.
  const bySize = new Map();
  for (const f of list) {
    if (!bySize.has(f.size)) bySize.set(f.size, []);
    bySize.get(f.size).push(f);
  }
  const toHash = [...bySize.values()].filter((g) => g.length > 1).flat();
  let hashed = 0;
  await pool(toHash, 4, async (f) => {
    if (signal && signal.aborted) return;
    try {
      f.hash = await fingerprint(f.path, f.size);
    } catch {
      f.hash = null;
    }
    hashed++;
    onProgress({ phase: 'Comparing files', done: hashed, total: toHash.length, current: f.name });
  });
  const byHash = new Map();
  for (const f of toHash) {
    if (!f.hash) continue;
    if (!byHash.has(f.hash)) byHash.set(f.hash, []);
    byHash.get(f.hash).push(f);
  }
  const identical = [];
  const inIdentical = new Set();
  for (const members of byHash.values()) {
    if (members.length < 2) continue;
    const keep = pickKeeper(members, session.dir);
    members.forEach((m) => inIdentical.add(m.key));
    identical.push({
      kind: 'identical',
      reason: 'Same content',
      size: members[0].size,
      wasted: members[0].size * (members.length - 1),
      keep: keep.key,
      members,
    });
  }

  // Similar files.
  const similar = [];
  const seenGroups = new Set();
  const addGroup = (members, reason) => {
    const distinct = members.filter((m, i, arr) => arr.findIndex((x) => x.key === m.key) === i);
    if (distinct.length < 2) return;
    if (distinct.every((m) => inIdentical.has(m.key))) return;
    const id = distinct.map((m) => m.key).sort().join('|');
    if (seenGroups.has(id)) return;
    seenGroups.add(id);
    const keep = pickKeeper(distinct, session.dir);
    similar.push({
      kind: 'similar',
      reason,
      size: distinct.reduce((s, m) => s + m.size, 0),
      wasted: distinct.reduce((s, m) => s + m.size, 0) - keep.size,
      keep: keep.key,
      members: distinct,
    });
  };
  const byStem = new Map();
  for (const f of list) {
    const stem = stemOf(f.name);
    if (stem.length < 3) continue;
    const k = `${f.category}:${stem}`;
    if (!byStem.has(k)) byStem.set(k, []);
    byStem.get(k).push(f);
  }
  for (const members of byStem.values()) if (members.length > 1) addGroup(members, 'Similar name');

  const bySpec = new Map();
  for (const f of list) {
    if (!f.width || !f.height || !f.duration || f.category !== 'video') continue;
    const k = `${f.width}x${f.height}@${f.duration.toFixed(2)}`;
    if (!bySpec.has(k)) bySpec.set(k, []);
    bySpec.get(k).push(f);
  }
  for (const members of bySpec.values()) if (members.length > 1) addGroup(members, 'Same resolution and duration');

  const strip = (g) => ({ ...g, members: g.members.map(({ hash, ...m }) => m) });
  identical.sort((a, b) => b.wasted - a.wasted);
  similar.sort((a, b) => b.wasted - a.wasted);
  return { identical: identical.map(strip), similar: similar.map(strip) };
}

module.exports = { findDuplicates, fingerprint, stemOf };
