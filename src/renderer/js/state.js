// Application state and the derived views of the current project.

export const state = {
  info: { platform: 'win32', version: '' },
  store: { recent: [], packages: [], tags: {}, favorites: {}, settings: {} },
  mode: 'welcome', // welcome | scanning | project | batch
  project: null,
  projects: new Map(), // id -> project (batch + current)
  batch: [], // [{path, ok, id, error}]
  fromBatch: false,
  tab: 'assets',
  filter: { library: 'all', status: null, folderId: null, compId: null, search: '' },
  sort: { key: 'name', dir: 1 },
  selection: new Set(),
  focusId: null,
  anchorId: null,
  previewOpen: true,
  expanded: new Set(), // tree nodes open in the sidebar
  compExpanded: new Set(),
  compFocus: null,
  duplicates: null,
  scanProgress: null,
  update: null, // newer release found on GitHub
};

const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Notify views. `parts` names the regions that need to redraw. */
export function emit(...parts) {
  for (const fn of listeners) fn(new Set(parts.length ? parts : ['all']));
}

// ---------------------------------------------------------------- derived data

let cache = { key: null, value: null };

export function tagsFor(asset) {
  return (asset.key && state.store.tags[asset.key]) || [];
}

export function isFavorite(asset) {
  return !!(asset.key && state.store.favorites[asset.key]);
}

export function assetById(id) {
  return state.project ? state.project.assets.find((a) => a.id === id) : null;
}

export function compById(id) {
  return state.project ? state.project.comps.find((c) => c.id === id) : null;
}

/** Ids of folders inside `folderId` (including itself). */
export function folderDescendants(folderId) {
  const out = new Set([folderId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of state.project.folders) {
      if (out.has(f.parentId) && !out.has(f.id)) {
        out.add(f.id);
        grew = true;
      }
    }
  }
  return out;
}

/** Every footage id a comp depends on, through nested comps. */
export function compDependencies(compId) {
  const comps = new Map(state.project.comps.map((c) => [c.id, c]));
  const footage = new Set();
  const seen = new Set();
  const stack = [compId];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const c = comps.get(id);
    if (!c) continue;
    for (const s of c.sources) {
      if (comps.has(s.id)) stack.push(s.id);
      else footage.add(s.id);
    }
  }
  return { footage, comps: seen };
}

const STATUS_ORDER = { missing: 0, used: 1, placeholder: 2, unused: 3, 'unused-missing': 4, generated: 5, unknown: 6 };

function matchesSearch(a, q) {
  if (!q) return true;
  const hay = `${a.name}\n${a.resolvedPath || ''}\n${a.folderPath}\n${a.ext}\n${tagsFor(a).join(' ')}`.toLowerCase();
  return q.split(/\s+/).every((t) => hay.includes(t));
}

export function visibleAssets() {
  const p = state.project;
  if (!p) return [];
  const f = state.filter;
  const key = JSON.stringify([p.id, p.scannedAt, f, state.sort, state.store.settings.showGenerated, Object.keys(state.store.tags).length, Object.keys(state.store.favorites).length, state.storeVersion || 0]);
  if (cache.key === key) return cache.value;

  let list = p.assets;
  const showGenerated = state.store.settings.showGenerated;
  if (f.library === 'all') list = list.filter((a) => showGenerated || a.kind !== 'solid');
  else list = list.filter((a) => a.category === f.library);

  if (f.status === 'used') list = list.filter((a) => a.status === 'used' || a.status === 'missing');
  else if (f.status === 'unused') list = list.filter((a) => a.status === 'unused' || a.status === 'unused-missing');
  else if (f.status === 'missing') list = list.filter((a) => a.status === 'missing' || a.status === 'unused-missing' || a.status === 'placeholder');
  else if (f.status === 'favorites') list = list.filter(isFavorite);
  else if (f.status === 'tagged') list = list.filter((a) => tagsFor(a).length > 0);
  else if (f.status && f.status.startsWith('tag:')) {
    const t = f.status.slice(4);
    list = list.filter((a) => tagsFor(a).includes(t));
  }

  if (f.folderId) {
    const ids = folderDescendants(f.folderId);
    list = list.filter((a) => ids.has(a.parentId));
  }
  if (f.compId) {
    const { footage } = compDependencies(f.compId);
    list = list.filter((a) => footage.has(a.id));
  }
  const q = f.search.trim().toLowerCase();
  if (q) list = list.filter((a) => matchesSearch(a, q));

  const { key: sk, dir } = state.sort;
  const val = {
    name: (a) => a.name.toLowerCase(),
    type: (a) => `${a.category}:${a.ext}`,
    size: (a) => a.size,
    resolution: (a) => (a.width || 0) * (a.height || 0),
    duration: (a) => a.duration || 0,
    modified: (a) => a.mtime || 0,
    status: (a) => STATUS_ORDER[a.status] ?? 9,
    usedIn: (a) => a.usedIn.length,
  }[sk] || ((a) => a.name.toLowerCase());
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  list = [...list].sort((a, b) => {
    const x = val(a);
    const y = val(b);
    const c = typeof x === 'string' ? collator.compare(x, y) : x - y;
    return c * dir || collator.compare(a.name, b.name);
  });
  cache = { key, value: list };
  return list;
}

export function invalidate() {
  cache.key = null;
}

export function selectedAssets() {
  if (!state.project) return [];
  return state.project.assets.filter((a) => state.selection.has(a.id));
}

export function resetProjectView() {
  state.filter = { library: 'all', status: null, folderId: null, compId: null, search: '' };
  state.selection = new Set();
  state.focusId = null;
  state.anchorId = null;
  state.duplicates = null;
  state.compFocus = null;
  state.compExpanded = new Set();
  invalidate();
}
