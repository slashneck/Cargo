'use strict';

// The only bridge between the page and the system. Every call goes through
// a named IPC channel handled in ipc.js.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

async function call(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (res && res.ok) return res.value;
  const err = new Error((res && res.error) || 'Something went wrong.');
  err.cancelled = !!(res && res.cancelled);
  throw err;
}

contextBridge.exposeInMainWorld('cargo', {
  // dialogs
  openProjects: (opts) => call('dialog:openProjects', opts),
  openFolder: (opts) => call('dialog:openFolder', opts),
  locateFile: (opts) => call('dialog:locateFile', opts),

  // projects
  scan: (filePath, jobId) => call('project:scan', filePath, jobId),
  rescan: (id, jobId) => call('project:rescan', id, jobId),
  close: (id) => call('project:close', id),
  thumbnail: (id, assetId) => call('project:thumbnail', id, assetId),
  findMissing: (id, opts, jobId) => call('project:findMissing', id, opts, jobId),
  relink: (id, links, jobId) => call('project:relink', id, links, jobId),
  saveRelinked: (id) => call('project:saveRelinked', id),
  packagePreview: (id, opts) => call('project:packagePreview', id, opts),
  packageProject: (id, opts, jobId) => call('project:package', id, opts, jobId),
  archive: (id, opts, jobId) => call('project:archive', id, opts, jobId),
  organize: (id, opts, jobId) => call('project:organize', id, opts, jobId),
  deletePlan: (id) => call('project:deletePlan', id),
  trash: (id, files, jobId) => call('project:trash', id, files, jobId),
  deleteAssetsPlan: (id, assetIds) => call('project:deleteAssetsPlan', id, assetIds),
  trashAssets: (id, files, opts, jobId) => call('project:trashAssets', id, files, opts, jobId),
  duplicates: (id, jobId) => call('project:duplicates', id, jobId),
  exportReport: (id, format) => call('project:export', id, format),

  // batch
  findProjects: (dir, opts, jobId) => call('batch:findProjects', dir, opts, jobId),
  batchScan: (paths, jobId) => call('batch:scan', paths, jobId),
  batchPackage: (ids, opts, jobId) => call('batch:package', ids, opts, jobId),
  batchExport: (ids, format) => call('batch:export', ids, format),

  // local state
  getState: () => call('store:get'),
  setTags: (keys, tags) => call('store:setTags', keys, tags),
  setFavorite: (keys, on) => call('store:setFavorite', keys, on),
  removeRecent: (p) => call('store:removeRecent', p),
  clearRecent: () => call('store:clearRecent'),
  clearHistory: () => call('store:clearHistory'),
  setSetting: (key, value) => call('store:setSetting', key, value),

  // shell
  showInFolder: (p) => call('shell:showInFolder', p),
  openPath: (p) => call('shell:openPath', p),
  openProject: (id) => call('shell:openProject', id),
  openExternal: (url) => call('shell:openExternal', url),

  // updates
  checkUpdate: (opts) => call('update:check', opts),
  downloadUpdate: (jobId) => call('update:download', jobId),
  installUpdate: () => call('update:install'),

  // jobs & app
  cancelJob: (jobId) => call('job:cancel', jobId),
  appInfo: () => call('app:info'),
  onProgress: (fn) => {
    const listener = (_e, p) => fn(p);
    ipcRenderer.on('job:progress', listener);
    return () => ipcRenderer.removeListener('job:progress', listener);
  },
  onOpenFiles: (fn) => ipcRenderer.on('app:open-files', (_e, files) => fn(files)),
  pathForFile: (file) => webUtils.getPathForFile(file),
});
