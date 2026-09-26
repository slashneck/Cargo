'use strict';

// Local persistence: recent projects, package history, tags, favorites,
// relinks and settings, kept in one JSON file in the app's user-data folder.

const fs = require('fs');
const path = require('path');
const { writeFileAtomic, pathKey } = require('../core/fsutil');

const MAX_RECENT = 25;
const MAX_HISTORY = 100;

const DEFAULTS = () => ({
  version: 1,
  recent: [],
  packages: [],
  tags: {},
  favorites: {},
  relinks: {},
  settings: {
    searchRoots: [],
    packageLayout: 'type',
    packageIncludeUnused: false,
    packageRelink: true,
    packageFormat: 'zip',
    showGenerated: false,
    skipAutoSave: true,
    packagePrivate: true,
    autoUpdate: true,
  },
});

class Store {
  constructor(dir) {
    this.file = path.join(dir, 'cargo-state.json');
    this.data = DEFAULTS();
    this.timer = null;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const d = DEFAULTS();
      this.data = { ...d, ...raw, settings: { ...d.settings, ...(raw.settings || {}) } };
    } catch {
      // First run, or unreadable state: start fresh.
    }
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 250);
  }

  async flush() {
    clearTimeout(this.timer);
    this.timer = null;
    try {
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
      await writeFileAtomic(this.file, JSON.stringify(this.data, null, 1));
    } catch (err) {
      console.error('Could not save state:', err);
    }
  }

  snapshot() {
    const { recent, packages, tags, favorites, settings } = this.data;
    return { recent, packages, tags, favorites, settings };
  }

  addRecent(session) {
    const key = pathKey(session.filePath);
    const t = session.totals;
    this.data.recent = [
      {
        path: session.filePath,
        name: session.name,
        lastScan: Date.now(),
        totals: { assetCount: t.fileAssetCount, totalSize: t.totalSize, usedSize: t.usedSize, unusedSize: t.unusedSize, missingCount: t.missingCount + t.unusedMissingCount, compCount: t.compCount },
      },
      ...this.data.recent.filter((r) => pathKey(r.path) !== key),
    ].slice(0, MAX_RECENT);
    this.save();
  }

  removeRecent(p) {
    const key = pathKey(p);
    this.data.recent = this.data.recent.filter((r) => pathKey(r.path) !== key);
    this.save();
  }

  clearRecent() {
    this.data.recent = [];
    this.save();
  }

  addHistory(entry) {
    this.data.packages = [{ date: Date.now(), ...entry }, ...this.data.packages].slice(0, MAX_HISTORY);
    this.save();
  }

  setTags(keys, tags) {
    for (const k of keys) {
      if (tags.length) this.data.tags[k] = [...new Set(tags)];
      else delete this.data.tags[k];
    }
    this.save();
  }

  setFavorite(keys, on) {
    for (const k of keys) {
      if (on) this.data.favorites[k] = true;
      else delete this.data.favorites[k];
    }
    this.save();
  }

  relinksFor(projectPath) {
    return this.data.relinks[pathKey(projectPath)] || {};
  }

  setRelinks(projectPath, map) {
    const key = pathKey(projectPath);
    const merged = { ...(this.data.relinks[key] || {}), ...map };
    for (const [k, v] of Object.entries(merged)) if (!v) delete merged[k];
    if (Object.keys(merged).length) this.data.relinks[key] = merged;
    else delete this.data.relinks[key];
    this.save();
  }

  setSetting(key, value) {
    this.data.settings[key] = value;
    this.save();
  }

  /** Paths the user asked to keep (favorites and "keep" tags). */
  protectedKeys() {
    const keys = new Map();
    for (const k of Object.keys(this.data.favorites)) keys.set(k, 'Marked as favorite');
    for (const [k, tags] of Object.entries(this.data.tags)) {
      if (tags.includes('keep')) keys.set(k, 'Tagged "keep"');
    }
    return keys;
  }
}

module.exports = { Store };
