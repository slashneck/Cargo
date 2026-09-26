'use strict';

// Manifest and report output: plain text, CSV, JSON and HTML (the HTML is
// also what gets printed to PDF).

const path = require('path');
const media = require('./media');

function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

function formatDuration(sec) {
  if (sec === null || sec === undefined) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const ss = s.toFixed(2).padStart(5, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function formatDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const STATUS_LABELS = {
  used: 'Used',
  unused: 'Unused',
  missing: 'Missing',
  'unused-missing': 'Unused, missing',
  generated: 'Solid',
  placeholder: 'Placeholder',
  unknown: 'Unknown',
};

function resolution(a) {
  return a.width && a.height ? `${a.width}x${a.height}` : '';
}

/**
 * Rows describing every file asset. `plan` (optional) adds the location
 * of each asset inside a package.
 */
function assetRows(session, plan) {
  const compNames = new Map(session.comps.map((c) => [c.id, c.name]));
  return session.assets
    .filter((a) => a.kind === 'file')
    .map((a) => ({
      name: a.name,
      type: media.CATEGORY_LABELS[a.category] || a.category,
      format: a.ext.toUpperCase(),
      status: STATUS_LABELS[a.status] || a.status,
      size: a.size,
      resolution: resolution(a),
      duration: a.duration,
      fps: a.fps,
      frames: a.isSequence ? a.frameCount : null,
      modified: a.mtime,
      path: a.resolvedPath,
      originalPath: a.relinked ? a.path : null,
      folder: a.folderPath,
      usedIn: a.usedIn.map((id) => compNames.get(id) || `#${id}`),
      packagePath: plan ? plan.assetTargets.get(a.id) || null : null,
    }));
}

/**
 * Everything a manifest or report shows. With `privateMode` it leaves out
 * anything about the machine it was made on: file locations, the project's
 * location, the After Effects version and OS, file dates and disk usage.
 */
function reportData(session, { plan = null, title = 'Asset Manifest', notes = [], privateMode = false } = {}) {
  let rows = assetRows(session, plan);
  let totals = session.totals;
  if (privateMode) {
    rows = rows.map((r) => ({ ...r, path: null, originalPath: null, modified: null }));
    const t = session.totals;
    totals = { fileAssetCount: t.fileAssetCount, usedCount: t.usedCount, unusedCount: t.unusedCount, compCount: t.compCount, missingCount: t.missingCount, unusedMissingCount: t.unusedMissingCount };
  }
  return {
    title,
    generated: Date.now(),
    private: privateMode,
    project: {
      name: session.name,
      path: privateMode ? null : session.filePath,
      size: privateMode ? null : session.fileSize,
      savedWith: privateMode ? null : session.creatorTool,
      comps: session.comps.length,
    },
    totals,
    rows,
    effects: session.effects,
    notes,
    package: plan
      ? {
          files: plan.entries.length,
          bytes: plan.totalBytes,
          layout: plan.layout,
          skipped: plan.skipped,
        }
      : null,
  };
}

function pad(s, n) {
  s = String(s ?? '');
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function toText(data) {
  const t = data.totals;
  const lines = [];
  const rule = '='.repeat(78);
  lines.push(rule, `CARGO ${data.title.toUpperCase()}`, rule, '');
  lines.push(`Project      ${data.project.name}`);
  if (data.project.path) lines.push(`Location     ${data.project.path}`);
  if (data.project.savedWith) lines.push(`Saved with   ${data.project.savedWith}`);
  lines.push(`Created      ${data.private ? formatDate(data.generated).slice(0, 10) : formatDate(data.generated)}`, '');
  lines.push('SUMMARY');
  lines.push(`  Footage items    ${t.fileAssetCount}  (${t.usedCount} used, ${t.unusedCount} unused)`);
  lines.push(`  Compositions     ${t.compCount}`);
  if (t.totalSize !== undefined) {
    lines.push(`  Total on disk    ${formatBytes(t.totalSize)}`);
    lines.push(`  Used             ${formatBytes(t.usedSize)}`);
    lines.push(`  Unused           ${formatBytes(t.unusedSize)}`);
  }
  lines.push(`  Missing files    ${t.missingCount + t.unusedMissingCount}`);
  if (data.package) {
    lines.push(`  In this package  ${data.package.files} file(s), ${formatBytes(data.package.bytes)}`);
  }
  lines.push('');

  const section = (title, rows, withPackage) => {
    if (!rows.length) return;
    lines.push(title);
    lines.push('-'.repeat(78));
    for (const r of rows) {
      lines.push(`${pad(r.name, 44)} ${pad(formatBytes(r.size), 10)} ${pad(r.type, 10)} ${r.resolution}`);
      const meta = [r.duration ? `${formatDuration(r.duration)}` : '', r.fps ? `${r.fps} fps` : '', r.frames ? `${r.frames} frames` : '', r.modified ? `modified ${formatDate(r.modified)}` : ''].filter(Boolean).join(' · ');
      if (meta) lines.push(`    ${meta}`);
      if (withPackage && r.packagePath) lines.push(`    in package:  ${r.packagePath}`);
      if (r.path) lines.push(`    source:      ${r.path}`);
      if (r.originalPath) lines.push(`    was:         ${r.originalPath}`);
      if (r.usedIn.length) lines.push(`    used in:     ${r.usedIn.slice(0, 8).join(', ')}${r.usedIn.length > 8 ? ` +${r.usedIn.length - 8} more` : ''}`);
    }
    lines.push('');
  };

  if (data.package) {
    const included = data.rows.filter((r) => r.packagePath);
    section(`INCLUDED FILES (${included.length})`, included, true);
    const missing = data.rows.filter((r) => !r.packagePath && /missing/i.test(r.status));
    section(`MISSING — NOT INCLUDED (${missing.length})`, missing, false);
    const unused = data.rows.filter((r) => !r.packagePath && r.status === 'Unused');
    section(`UNUSED — NOT INCLUDED (${unused.length})`, unused, false);
  } else {
    for (const status of ['Used', 'Missing', 'Unused', 'Unused, missing']) {
      const rows = data.rows.filter((r) => r.status === status);
      section(`${status.toUpperCase()} (${rows.length})`, rows, false);
    }
  }

  if (data.effects.length) {
    lines.push('EFFECTS');
    lines.push('-'.repeat(78));
    for (const e of data.effects) {
      lines.push(`${pad(e.displayName, 44)} ${pad(e.builtIn ? 'built-in' : 'THIRD-PARTY', 12)} ${e.count ? `${e.count}×` : 'defined'}   ${e.matchName}`);
    }
    lines.push('');
  }
  if (data.notes.length) {
    lines.push('NOTES');
    lines.push('-'.repeat(78));
    for (const n of data.notes) lines.push(`- ${n}`);
    lines.push('');
  }
  return lines.join('\r\n');
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(data) {
  const header = ['Name', 'Type', 'Format', 'Status', 'Size (bytes)', 'Size', 'Resolution', 'Duration (s)', 'FPS', 'Frames', 'Modified', 'Path', 'Original Path', 'AE Folder', 'Used In', 'Package Path'];
  const lines = [header.map(csvCell).join(',')];
  for (const r of data.rows) {
    lines.push(
      [r.name, r.type, r.format, r.status, r.size, formatBytes(r.size), r.resolution, r.duration ?? '', r.fps ?? '', r.frames ?? '', formatDate(r.modified), r.path, r.originalPath ?? '', r.folder, r.usedIn.join('; '), r.packagePath ?? '']
        .map(csvCell)
        .join(','),
    );
  }
  return '﻿' + lines.join('\r\n');
}

function toJson(data) {
  return JSON.stringify(data, null, 2);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function toHtml(data) {
  const t = data.totals;
  const statusClass = (s) => s.toLowerCase().replace(/[^a-z]+/g, '-');
  const rows = data.rows
    .map(
      (r) => `<tr>
<td><div class="n">${esc(r.name)}</div><div class="p">${esc(r.packagePath || r.path)}</div></td>
<td>${esc(r.type)}</td><td class="num">${esc(formatBytes(r.size))}</td><td>${esc(r.resolution)}</td>
<td class="num">${esc(r.duration ? formatDuration(r.duration) : '')}</td>
<td><span class="st ${statusClass(r.status)}">${esc(r.status)}</span></td></tr>`,
    )
    .join('');
  const effects = data.effects
    .map((e) => `<tr><td>${esc(e.displayName)}</td><td class="p">${esc(e.matchName)}</td><td>${e.builtIn ? 'Built-in' : '<b>Third-party</b>'}</td><td class="num">${e.count || '—'}</td></tr>`)
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(data.project.name)} — ${esc(data.title)}</title>
<style>
*{box-sizing:border-box}body{font:11px/1.45 "Segoe UI",Inter,Roboto,system-ui,sans-serif;color:#111;margin:0;padding:28px 32px}
h1{font-size:20px;margin:0 0 2px}h2{font-size:13px;margin:22px 0 8px;text-transform:uppercase;letter-spacing:.06em}
.sub{color:#666}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:16px}
.card{border:1px solid #ddd;border-radius:6px;padding:10px}.card b{display:block;font-size:16px}
table{width:100%;border-collapse:collapse}th{text-align:left;font-weight:600;border-bottom:1.5px solid #111;padding:5px 6px}
td{border-bottom:1px solid #e5e5e5;padding:5px 6px;vertical-align:top}.num{text-align:right;white-space:nowrap}
.n{font-weight:600}.p{color:#777;font-size:9.5px;word-break:break-all}
.st{padding:1px 6px;border-radius:9px;font-size:9.5px;border:1px solid #bbb;white-space:nowrap}
.st.used{border-color:#1a9f6a;color:#1a9f6a}.st.missing,.st.unused-missing{border-color:#c98a00;color:#9a6a00}.st.unused{border-color:#d33;color:#c22}
tr{page-break-inside:avoid}.foot{margin-top:24px;color:#888;font-size:9.5px}
</style></head><body>
<h1>${esc(data.project.name)}</h1>
<div class="sub">${esc(data.title)} · ${esc(formatDate(data.generated))}${data.project.savedWith ? ` · ${esc(data.project.savedWith)}` : ''}</div>
<div class="sub">${esc(data.project.path)}</div>
<div class="grid">
<div class="card"><b>${esc(formatBytes(t.totalSize))}</b>Total on disk</div>
<div class="card"><b>${esc(formatBytes(t.usedSize))}</b>Used</div>
<div class="card"><b>${esc(formatBytes(t.unusedSize))}</b>Unused</div>
<div class="card"><b>${t.fileAssetCount}</b>Footage items · ${t.compCount} comps</div>
</div>
<h2>Assets</h2>
<table><thead><tr><th>Name</th><th>Type</th><th class="num">Size</th><th>Resolution</th><th class="num">Duration</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>
${effects ? `<h2>Effects</h2><table><thead><tr><th>Effect</th><th>Match name</th><th>Source</th><th class="num">Uses</th></tr></thead><tbody>${effects}</tbody></table>` : ''}
${data.notes.length ? `<h2>Notes</h2><ul>${data.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}</body></html>`;
}

/** Summary rows for several projects (batch report). */
function batchCsv(sessions) {
  const header = ['Project', 'Path', 'Footage items', 'Used', 'Unused', 'Missing', 'Total size', 'Used size', 'Unused size', 'Comps', 'Third-party effects'];
  const lines = [header.map(csvCell).join(',')];
  for (const s of sessions) {
    const t = s.totals;
    lines.push([s.name, s.filePath, t.fileAssetCount, t.usedCount, t.unusedCount, t.missingCount + t.unusedMissingCount, formatBytes(t.totalSize), formatBytes(t.usedSize), formatBytes(t.unusedSize), t.compCount, t.thirdPartyEffects].map(csvCell).join(','));
  }
  return '﻿' + lines.join('\r\n');
}

function batchHtml(sessions) {
  const rows = sessions
    .map((s) => {
      const t = s.totals;
      return `<tr><td><div class="n">${esc(s.name)}</div><div class="p">${esc(s.filePath)}</div></td><td class="num">${t.fileAssetCount}</td><td class="num">${t.missingCount + t.unusedMissingCount}</td><td class="num">${esc(formatBytes(t.totalSize))}</td><td class="num">${esc(formatBytes(t.usedSize))}</td><td class="num">${esc(formatBytes(t.unusedSize))}</td></tr>`;
    })
    .join('');
  const sum = (k) => sessions.reduce((a, s) => a + s.totals[k], 0);
  return toHtml({
    title: 'Batch Report',
    generated: Date.now(),
    project: { name: `${sessions.length} projects`, path: path.dirname(sessions[0]?.filePath || ''), savedWith: null },
    totals: { totalSize: sum('totalSize'), usedSize: sum('usedSize'), unusedSize: sum('unusedSize'), fileAssetCount: sum('fileAssetCount'), compCount: sum('compCount') },
    rows: [],
    effects: [],
    notes: [],
  }).replace(
    /<h2>Assets<\/h2>[\s\S]*?<\/table>/,
    () => `<h2>Projects</h2><table><thead><tr><th>Project</th><th class="num">Footage</th><th class="num">Missing</th><th class="num">Total</th><th class="num">Used</th><th class="num">Unused</th></tr></thead><tbody>${rows}</tbody></table>`,
  );
}

module.exports = { reportData, toText, toCsv, toJson, toHtml, batchCsv, batchHtml, formatBytes, formatDuration, formatDate };
