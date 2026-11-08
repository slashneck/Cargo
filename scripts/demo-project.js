'use strict';

// Creates a demo project with real media files so Cargo can be tried (and
// tested) without an existing project.
//
//   node scripts/demo-project.js [target-folder]        After Effects
//   node scripts/demo-project.js [target-folder] --fl   FL Studio
//
// The After Effects project uses footage, audio, a PNG sequence, precomps, a
// third-party effect, an expression-driven JSON file, one missing file,
// unused files and a duplicate copy. The FL Studio one comes with its own
// user folder: vocal takes in Audio\Recorded (some deleted from the project,
// one used by another song), renders, a VST and a missing sample. Point
// Cargo at that folder with the CARGO_FL_USER_DIR environment variable.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const B = require('../test/helpers/buildAep');

const target = path.resolve(process.argv.slice(2).find((a) => !a.startsWith('--')) || path.join(process.cwd(), 'Cargo Demo'));

function crc32(buf) {
  return zlib.crc32(buf);
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

/** A small PNG with a two-color gradient and a soft circle. */
function png(width, height, [r1, g1, b1], [r2, g2, b2], seed = 0) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  const cx = width * (0.3 + 0.4 * ((seed * 37) % 10) / 10);
  const cy = height * 0.5;
  const rad = Math.min(width, height) * 0.28;
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const t = (x / width) * 0.7 + (y / height) * 0.3;
      let r = r1 + (r2 - r1) * t;
      let g = g1 + (g2 - g1) * t;
      let b = b1 + (b2 - b1) * t;
      const d = Math.hypot(x - cx, y - cy) / rad;
      if (d < 1) {
        const k = (1 - d) * 0.55;
        r += (255 - r) * k;
        g += (255 - g) * k;
        b += (255 - b) * k;
      }
      const i = row + 1 + x * 3;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

/** A mono 16-bit WAV with a gentle chord. */
function wav(seconds, freqs) {
  const rate = 22050;
  const n = Math.floor(seconds * rate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const env = Math.min(1, t * 4) * Math.min(1, (seconds - t) * 2);
    const v = freqs.reduce((s, f) => s + Math.sin(2 * Math.PI * f * t), 0) / freqs.length;
    data.writeInt16LE(Math.round(v * env * 12000), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** Stand-in for camera footage Cargo can size but not play. */
function blob(mb, fill) {
  return Buffer.alloc(Math.round(mb * 1024 * 1024), fill);
}

function put(rel, data) {
  const p = path.join(target, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  return p;
}

function flDemo() {
  const F = require('../test/helpers/buildFlp');
  const user = 'FL Studio';
  const rec = (name, secs, freqs) => put(`${user}/Audio/Recorded/${name}`, wav(secs, freqs));
  const takes = {
    v1: rec('Night Drive_Vox Lead_01.wav', 6, [220]),
    v2: rec('Night Drive_Vox Lead_02.wav', 7, [233]),
    v3: rec('Night Drive_Vox Lead_03.wav', 6, [247]),
    v4: rec('Night Drive_Vox Lead_04.wav', 8, [262]),
    adlib1: rec('Night Drive_Adlibs_01.wav', 4, [330]),
    adlib2: rec('Night Drive_Adlibs_02.wav', 3, [349]),
    harmony: rec('Night Drive_Harmony_01.wav', 6, [294, 370]),
    other: rec('Summer Tape_Vox_01.wav', 5, [196]),
  };
  const ren = (name, secs, freqs) => put(`${user}/Audio/Rendered/${name}`, wav(secs, freqs));
  const renders = {
    melody: ren('Melody (consolidated).wav', 8, [440, 554]),
    oldBounce: ren('Melody old bounce.wav', 8, [440]),
    drums: ren('Drums print v1.wav', 8, [60]),
  };
  const songDir = `${user}/Projects/Night Drive`;
  const kick = put(`${songDir}/Samples/Kick Punchy.wav`, wav(1, [55]));
  const snare = put(`${songDir}/Samples/Snare Crack.wav`, wav(1, [180]));
  const hat = put(`${songDir}/Samples/Hat Closed.wav`, wav(0.5, [3000]));
  const shaker = put(`${songDir}/Samples/Perc Shaker.wav`, wav(1, [2500]));
  const song = F.project({
    title: 'Night Drive',
    licensee: 'Demo User',
    channels: [
      { iid: 0, name: 'Kick', sample: kick },
      { iid: 1, name: 'Snare', sample: snare },
      { iid: 2, name: 'Hats', sample: hat },
      { iid: 3, name: 'Shaker', sample: shaker },
      { iid: 4, name: 'Vox Lead', sample: takes.v3 },
      { iid: 5, name: 'Vox Lead (alt)', sample: takes.v4 },
      { iid: 6, name: 'Adlibs', sample: takes.adlib2 },
      { iid: 7, name: 'Harmony', sample: takes.harmony },
      { iid: 8, name: 'Melody (Resampled)', sample: renders.melody },
      { iid: 9, name: 'Lead Synth', vst: { name: 'Serum', vendor: 'Xfer Records', path: 'C:\\Program Files\\Common Files\\VST3\\Serum.vst3' } },
      { iid: 10, name: 'Piano', plugin: 'FL Keys' },
      { iid: 11, name: 'Old Kick', sample: 'D:\\Sample Packs\\Drums\\Kick Old.wav' },
    ],
    patterns: [
      { iid: 1, name: 'Drums', channels: [0, 0, 1, 2, 2, 2, 11] },
      { iid: 2, name: 'Lead', channels: [9, 9, 9] },
      { iid: 3, name: 'Keys', channels: [10, 10] },
      { iid: 4, name: 'Shaker idea', channels: [3] },
    ],
    playlist: [{ pattern: 1 }, { pattern: 1 }, { pattern: 2 }, { pattern: 3 }, { channel: 4 }, { channel: 6 }, { channel: 7 }, { channel: 8 }],
    mixer: [{ plugin: 'Fruity Reeverb 2' }, { plugin: 'Fruity Limiter' }],
  });
  const songPath = put(`${songDir}/Night Drive.flp`, song);
  put(`${user}/Projects/Summer Tape/Summer Tape.flp`, F.project({ title: 'Summer Tape', channels: [{ iid: 0, name: 'Vox', sample: takes.other }], playlist: [{ channel: 0 }] }));
  console.log(songPath);
  console.log(`FL Studio user folder: ${path.join(target, user)}`);
}

if (process.argv.includes('--fl')) {
  flDemo();
  process.exit(0);
}

const f = {
  hero: put('Footage/A001_C003_hero.mov', blob(46, 1)),
  broll: put('Footage/A001_C007_broll.mov', blob(31, 2)),
  drone: put('Footage/DJI_0042_sunset.mp4', blob(22, 3)),
  outtake: put('Footage/A001_C011_outtake.mov', blob(38, 4)),
  heroCopy: put('Old Exports/A001_C003_hero.mov', blob(46, 1)),
  music: put('Audio/music_bed.wav', wav(8, [220, 277.18, 329.63])),
  vo3: put('Audio/vo_take3.wav', wav(5, [180])),
  vo2: put('Audio/vo_take2.wav', wav(5, [175])),
  logo: put('Graphics/client_logo.png', png(1200, 600, [10, 10, 10], [0, 90, 120], 3)),
  lower: put('Graphics/lower_third.png', png(1920, 240, [0, 60, 80], [0, 212, 255], 5)),
  texture: put('Graphics/bg_texture.png', png(1920, 1080, [30, 20, 60], [200, 80, 140], 7)),
  psd: put('Graphics/title_card.psd', blob(12, 5)),
  data: put('Data/scores.json', JSON.stringify({ home: 3, away: 1, minute: 88 }, null, 2)),
};
const frames = [];
for (let i = 1; i <= 48; i++) {
  frames.push(put(`Renders/smoke/smoke_${String(i).padStart(4, '0')}.png`, png(480, 270, [5, 5, 5], [40 + i * 3, 40 + i * 2, 50 + i * 3], i)));
}
const missing = path.join(target, 'Footage', 'B-Cam', 'interview_cam_b.mov');
const missingUnused = path.join(target, 'Exports', 'temp_export_v1.mov');

const project = B.project(
  [
    B.folder(100, 'Footage', [
      B.footage(101, { path: f.hero, duration: 42.2, fps: 23.976, width: 3840, height: 2160 }),
      B.footage(102, { path: f.broll, duration: 18.5, fps: 23.976, width: 3840, height: 2160 }),
      B.footage(103, { path: f.drone, duration: 26, fps: 29.97, width: 2720, height: 1530 }),
      B.footage(104, { path: f.outtake, duration: 31, fps: 23.976, width: 3840, height: 2160 }),
      B.footage(105, { path: missing, duration: 65, fps: 25, width: 1920, height: 1080 }),
      B.footage(106, { path: f.heroCopy, duration: 42.2, fps: 23.976, width: 3840, height: 2160 }),
      B.footage(107, { path: missingUnused, duration: 12, fps: 25 }),
    ]),
    B.folder(200, 'Audio', [
      B.footage(201, { path: f.music, width: 0, height: 0, duration: 8, fileType: 'WAVE' }),
      B.footage(202, { path: f.vo3, width: 0, height: 0, duration: 5, fileType: 'WAVE' }),
      B.footage(203, { path: f.vo2, width: 0, height: 0, duration: 5, fileType: 'WAVE' }),
    ]),
    B.folder(300, 'Graphics', [
      B.footage(301, { path: f.logo, width: 1200, height: 600, fileType: 'PNGf' }),
      B.footage(302, { path: f.lower, width: 1920, height: 240, fileType: 'PNGf' }),
      B.footage(303, { path: f.texture, width: 1920, height: 1080, fileType: 'PNGf' }),
      B.footage(304, { path: f.psd, width: 1920, height: 1080, fileType: '8BPS' }),
      B.footage(305, { path: frames[0], width: 480, height: 270, duration: 48 / 25, fps: 25, fileType: 'PNGf' }),
      B.footage(306, { path: f.data, width: 0, height: 0, fileType: 'json' }),
    ]),
    B.folder(400, 'Precomps', [
      B.comp(410, 'Lower Third', { duration: 6, layers: [{ source: 0, name: 'Name' }, { source: 302, name: 'Bar', effects: ['ADBE Linear Wipe'] }] }),
      B.comp(420, 'Logo Reveal', { duration: 4, layers: [{ source: 301, effects: ['ADBE Glo2', 'VIDEOCOPILOT OpticalFlares'] }, { source: 305, name: 'Smoke' }, { source: 900 }] }),
      B.comp(430, 'Scoreboard', { duration: 5, layers: [{ source: 0, name: 'Score (expression)' }, { source: 901, name: 'Adjustment Layer 1', effects: ['ADBE Pro Levels2'] }] }),
    ]),
    B.footage(900, { solid: { name: 'Black Solid 1', color: [0, 0, 0] } }),
    B.footage(901, { solid: { name: 'Adjustment Layer 1', color: [1, 1, 1] } }),
    B.comp(500, 'MAIN_Spot_30s', {
      duration: 30,
      layers: [
        { source: 420, name: 'Logo Reveal' },
        { source: 410, name: 'Lower Third' },
        { source: 430 },
        { source: 101, name: 'Hero', effects: ['ADBE Lumetri', 'ADBE Unsharp Mask2'] },
        { source: 102 },
        { source: 105, name: 'Interview B' },
        { source: 201 },
        { source: 202 },
        { source: 901, effects: ['ADBE Pro Levels2', 'RG Magic Bullet Looks'] },
      ],
    }),
    B.comp(510, 'Social_9x16', { width: 1080, height: 1920, fps: 29.97, duration: 15, layers: [{ source: 103 }, { source: 101 }, { source: 420 }, { source: 201 }] }),
  ],
  {
    xmp: '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description><xmp:CreatorTool>Adobe After Effects 2024 (Windows)</xmp:CreatorTool></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>',
    extraTop: [B.chunk('LIST', Buffer.concat([Buffer.from('tdbs'), B.utf8('var d = footage("scores.json").sourceData; d.home + " : " + d.away')]))],
  },
);
const projectPath = put('Spot_v3.aep', project);
console.log(projectPath);
