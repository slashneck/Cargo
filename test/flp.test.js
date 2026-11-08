'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const F = require('./helpers/buildFlp');
const flp = require('../src/core/flp');
const { scanProject, applyLeftovers } = require('../src/core/analyze');
const { findLeftovers } = require('../src/core/leftovers');
const collect = require('../src/core/collect');
const { planDeleteUnused } = require('../src/core/cleanup');
const report = require('../src/core/report');
const privacy = require('../src/core/privacy');
const flenv = require('../src/core/flenv');

const DEMO_DIR = 'C:\\Program Files\\Image-Line\\FL Studio 2025\\Data\\Demo projects';

async function tmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'cargo-flp-'));
}

async function write(file, content) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, content);
  return file;
}

/**
 * A song folder with vocal takes in an FL-style user folder:
 *   take 1 and 3 used, take 2 deleted from the project, take 4 used by
 *   another song, a render on the playlist and a sample next to the project.
 */
async function fixture() {
  const root = await tmpDir();
  const user = path.join(root, 'FL Studio');
  const recorded = path.join(user, 'Audio', 'Recorded');
  const rendered = path.join(user, 'Audio', 'Rendered');
  const songDir = path.join(user, 'Projects', 'Night Drive');
  const files = {
    take1: await write(path.join(recorded, 'Night Drive_Vox_01.wav'), Buffer.alloc(4000, 1)),
    take2: await write(path.join(recorded, 'Night Drive_Vox_02.wav'), Buffer.alloc(5000, 2)),
    take3: await write(path.join(recorded, 'Night Drive_Vox_03.wav'), Buffer.alloc(6000, 3)),
    take4: await write(path.join(recorded, 'Other Song_Vox_01.wav'), Buffer.alloc(7000, 4)),
    render: await write(path.join(rendered, 'Melody (consolidated).wav'), Buffer.alloc(8000, 5)),
    oldRender: await write(path.join(rendered, 'Melody old.wav'), Buffer.alloc(9000, 6)),
    kick: await write(path.join(songDir, 'kick.wav'), Buffer.alloc(1000, 7)),
    unusedPad: await write(path.join(songDir, 'samples', 'pad.wav'), Buffer.alloc(2000, 8)),
    ir: await write(path.join(root, 'IRs', 'hall.wav'), Buffer.alloc(300, 9)),
  };
  const song = F.project({
    title: 'Night Drive',
    channels: [
      { iid: 0, name: 'Kick', sample: 'D:\\Old Drive\\Samples\\kick.wav' },
      { iid: 1, name: 'Vox 1', sample: files.take1 },
      { iid: 2, name: 'Vox 3', sample: files.take3 },
      { iid: 3, name: 'Melody (Rendered)', sample: files.render },
      { iid: 4, name: 'Pad', sample: files.unusedPad },
      { iid: 5, name: 'Lead', vst: { name: 'Serum', vendor: 'Xfer Records', path: 'C:\\VST\\Serum_x64.dll' } },
    ],
    patterns: [
      { iid: 1, name: 'Drums', channels: [0, 0, 0] },
      { iid: 2, name: 'Lead', channels: [5] },
      { iid: 3, name: 'Pad idea', channels: [4] },
    ],
    playlist: [{ pattern: 1 }, { pattern: 2 }, { channel: 1 }, { channel: 2 }, { channel: 3 }],
    mixer: [{ plugin: 'Fruity Convolver', embedded: files.ir }],
  });
  const songPath = await write(path.join(songDir, 'Night Drive.flp'), song);
  const other = F.project({ title: 'Other Song', channels: [{ iid: 0, name: 'Vox', sample: files.take4 }], playlist: [{ channel: 0 }] });
  await write(path.join(user, 'Projects', 'Other Song', 'Other Song.flp'), other);
  const env = { installDirs: [], userDir: user };
  return { root, user, songDir, songPath, files, env, song };
}

test('reads channels, patterns, the playlist and plugins', () => {
  const buf = F.project({
    channels: [
      { iid: 0, sample: 'C:\\a.wav' },
      { iid: 1, sample: 'C:\\b.wav' },
      { iid: 2, sample: 'C:\\c.wav' },
      { iid: 3, name: 'Layer', plugin: 'Layer', children: [2] },
      { iid: 4, sample: 'C:\\d.wav' },
    ],
    patterns: [{ iid: 1, channels: [0, 3] }, { iid: 2, channels: [4] }],
    playlist: [{ pattern: 1 }, { channel: 1 }],
  });
  const p = flp.parseFlp(buf);
  assert.equal(p.format, 'flp');
  assert.equal(p.creatorTool, 'FL Studio 25.2.3.5164');
  const used = (name) => p.usedIds.has(p.footage.find((f) => f.path === name).id);
  assert.equal(used('C:\\a.wav'), true, 'note in a placed pattern');
  assert.equal(used('C:\\b.wav'), true, 'audio clip on the playlist');
  assert.equal(used('C:\\c.wav'), true, 'child of a used layer');
  assert.equal(used('C:\\d.wav'), false, 'only in a pattern that is not on the playlist');
  assert.ok(p.comps.some((c) => c.kind === 'arrangement'));
  assert.ok(flp.verifyRoundTrip(buf));
});

test('reads every FL Studio version layout of the playlist', () => {
  for (const version of ['12.3.0.1', '21.0.3.3517', '25.2.3.5164']) {
    const buf = F.project({ version, channels: [{ iid: 0, sample: 'C:\\x.wav' }], playlist: [{ channel: 0 }] });
    const p = flp.parseFlp(buf);
    assert.equal(p.usedIds.size, 1, version);
    assert.equal(p.warnings.length, 0, version);
  }
});

test('names third-party plugins and finds samples inside plugin states', async () => {
  const fx = await fixture();
  const p = flp.parseFlp(fx.song);
  const serum = p.effects.find((e) => e.displayName === 'Serum');
  assert.equal(serum.builtIn, false);
  assert.match(serum.matchName, /Xfer Records/);
  const ir = p.footage.find((f) => f.origin === 'plugin');
  assert.equal(ir.path, fx.files.ir);
  assert.equal(p.usedIds.has(ir.id), true, 'mixer effects always play');
});

test('rejects files that are not FL projects', () => {
  assert.throws(() => flp.parseFlp(Buffer.from('not a project at all, sorry')), /Not an FL Studio project/);
});

test('rewrites sample paths and makes private copies', () => {
  const buf = F.project({ licensee: 'Jane Producer', dataPath: 'C:\\Users\\jane\\Music\\Night Drive', channels: [{ iid: 0, sample: 'C:\\Users\\jane\\Vox_01.wav' }], playlist: [{ channel: 0 }] });
  const mapping = new Map([['C:\\Users\\jane\\Vox_01.wav', 'C:\\Package\\Vox_01.wav']]);
  const { buffer, changed } = flp.rewriteFlpPaths(buf, mapping, { privateCopy: true, scrubText: privacy.scrubPaths });
  assert.equal(changed, 1);
  assert.equal(flp.parseFlp(buffer).footage[0].path, 'C:\\Package\\Vox_01.wav');
  assert.deepEqual(privacy.findLeaks(buffer, ['jane', 'Jane Producer']), []);
  assert.ok(flp.verifyRoundTrip(buffer));
});

test('scan sorts recordings and renders, and finds samples next to the project like FL does', async () => {
  const fx = await fixture();
  const s = await scanProject(fx.songPath, { env: fx.env });
  assert.equal(s.app, 'FL Studio');
  const byName = (n) => s.assets.find((a) => a.name === n);
  assert.equal(byName('Night Drive_Vox_01.wav').category, 'recording');
  assert.equal(byName('Melody (consolidated).wav').category, 'render');
  const kick = byName('kick.wav');
  assert.equal(kick.exists, true);
  assert.equal(kick.foundNearby, true);
  assert.equal(kick.status, 'used');
  assert.equal(byName('pad.wav').status, 'unused');
  assert.equal(byName('Night Drive_Vox_01.wav').folderPath, 'Vox 1');
});

test('leftovers: deleted takes, but never files another project uses', async () => {
  const fx = await fixture();
  const s = await scanProject(fx.songPath, { env: fx.env });
  const result = await findLeftovers(s, {
    folders: flenv.leftoverFolders(fx.env, { projectDir: s.dir, dataPath: null }),
    projectRoots: flenv.projectFolders(fx.env, { projectDir: s.dir }),
    env: fx.env,
  });
  const names = result.leftovers.map((l) => path.basename(l.path)).sort();
  assert.deepEqual(names, ['Melody old.wav', 'Night Drive_Vox_02.wav']);
  assert.equal(result.keptForOthers, 1, 'Other Song still uses its take');
  assert.equal(result.projectsChecked, 1);
  applyLeftovers(s, result, fx.env);
  assert.equal(s.totals.leftoverCount, 2);
  const take2 = s.assets.find((a) => a.name === 'Night Drive_Vox_02.wav');
  assert.equal(take2.status, 'leftover');
  assert.equal(take2.category, 'recording');
  // Delete Unused offers the leftovers and the unused pad.
  const plan = planDeleteUnused(s);
  assert.deepEqual(plan.groups.map((g) => g.name).sort(), ['Melody old.wav', 'Night Drive_Vox_02.wav', 'pad.wav']);
});

test('an unused take another song still uses is never offered for deletion', async () => {
  const fx = await fixture();
  // Night Drive keeps Other Song's take in its channel rack without using it.
  const song = F.project({ channels: [{ iid: 0, name: 'Borrowed vox', sample: fx.files.take4 }, { iid: 1, name: 'Vox 1', sample: fx.files.take1 }], playlist: [{ channel: 1 }] });
  await fsp.writeFile(fx.songPath, song);
  const s = await scanProject(fx.songPath, { env: fx.env });
  assert.equal(s.assets.find((a) => a.name === 'Other Song_Vox_01.wav').status, 'unused');
  const result = await findLeftovers(s, { folders: flenv.leftoverFolders(fx.env, { projectDir: s.dir }), projectRoots: flenv.projectFolders(fx.env, { projectDir: s.dir }), env: fx.env });
  applyLeftovers(s, result, fx.env);
  // The same protection the app builds before deleting.
  const reasons = new Map([...s.externalRefs].map(([key, name]) => [key, `Used by “${name}”`]));
  const plan = planDeleteUnused(s, { protectedKeys: new Set(reasons.keys()), protectedReasons: reasons });
  assert.ok(!plan.groups.some((g) => g.name === 'Other Song_Vox_01.wav'));
  assert.ok(plan.skipped.some((k) => k.name === 'Other Song_Vox_01.wav' && /Other Song/.test(k.reason)));
});

test('packages an FL project next to its samples, without leftovers or stock samples', async () => {
  const fx = await fixture();
  const s = await scanProject(fx.songPath, { env: fx.env });
  s.assets.push({ ...s.assets[0], id: 999, name: 'stock.wav', category: 'stock', resolvedPath: fx.files.kick, path: '%FLStudioFactoryData%\\Data\\x.wav' });
  const result = await findLeftovers(s, { folders: [path.join(fx.user, 'Audio', 'Recorded')], projectRoots: [path.join(fx.user, 'Projects')], env: fx.env });
  applyLeftovers(s, result, fx.env);
  const plan = collect.planCollect(s, { includeUnused: false, layout: 'flat', prefix: '' });
  const rels = plan.entries.map((e) => e.rel).sort();
  assert.deepEqual(rels, ['Melody (consolidated).wav', 'Night Drive_Vox_01.wav', 'Night Drive_Vox_03.wav', 'hall.wav', 'kick.wav']);
  assert.ok(plan.skipped.some((k) => k.reason === 'stock'));
  const out = path.join(await tmpDir(), 'Night Drive_Package');
  const mapping = collect.pathMapping(s, plan, out);
  const relinked = collect.relinkedProject(s, fx.song, mapping);
  assert.equal(relinked.warning, null);
  const packaged = flp.parseFlp(relinked.buffer);
  assert.equal(packaged.footage.find((f) => f.group === 'Vox 1').path, path.join(out, 'Night Drive_Vox_01.wav'));
  // The manifest never lists leftovers.
  const data = report.reportData(s, { plan, title: 'Package Manifest', privateMode: true });
  assert.doesNotMatch(report.toText(data), /Vox_02/);
  assert.doesNotMatch(report.toJson(data), /Vox_02|Melody old/);
});

test('FL Studio demo projects round-trip', { skip: !fs.existsSync(DEMO_DIR) && 'FL Studio demo projects not installed' }, () => {
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.flp$/i.test(e.name)) files.push(p);
    }
  })(DEMO_DIR);
  assert.ok(files.length > 10);
  for (const f of files) {
    const buf = fs.readFileSync(f);
    const p = flp.parseFlp(buf);
    assert.equal(p.warnings.length, 0, path.basename(f));
    assert.ok(flp.verifyRoundTrip(buf), path.basename(f));
  }
});
