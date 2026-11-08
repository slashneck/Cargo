'use strict';

// Where FL Studio keeps things, and what kind of file a sample is.
//
// Sample paths in .flp files can start with placeholders:
//   %FLStudioFactoryData%  the FL Studio program folder
//   %FLStudioData%         its Data folder
//   %FLStudioUserData%     the user data folder (Documents\Image-Line\FL Studio)
// Recordings land in <user folder>\Audio\Recorded (or <project data folder>\
// Recorded), renders and consolidated clips in Audio\Rendered and
// Audio\Sliced audio.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathKey } = require('./fsutil');

let installCache = null;

/** FL Studio program folders, newest first. */
function installDirs() {
  if (installCache) return installCache;
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\\Program Files', '/Applications']
    .filter(Boolean)
    .map((r) => (r === '/Applications' ? r : path.join(r, 'Image-Line')));
  const found = [];
  for (const root of [...new Set(roots)]) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory() && /^FL Studio(?! ASIO)/i.test(e.name)) found.push(path.join(root, e.name));
    }
  }
  const num = (p) => parseInt((/(\d+)/.exec(path.basename(p)) || [0, 0])[1], 10);
  installCache = found.sort((a, b) => num(b) - num(a));
  return installCache;
}

/**
 * @param {object} [overrides]
 * @param {string} [overrides.documents] the user's Documents folder
 * @param {string} [overrides.userDir] FL Studio's user data folder, if moved
 */
function environment(overrides = {}) {
  const documents = overrides.documents || path.join(os.homedir(), 'Documents');
  const userDir = process.env.CARGO_FL_USER_DIR || overrides.userDir || path.join(documents, 'Image-Line', 'FL Studio');
  return { installDirs: installDirs(), userDir };
}

/** Turns a stored sample path into a real one. */
function expandPath(raw, env) {
  const m = /^%([^%]+)%[\\/]?(.*)$/.exec(raw || '');
  if (!m) return raw;
  const name = m[1].toLowerCase();
  const rest = m[2].split(/[\\/]+/).filter(Boolean);
  const candidates = [];
  if (name === 'flstudiofactorydata') env.installDirs.forEach((d) => candidates.push(path.join(d, ...rest)));
  else if (name === 'flstudiodata') env.installDirs.forEach((d) => candidates.push(path.join(d, 'Data', ...rest)));
  else if (name === 'flstudiouserdata') candidates.push(path.join(env.userDir, ...rest));
  else if (process.env[m[1]]) candidates.push(path.join(process.env[m[1]], ...rest));
  if (!candidates.length) return raw;
  return candidates.find((c) => fs.existsSync(c)) || candidates[0];
}

function isStock(raw, resolved, env) {
  if (/^%FLStudio(Factory)?Data%/i.test(raw || '')) return true;
  const key = pathKey(resolved || '');
  return env.installDirs.some((d) => key.startsWith(pathKey(d) + path.sep.toLowerCase()) || key.startsWith(pathKey(d) + '\\'));
}

/** recording | render | stock | sample */
function classify(raw, resolved, env, dataPath) {
  if (isStock(raw, resolved, env)) return 'stock';
  const p = String(resolved || raw || '');
  const lower = p.toLowerCase();
  if (/[\\/]recorded[\\/]/.test(lower)) return 'recording';
  if (dataPath && pathKey(p).startsWith(pathKey(path.join(dataPath, 'Recorded')))) return 'recording';
  if (/[\\/](rendered|sliced audio|consolidated)[\\/]/.test(lower) || /\((consolidated|rendered)\)|[_ -]render(ed)?\b/.test(path.basename(lower))) return 'render';
  return 'sample';
}

/** Folders where takes and renders pile up, for the leftover search. */
function leftoverFolders(env, { projectDir, dataPath }) {
  const audio = path.join(env.userDir, 'Audio');
  const list = [projectDir, path.join(audio, 'Recorded'), path.join(audio, 'Rendered'), path.join(audio, 'Sliced audio')];
  if (dataPath) list.push(dataPath);
  return list;
}

/** Folders to look in for other FL projects that might use the same files. */
function projectFolders(env, { projectDir }) {
  return [projectDir, path.dirname(projectDir), path.join(env.userDir, 'Projects')];
}

module.exports = { environment, installDirs, expandPath, classify, isStock, leftoverFolders, projectFolders };
