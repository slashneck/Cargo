'use strict';

// Updates from GitHub releases. Cargo asks GitHub for the latest release;
// if it is newer, the setup for that version is downloaded, checked against
// its SHA-256 and started in update mode. The setup closes Cargo, replaces
// the program files and starts Cargo again. This is the only network access
// Cargo makes, and it can be switched off in Help.

const { app, net } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const REPO = 'slashneck/Cargo';
const REPO_URL = `https://github.com/${REPO}`;
const MANIFEST = 'cargo-files.txt';

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function isNewer(candidate, current) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

function installDir() {
  return path.dirname(process.execPath);
}

/** Only copies installed by the setup update themselves; portable and dev copies just get a link. */
function canInstall() {
  return process.platform === 'win32' && app.isPackaged && fs.existsSync(path.join(installDir(), MANIFEST));
}

function headers() {
  return { 'User-Agent': `Cargo/${app.getVersion()}`, Accept: 'application/vnd.github+json' };
}

/**
 * @returns {Promise<null | {version, notes, pageUrl, downloadUrl, size, sha256, canInstall}>}
 */
async function check(current = app.getVersion()) {
  const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: headers() });
  if (res.status === 404) return null; // nothing released yet
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const release = await res.json();
  const version = String(release.tag_name || '').replace(/^v/i, '');
  if (!isNewer(version, current)) return null;

  const setupName = `CargoSetup-${version}.exe`;
  const assets = release.assets || [];
  const setup = assets.find((a) => a.name.toLowerCase() === setupName.toLowerCase());
  let sha256 = setup && typeof setup.digest === 'string' && setup.digest.startsWith('sha256:') ? setup.digest.slice(7) : null;
  if (setup && !sha256) {
    const sum = assets.find((a) => a.name.toLowerCase() === `${setupName}.sha256`.toLowerCase());
    if (sum) {
      const text = await (await net.fetch(sum.browser_download_url, { headers: headers() })).text();
      sha256 = text.split(/\s+/).find(Boolean) || null;
    }
  }
  return {
    version,
    notes: String(release.body || '').slice(0, 6000),
    pageUrl: release.html_url || `${REPO_URL}/releases/latest`,
    downloadUrl: setup ? setup.browser_download_url : null,
    size: setup ? setup.size : 0,
    sha256,
    canInstall: canInstall() && !!setup && !!sha256,
  };
}

/** Downloads the setup to a temp folder and verifies it. Returns its path. */
async function download(update, { onProgress = () => {}, signal } = {}) {
  if (!update.downloadUrl || !/^[0-9a-f]{64}$/i.test(update.sha256 || '')) {
    throw new Error('This release has no checksum, so it can’t be verified. Download it from GitHub instead.');
  }
  const dir = path.join(app.getPath('temp'), 'cargo-update');
  await fsp.mkdir(dir, { recursive: true });
  const target = path.join(dir, `CargoSetup-${update.version}.exe`);
  const res = await net.fetch(update.downloadUrl, { headers: headers(), signal });
  if (!res.ok || !res.body) throw new Error(`The download failed (${res.status}).`);
  const total = Number(res.headers.get('content-length')) || update.size || 0;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(target);
  let done = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      const chunk = Buffer.from(value);
      hash.update(chunk);
      done += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      onProgress({ phase: `Downloading Cargo ${update.version}`, bytes: done, totalBytes: total });
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    await fsp.rm(target, { force: true }).catch(() => {});
    if (signal && signal.aborted) {
      const e = new Error('Cancelled');
      e.cancelled = true;
      throw e;
    }
    throw err;
  }
  if (hash.digest('hex').toLowerCase() !== update.sha256.toLowerCase()) {
    await fsp.rm(target, { force: true }).catch(() => {});
    throw new Error('The download was damaged, so nothing was changed. Try again later.');
  }
  return target;
}

/** Starts the downloaded setup in update mode and quits Cargo so its files can be replaced. */
function install(setupPath) {
  const child = spawn(setupPath, ['/update', `/dir=${installDir()}`], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  setTimeout(() => app.quit(), 300);
}

/** Removes downloaded setups from earlier updates. */
async function cleanUp() {
  await fsp.rm(path.join(app.getPath('temp'), 'cargo-update'), { recursive: true, force: true }).catch(() => {});
}

module.exports = { check, download, install, cleanUp, isNewer, REPO_URL };
