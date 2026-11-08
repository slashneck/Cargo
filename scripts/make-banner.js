'use strict';

// Renders the README banner and the GitHub social preview.
// Run with: npx electron scripts/make-banner.js

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'docs');

const MARK = `<svg viewBox="0 0 64 64" fill="none">
  <rect x="6.5" y="17.5" width="51" height="31" rx="4" stroke="#f4f4f4" stroke-width="3.4"/>
  <path d="M17 24v18M25 24v18M33 24v18M41 24v18" stroke="#f4f4f4" stroke-width="3" stroke-linecap="round"/>
  <path d="M49 17.5v31" stroke="#f4f4f4" stroke-width="3"/>
  <path d="M2 33h60" stroke="#00d4ff" stroke-opacity=".3" stroke-width="8" stroke-linecap="round"/>
  <path d="M2 33h60" stroke="#00d4ff" stroke-width="3" stroke-linecap="round"/>
</svg>`;

function page({ width, height, scale, chips }) {
  const s = (n) => `${Math.round(n * scale)}px`;
  return `<!doctype html><html><head><style>
  html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden}
  body{background:radial-gradient(120% 90% at 50% 120%, #1c1c1c 0%, #0b0b0b 60%, #080808 100%);
    font-family:'Segoe UI Variable Display','Segoe UI',system-ui,sans-serif;display:flex;align-items:center;justify-content:center;gap:${s(120)}}
  .mark{position:relative;width:${s(300)};height:${s(300)}}
  .mark svg{width:100%;height:100%;filter:drop-shadow(0 ${s(10)} ${s(24)} rgba(0,0,0,.6))}
  .mark::after{content:'';position:absolute;left:18%;right:18%;bottom:${s(40)};height:${s(18)};border-radius:50%;background:rgba(0,0,0,.55);filter:blur(${s(8)})}
  .text{display:flex;flex-direction:column}
  h1{margin:0;color:#f4f4f4;font-size:${s(170)};font-weight:700;letter-spacing:-0.02em;line-height:.95}
  p{margin:${s(18)} 0 0 ${s(4)};color:#9e9e9e;font-size:${s(48)};font-weight:600}
  .chips{display:flex;gap:${s(18)};margin:${s(40)} 0 0 ${s(2)}}
  .chip{border:${s(2)} solid #3a3a3a;border-radius:999px;padding:${s(10)} ${s(26)};color:#e8e8e8;font-size:${s(30)};font-weight:600}
  </style></head><body>
  <div class="mark">${MARK}</div>
  <div class="text"><h1>Cargo</h1><p>Projects, neatly packed.</p>
  <div class="chips">${chips.map((c) => `<span class="chip">${c}</span>`).join('')}</div></div>
  </body></html>`;
}

async function render(win, html, width, height, file) {
  win.setContentSize(width, height);
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
  await new Promise((r) => setTimeout(r, 400));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width, height });
  const out = img.getSize().width === width ? img : img.resize({ width, height, quality: 'best' });
  fs.writeFileSync(file, out.toPNG());
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({ show: false, width: 2560, height: 840, frame: false, useContentSize: true, webPreferences: { offscreen: true } });
  const chips = ['After Effects', 'FL Studio', 'Free and open source'];
  await render(win, page({ width: 2560, height: 840, scale: 1, chips }), 2560, 840, path.join(OUT, 'banner.png'));
  await render(win, page({ width: 1280, height: 640, scale: 0.56, chips }), 1280, 640, path.join(OUT, 'social-preview.png'));
  console.log(`Banner written to ${OUT}`);
  app.quit();
});
