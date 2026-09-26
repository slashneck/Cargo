'use strict';

// Renders the Cargo icon (SVG) to PNGs and a multi-size .ico.
// Run with: npm run icons   (uses Electron's renderer, no extra tools needed)
//
// Output:
//   build/icon.svg    source artwork
//   build/icon.png    1024 px, used for macOS/Linux builds and the window icon
//   build/icon.ico    16–256 px, used for the Windows app and the setup
//   build/icon-<n>.png individual sizes

const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'build');

/** Full artwork, drawn on a 1024 grid. `small` simplifies it for 16–32 px. */
function svg({ small = false } = {}) {
  const body = small
    ? `<rect x="176" y="300" width="672" height="424" rx="56" fill="none" stroke="#fff" stroke-width="84"/>
       <path d="M392 404v216M632 404v216" stroke="#fff" stroke-width="72" stroke-linecap="round"/>`
    : `<rect x="192" y="322" width="640" height="380" rx="46" fill="none" stroke="#fff" stroke-width="46"/>
       <path d="M320 404v216M416 404v216M512 404v216M608 404v216" stroke="#fff" stroke-width="38" stroke-linecap="round"/>
       <path d="M712 322v380" stroke="#fff" stroke-width="38"/>`;
  const scan = small
    ? `<path d="M110 512h804" stroke="#00d4ff" stroke-width="76" stroke-linecap="round"/>`
    : `<path d="M112 512h800" stroke="#00d4ff" stroke-width="96" stroke-linecap="round" opacity=".28" filter="url(#glow)"/>
       <path d="M112 512h800" stroke="#00d4ff" stroke-width="40" stroke-linecap="round"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1c1c1c"/>
      <stop offset="1" stop-color="#050505"/>
    </linearGradient>
    <filter id="glow" x="-10%" y="-300%" width="120%" height="700%"><feGaussianBlur stdDeviation="22"/></filter>
  </defs>
  <rect x="${small ? 16 : 48}" y="${small ? 16 : 48}" width="${small ? 992 : 928}" height="${small ? 992 : 928}" rx="${small ? 200 : 210}" fill="url(#bg)"/>
  <rect x="${small ? 17.5 : 49.5}" y="${small ? 17.5 : 49.5}" width="${small ? 989 : 925}" height="${small ? 989 : 925}" rx="${small ? 198.5 : 208.5}" fill="none" stroke="#fff" stroke-opacity=".1" stroke-width="3"/>
  ${body}
  ${scan}
</svg>`;
}

async function render(win, markup, size) {
  const html = `<!doctype html><html><head><style>html,body{margin:0;background:transparent;overflow:hidden}svg{display:block;width:${size}px;height:${size}px}</style></head><body>${markup}</body></html>`;
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
  await new Promise((r) => setTimeout(r, 150));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  return img.getSize().width === size ? img : img.resize({ width: size, height: size, quality: 'best' });
}

function ico(pngs) {
  const count = pngs.length;
  const header = Buffer.alloc(6 + 16 * count);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  let offset = header.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + i * 16;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt8(0, e + 2);
    header.writeUInt8(0, e + 3);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...pngs.map((p) => p.data)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'icon.svg'), svg());
  const win = new BrowserWindow({ show: false, width: 1024, height: 1024, frame: false, transparent: true, webPreferences: { offscreen: true } });
  win.webContents.setFrameRate(1);

  const big = await render(win, svg(), 1024);
  fs.writeFileSync(path.join(OUT, 'icon.png'), big.toPNG());

  const smallArt = await render(win, svg({ small: true }), 256);
  const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
  const pngs = [];
  for (const size of sizes) {
    const src = size <= 32 ? smallArt : big;
    const img = src.resize({ width: size, height: size, quality: 'best' });
    const data = img.toPNG();
    pngs.push({ size, data });
    fs.writeFileSync(path.join(OUT, `icon-${size}.png`), data);
  }
  fs.writeFileSync(path.join(OUT, 'icon.ico'), ico(pngs));
  console.log(`Icons written to ${OUT}`);
  app.quit();
});
