'use strict';

// Image sequences: AE stores only the first frame's path; the rest of the
// frames are the numbered siblings in the same folder.

const path = require('path');

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Splits "shot_0012.png" into prefix "shot_", digits "0012", ext ".png". */
function parseFrameName(name) {
  const m = /^(.*?)(\d+)(\.[^.]+)$/.exec(name);
  if (!m) return null;
  return { prefix: m[1], digits: m[2], ext: m[3], number: parseInt(m[2], 10) };
}

/**
 * Finds the frames belonging to the sequence that starts at `framePath`.
 * @param {string} framePath path of the frame AE references
 * @param {string[]} dirNames file names in the frame's folder
 * @returns {{frames: string[], first: number, last: number, gaps: number, pattern: string} | null}
 */
function matchSequence(framePath, dirNames) {
  const dir = path.dirname(framePath);
  const parsed = parseFrameName(path.basename(framePath));
  if (!parsed) return null;
  const padded = parsed.digits.length > 1 && parsed.digits.startsWith('0');
  const digitRe = padded ? `(\\d{${parsed.digits.length}})` : '(\\d+)';
  const re = new RegExp(`^${escapeRe(parsed.prefix)}${digitRe}${escapeRe(parsed.ext)}$`, CASE_INSENSITIVE ? 'i' : '');
  const found = [];
  for (const name of dirNames) {
    const m = re.exec(name);
    if (m) found.push({ name, number: parseInt(m[1], 10) });
  }
  if (found.length < 2) return null;
  found.sort((a, b) => a.number - b.number);
  const first = found[0].number;
  const last = found[found.length - 1].number;
  const gaps = last - first + 1 - found.length;
  const hash = padded ? '#'.repeat(parsed.digits.length) : '#';
  const num = (n) => (padded ? String(n).padStart(parsed.digits.length, '0') : String(n));
  return {
    frames: found.map((f) => path.join(dir, f.name)),
    first,
    last,
    gaps,
    pattern: `${parsed.prefix}[${hash}]${parsed.ext}`,
    // How After Effects names a sequence in the project panel.
    displayName: `${parsed.prefix}[${num(first)}-${num(last)}]${parsed.ext}`,
  };
}

module.exports = { parseFrameName, matchSequence };
