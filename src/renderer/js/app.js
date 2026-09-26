// Entry point: wires state changes to views, keyboard shortcuts, drag & drop.

import { replace } from './util.js';
import { logo } from './icons.js';
import { state, subscribe, emit } from './state.js';
import { hasOpenModal, closeMenu, errorDialog, toast } from './ui.js';
import { refreshStore, chooseAndOpen, rescan, handleDropped, exportMenu } from './actions.js';
import { packageDialog, updateDialog } from './dialogs.js';
import { renderTitlebar } from './views/titlebar.js';
import { renderWelcome, renderScanning } from './views/welcome.js';
import { renderBatch } from './views/batch.js';
import { ProjectView } from './views/project.js';

const api = window.cargo;
const titlebar = document.getElementById('titlebar');
const workspace = document.getElementById('workspace');
let projectView = null;
let renderedMode = null;
let renderedProject = null;

function render(parts) {
  const all = parts.has('all');
  if (all) replace(titlebar, ...renderTitlebar());

  if (state.mode === 'scanning') {
    if (all || parts.has('scan') || renderedMode !== 'scanning') replace(workspace, renderScanning());
    renderedMode = 'scanning';
    return;
  }
  if (state.mode === 'welcome') {
    if (all || renderedMode !== 'welcome') replace(workspace, renderWelcome());
    renderedMode = 'welcome';
    return;
  }
  if (state.mode === 'batch') {
    if (all || parts.has('content') || renderedMode !== 'batch') replace(workspace, renderBatch());
    renderedMode = 'batch';
    return;
  }
  if (state.mode === 'project' && state.project) {
    if (!projectView || renderedMode !== 'project' || renderedProject !== state.project) {
      if (projectView && renderedMode !== 'project') {
        projectView.destroy();
        projectView = null;
      }
      if (!projectView) projectView = new ProjectView();
      replace(workspace, projectView.el);
      renderedMode = 'project';
      renderedProject = state.project;
      projectView.render(new Set(['all', ...parts]));
      return;
    }
    projectView.render(parts);
  }
}

subscribe(render);

// ---------------------------------------------------------------- keyboard

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (hasOpenModal()) return;
  const key = e.key.toLowerCase();
  if (mod && key === 'o') {
    e.preventDefault();
    chooseAndOpen();
  } else if (state.mode === 'project' && state.project) {
    if (mod && key === 'f') {
      e.preventDefault();
      if (state.tab !== 'assets') {
        state.tab = 'assets';
        emit('all');
      }
      projectView && projectView.focusSearch();
    } else if (mod && key === 'r') {
      e.preventDefault();
      rescan();
    } else if (mod && key === 'p') {
      e.preventDefault();
      packageDialog();
    } else if (mod && key === 'e') {
      e.preventDefault();
      const b = document.getElementById('export-btn');
      if (b) exportMenu(b);
    } else if (mod && /^[1-5]$/.test(key)) {
      e.preventDefault();
      state.tab = ['assets', 'insights', 'comps', 'effects', 'duplicates'][Number(key) - 1];
      emit('all');
    }
  }
  if (mod && (key === '=' || key === '+' || key === '-' || key === '0')) {
    // Leave browser zoom alone; the layout is designed for 100%.
    e.preventDefault();
  }
});

// ---------------------------------------------------------------- drag & drop

const overlay = document.getElementById('drop-overlay');
overlay.querySelector('.drop-icon').append(logo());
let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');

window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  overlay.hidden = false;
  closeMenu();
});
window.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) overlay.hidden = true;
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  overlay.hidden = true;
  if (hasOpenModal() || state.mode === 'scanning') return;
  const paths = [...(e.dataTransfer?.files || [])].map((f) => api.pathForFile(f)).filter(Boolean);
  if (paths.length) handleDropped(paths).catch((err) => errorDialog(err.message));
});

// ---------------------------------------------------------------- start

api.onOpenFiles((files) => {
  if (files && files.length) handleDropped(files);
});

window.addEventListener('error', (e) => console.error(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => console.error(e.reason));

(async function init() {
  try {
    state.info = await api.appInfo();
  } catch {
    // Keep defaults.
  }
  document.body.classList.add(state.info.platform === 'darwin' ? 'mac' : 'win');
  await refreshStore();
  emit('all');
  setTimeout(checkForUpdate, 4000);
})();

async function checkForUpdate() {
  try {
    const update = await api.checkUpdate({ manual: false });
    if (!update) return;
    state.update = update;
    emit('all');
    toast(`Cargo ${update.version} is available.`, { timeout: 12000, action: { label: update.canInstall ? 'Update' : 'Details', onclick: () => updateDialog(update) } });
  } catch {
    // Offline or GitHub unreachable: try again next start.
  }
}

