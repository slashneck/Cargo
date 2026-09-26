'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const yauzl = require('yauzl');

const B = require('./helpers/buildAep');
const aep = require('../src/core/aep');
const riff = require('../src/core/riff');
const { parseAepx, rewriteAepxPaths } = require('../src/core/aepx');
const { scanProject } = require('../src/core/analyze');
const collect = require('../src/core/collect');
const { planDeleteUnused } = require('../src/core/cleanup');
const { findMissing } = require('../src/core/relink');
const { findDuplicates } = require('../src/core/duplicates');
const report = require('../src/core/report');
const { matchSequence } = require('../src/core/sequence');

const SAMPLE_AEP = 'C:\\Program Files\\Adobe\\Adobe After Effects 2020\\Support Files\\Required\\secret.aep';

async function tmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'cargo-test-'));
}

async function write(file, content) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, content);
  return file;
}

/** A project on disk with used, unused, shared, missing and sequence footage. */
async function fixture() {
  const dir = await tmpDir();
  const files = {
    hero: await write(path.join(dir, 'footage', 'hero.mov'), Buffer.alloc(5000, 1)),
    music: await write(path.join(dir, 'audio', 'music.wav'), Buffer.alloc(3000, 2)),
    unused: await write(path.join(dir, 'footage', 'outtake.mov'), Buffer.alloc(7000, 3)),
    heroCopy: await write(path.join(dir, 'old', 'hero.mov'), Buffer.alloc(5000, 1)),
    logo: await write(path.join(dir, 'gfx', 'logo_01.png'), Buffer.alloc(100, 4)),
    logo2: await write(path.join(dir, 'gfx', 'logo_02.png'), Buffer.alloc(100, 5)),
  };
  for (let i = 1; i <= 5; i++) {
    files[`frame${i}`] = await write(path.join(dir, 'renders', `smoke_${String(i).padStart(4, '0')}.png`), Buffer.alloc(200, i));
  }
  const missingPath = path.join(dir, 'gone', 'interview.mov');
  const buf = B.project([
    B.folder(10, 'Footage', [
      B.footage(11, { path: files.hero, duration: 12, fps: 23.976 }),
      B.footage(12, { path: files.unused, duration: 4, fps: 25 }),
      B.footage(13, { path: missingPath, duration: 30, fps: 25 }),
      B.footage(14, { path: files.heroCopy, duration: 12, fps: 23.976 }),
    ]),
    B.folder(20, 'Audio', [B.footage(21, { path: files.music, width: 0, height: 0, duration: 60, fileType: 'WAVE' })]),
    B.footage(30, { path: files.frame1, width: 1280, height: 720, duration: 5 / 25, fps: 25, fileType: 'PNGf' }),
    B.footage(31, { path: files.logo, width: 512, height: 512, duration: 0, fileType: 'PNGf' }),
    B.footage(40, { solid: { name: 'Black Solid 1', color: [0, 0, 0] } }),
    B.comp(50, 'Main', {
      layers: [
        { source: 11, name: 'Hero', effects: ['ADBE Gaussian Blur 2', 'VIDEOCOPILOT OpticalFlares'] },
        { source: 21 },
        { source: 60 },
        { source: 40 },
        { source: 0, name: 'Text' },
      ],
    }),
    B.comp(60, 'Precomp', { layers: [{ source: 30 }, { source: 13 }, { source: 31 }] }),
  ]);
  const projectPath = await write(path.join(dir, 'Spot.aep'), buf);
  return { dir, files, missingPath, projectPath, buf };
}

function readZip(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const entries = {};
      zip.on('entry', (e) => {
        zip.openReadStream(e, (err2, rs) => {
          if (err2) return reject(err2);
          const parts = [];
          rs.on('data', (d) => parts.push(d));
          rs.on('end', () => {
            entries[e.fileName] = Buffer.concat(parts);
            zip.readEntry();
          });
        });
      });
      zip.on('end', () => resolve(entries));
      zip.readEntry();
    });
  });
}

test('rejects files that are not projects with a readable message', () => {
  assert.throws(() => aep.parseAep(Buffer.from('hello world, not a project')), /Not an After Effects project/);
  assert.throws(() => aep.parseAep(Buffer.alloc(4)), /too small/);
});

test('parses folders, comps, layers, footage and effects', () => {
  const buf = B.project([
    B.folder(1, 'Shots', [B.footage(2, { path: 'D:\\Jobs\\a.mov', duration: 10, fps: 29.97 })]),
    B.footage(3, { solid: { name: 'White Solid', color: [1, 1, 1] } }),
    B.comp(4, 'Main', { fps: 25, duration: 8, layers: [{ source: 2, effects: ['ADBE Fill', 'RG Universe Glow'] }, { source: 3 }] }),
  ]);
  const p = aep.parseAep(buf);
  assert.equal(p.creatorTool, 'Adobe After Effects 2024 (Windows)');
  assert.deepEqual(p.folders.map((f) => f.name), ['Shots']);
  const [shot, solid] = p.footage;
  assert.equal(shot.kind, 'file');
  assert.equal(shot.path, 'D:\\Jobs\\a.mov');
  assert.equal(shot.name, 'a.mov');
  assert.equal(shot.parentId, 1);
  assert.equal(shot.duration, 10);
  assert.equal(shot.fps, 29.97);
  assert.equal(solid.kind, 'solid');
  assert.equal(solid.name, 'White Solid');
  const [comp] = p.comps;
  assert.deepEqual([comp.width, comp.height, comp.fps, comp.duration], [1920, 1080, 25, 8]);
  assert.deepEqual(comp.layers.map((l) => l.sourceId), [2, 3]);
  const glow = p.effects.find((e) => e.matchName === 'RG Universe Glow');
  assert.equal(glow.builtIn, false);
  assert.equal(p.effects.find((e) => e.matchName === 'ADBE Fill').builtIn, true);
});

test('round-trips byte for byte and rewrites paths safely', () => {
  const buf = B.project([B.footage(2, { path: 'D:\\a.mov' }), B.footage(3, { path: 'E:\\ü\\b.png' }), B.comp(4, 'C', { layers: [{ source: 2 }] })]);
  assert.ok(aep.verifyRoundTrip(buf));
  const mapping = new Map([['E:\\ü\\b.png', 'F:\\Packages\\Footage\\Images\\b — final.png']]);
  const { buffer, changed } = aep.rewriteFootagePaths(buf, mapping);
  assert.equal(changed, 1);
  const p = aep.parseAep(buffer);
  assert.deepEqual(p.footage.map((f) => f.path), ['D:\\a.mov', 'F:\\Packages\\Footage\\Images\\b — final.png']);
  assert.equal(p.comps[0].layers[0].sourceId, 2);
  assert.ok(aep.verifyRoundTrip(buffer));
  assert.ok(buffer.toString('utf8').endsWith('</x:xmpmeta>'), 'XMP trailer preserved');
});

test('keeps undecodable lists as opaque bytes', () => {
  const garbage = B.chunk('LIST', Buffer.concat([Buffer.from('btdk'), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9])]));
  const broken = B.chunk('LIST', Buffer.concat([Buffer.from('tdgp'), Buffer.from('abcd'), Buffer.from([0, 0, 0xff, 0xff])]));
  const buf = B.project([B.footage(2, { path: 'C:\\x.mov' })], { extraTop: [garbage, broken] });
  assert.ok(aep.verifyRoundTrip(buf));
  const tree = riff.parseRifx(buf);
  assert.equal(tree.root.children.find((c) => c.listType === 'tdgp').opaque, true);
  const { buffer } = aep.rewriteFootagePaths(buf, new Map([['C:\\x.mov', 'C:\\longer\\path\\x.mov']]));
  assert.equal(aep.parseAep(buffer).footage[0].path, 'C:\\longer\\path\\x.mov');
});

test('real After Effects project round-trips', { skip: !fs.existsSync(SAMPLE_AEP) && 'sample project not installed' }, () => {
  const buf = fs.readFileSync(SAMPLE_AEP);
  const p = aep.parseAep(buf);
  assert.ok(p.comps.length > 10);
  assert.equal(p.warnings.length, 0);
  assert.ok(p.comps.some((c) => c.width === 1920 && c.height === 1080 && c.fps === 24));
  assert.ok(aep.verifyRoundTrip(buf));
});

test('parses .aepx and rewrites its paths', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<AfterEffectsProject xmlns="http://www.adobe.com/products/aftereffects" majorVersion="1" minorVersion="0">
<svap bdata="00000001"/>
<Fold><fdta bdata="0000"/>
<Item><idta bdata="${'0007' + '00'.repeat(14) + '00000009' + '00'.repeat(64)}"/><string></string>
<Pin><sspc bdata="${'00'.repeat(200)}"/><Als2><fileReference fullpath="C:\\Clips\\a &amp; b.mov" target_is_folder="0"/></Als2></Pin></Item>
<Item><idta bdata="${'0004' + '00'.repeat(14) + '0000000a' + '00'.repeat(64)}"/><string>Main &lt;v2&gt;</string>
<cdta bdata="${'00'.repeat(204)}"/><Layr><ldta bdata="${'00'.repeat(40) + '00000009' + '00'.repeat(116)}"/><string>layer</string></Layr></Item>
</Fold></AfterEffectsProject>`;
  const p = parseAepx(Buffer.from(xml));
  assert.equal(p.format, 'aepx');
  assert.equal(p.footage[0].path, 'C:\\Clips\\a & b.mov');
  assert.equal(p.comps[0].name, 'Main <v2>');
  assert.equal(p.comps[0].layers[0].sourceId, 9);
  const { buffer, changed } = rewriteAepxPaths(Buffer.from(xml), new Map([['C:\\Clips\\a & b.mov', 'D:\\New\\"quoted".mov']]));
  assert.equal(changed, 1);
  assert.equal(parseAepx(buffer).footage[0].path, 'D:\\New\\"quoted".mov');
});

test('detects image sequences', () => {
  const names = ['a_0001.png', 'a_0002.png', 'a_0004.png', 'a_1.png', 'b_0001.png', 'a_0003.jpg'];
  const seq = matchSequence(path.join('x', 'a_0001.png'), names);
  assert.equal(seq.frames.length, 3);
  assert.equal(seq.gaps, 1);
  assert.equal(seq.pattern, 'a_[####].png');
});

test('scan resolves files, sequences, usage and totals', async () => {
  const fx = await fixture();
  const s = await scanProject(fx.projectPath);
  const byId = new Map(s.assets.map((a) => [a.id, a]));
  assert.equal(byId.get(11).status, 'used');
  assert.equal(byId.get(12).status, 'unused');
  assert.equal(byId.get(13).status, 'missing');
  assert.equal(byId.get(14).status, 'unused');
  assert.equal(byId.get(40).status, 'generated');
  assert.equal(byId.get(31).isSequence, false, 'still image with numbered siblings is not a sequence');
  const seq = byId.get(30);
  assert.equal(seq.isSequence, true);
  assert.equal(seq.frameCount, 5);
  assert.equal(seq.size, 1000);
  assert.deepEqual(byId.get(30).usedIn, [60]);
  assert.equal(s.totals.unusedSize, 12000);
  assert.equal(s.totals.usedSize, 5000 + 3000 + 1000 + 100);
  assert.equal(s.totals.missingCount, 1);
  assert.equal(s.folders.find((f) => f.id === 10).path, 'Footage');
  assert.equal(byId.get(11).folderPath, 'Footage');
});

test('packages used files into a zip with a relinked project', async () => {
  const fx = await fixture();
  const s = await scanProject(fx.projectPath);
  const plan = collect.planCollect(s, { includeUnused: false, layout: 'type', prefix: 'Footage' });
  assert.deepEqual(plan.skipped.map((k) => k.reason).sort(), ['missing', 'unused', 'unused']);
  const out = await tmpDir();
  const zipPath = path.join(out, 'Spot_Package.zip');
  const root = path.join(out, 'Spot_Package');
  const mapping = collect.pathMapping(s, plan, root);
  const relinked = collect.relinkedProject(s, fx.buf, mapping);
  assert.equal(relinked.warning, null);
  assert.equal(relinked.changed, 4);
  const txt = report.toText(report.reportData(s, { plan, title: 'Package Manifest' }));
  const progress = [];
  await collect.writeZip(plan, [{ rel: 'Spot.aep', data: relinked.buffer }, { rel: 'MANIFEST.txt', data: Buffer.from(txt) }], zipPath, { onProgress: (p) => progress.push(p) });
  const entries = await readZip(zipPath);
  const names = Object.keys(entries).sort();
  assert.ok(names.includes('Footage/Video/hero.mov'));
  assert.ok(names.includes('Footage/Audio/music.wav'));
  assert.ok(names.includes('Footage/Sequences/smoke/smoke_0005.png'));
  assert.ok(names.includes('Footage/Images/logo_01.png'));
  assert.ok(!names.some((n) => n.includes('outtake')));
  assert.equal(entries['Footage/Video/hero.mov'].length, 5000);
  const packaged = aep.parseAep(entries['Spot.aep']);
  const hero = packaged.footage.find((f) => f.id === 11);
  assert.equal(hero.path, path.join(root, 'Footage', 'Video', 'hero.mov'));
  assert.equal(packaged.footage.find((f) => f.id === 12).path, fx.files.unused, 'excluded files keep their path');
  assert.match(txt, /MISSING — NOT INCLUDED \(1\)/);
  assert.ok(progress.length > 0);
});

test('copies to a folder and the relinked project points at real files', async () => {
  const fx = await fixture();
  const s = await scanProject(fx.projectPath);
  const plan = collect.planCollect(s, { includeUnused: true, layout: 'project', prefix: 'Footage' });
  const root = path.join(await tmpDir(), 'Archive');
  const { done, failed } = await collect.copyToFolder(plan, root);
  assert.equal(failed.length, 0);
  assert.equal(done.length, plan.entries.length);
  const mapping = collect.pathMapping(s, plan, root);
  const { buffer } = collect.relinkedProject(s, fx.buf, mapping);
  const newProject = path.join(root, 'Spot.aep');
  await fsp.writeFile(newProject, buffer);
  const rescanned = await scanProject(newProject);
  const missing = rescanned.assets.filter((a) => a.status === 'missing' || a.status === 'unused-missing');
  assert.deepEqual(missing.map((a) => a.id), [13]);
  assert.equal(rescanned.assets.find((a) => a.id === 30).frameCount, 5);
  // Two different files named hero.mov must not collide.
  const heroes = plan.entries.filter((e) => e.rel.includes('hero'));
  assert.equal(new Set(heroes.map((e) => e.rel)).size, 2);
});

test('cancelling a zip removes the partial file', async () => {
  const fx = await fixture();
  const s = await scanProject(fx.projectPath);
  const plan = collect.planCollect(s, { includeUnused: true, layout: 'flat' });
  const zipPath = path.join(await tmpDir(), 'x.zip');
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(collect.writeZip(plan, [], zipPath, { signal: ac.signal }), /Cancelled/);
  assert.equal(fs.existsSync(zipPath), false);
  assert.equal(fs.existsSync(`${zipPath}.cargo-part`), false);
});

test('delete plan never offers files that are still needed', async () => {
  const fx = await fixture();
  // Item 14 (unused) points at a file that item 11 (used) also uses.
  const buf = B.project([
    B.footage(11, { path: fx.files.hero }),
    B.footage(14, { path: fx.files.hero }),
    B.footage(12, { path: fx.files.unused }),
    B.footage(15, { path: fx.files.music }),
    B.comp(50, 'Main', { layers: [{ source: 11 }] }),
  ]);
  const p = await write(path.join(fx.dir, 'Shared.aep'), buf);
  const s = await scanProject(p);
  const keep = new Set([require('../src/core/fsutil').pathKey(fx.files.music)]);
  const plan = planDeleteUnused(s, { protectedKeys: keep, protectedReasons: new Map([[[...keep][0], 'Tagged keep']]) });
  assert.deepEqual(plan.groups.map((g) => g.id), [12]);
  assert.deepEqual(plan.skipped.map((k) => [k.id, k.reason]).sort(), [
    [14, 'Also used by another item in this project'],
    [15, 'Tagged keep'],
  ]);
});

test('finds moved files near the project', async () => {
  const fx = await fixture();
  const moved = await write(path.join(fx.dir, 'archive', 'gone', 'interview.mov'), Buffer.alloc(10));
  const { results } = await findMissing([{ id: 13, path: fx.missingPath }], { roots: [fx.dir] });
  assert.equal(results[0].candidates[0].path, moved);
});

test('finds identical and similar files', async () => {
  const fx = await fixture();
  const s = await scanProject(fx.projectPath);
  const d = await findDuplicates(s);
  assert.equal(d.identical.length, 1);
  const g = d.identical[0];
  assert.equal(g.members.length, 2);
  assert.equal(g.keep, require('../src/core/fsutil').pathKey(fx.files.hero), 'keeps the used copy');
});

test('reports render in every format', async () => {
  const fx = await fixture();
  const s = await scanProject(fx.projectPath);
  const data = report.reportData(s);
  assert.match(report.toText(data), /USED \(/);
  const csv = report.toCsv(data);
  assert.equal(csv.split('\r\n').length, s.assets.filter((a) => a.kind === 'file').length + 1);
  assert.doesNotThrow(() => JSON.parse(report.toJson(data)));
  assert.match(report.toHtml(data), /<table>/);
  assert.match(report.batchHtml([s, s]), /2 projects/);
});

test('private copies leave no paths, user names or save history behind', async () => {
  const privacy = require('../src/core/privacy');
  const fx = await fixture();
  const s = await scanProject(fx.projectPath);
  const plan = collect.planCollect(s, { includeUnused: false, layout: 'type', prefix: 'Footage' });
  const neutral = privacy.neutralRoot('Spot_Package');
  const mapping = collect.pathMapping(s, plan, neutral);
  const fallback = (p) => privacy.neutralPath(neutral, `Not included/${privacy.lastSegment(p)}`);
  const { buffer, changed, warning } = collect.relinkedProject(s, fx.buf, mapping, { fallback, scrubText: privacy.scrubPaths, xmp: privacy.neutralXmp() });
  assert.equal(warning, null);
  assert.ok(changed >= 6);
  // The fixture lives in the temp folder, whose path contains the user's name.
  const home = os.homedir();
  const needles = [fx.dir, home, path.basename(home)];
  assert.deepEqual(privacy.findLeaks(buffer, needles), []);
  assert.doesNotMatch(buffer.toString('latin1'), /CreatorTool/);
  const packaged = aep.parseAep(buffer);
  assert.equal(packaged.footage.find((f) => f.id === 11).path, path.join(neutral, 'Footage', 'Video', 'hero.mov'));
  assert.equal(packaged.footage.find((f) => f.id === 12).path, path.join(neutral, 'Not included', 'outtake.mov'));

  const data = report.reportData(s, { plan, title: 'Package Manifest', privateMode: true });
  for (const text of [report.toText(data), report.toJson(data)]) {
    assert.deepEqual(privacy.findLeaks(Buffer.from(text), needles), []);
    assert.doesNotMatch(text, /Saved with|Location/);
  }
});

test('path scrubbing keeps only file names', () => {
  const { scrubPaths } = require('../src/core/privacy');
  assert.equal(scrubPaths('see C:\\Users\\someone\\Desktop\\clip.mov here'), 'see clip.mov here');
  assert.equal(scrubPaths('\\\\server\\share\\jobs\\a.png'), 'a.png');
  assert.equal(scrubPaths('/Users/someone/Movies/b.mov'), 'b.mov');
  assert.equal(scrubPaths('/Volumes/Media/c.wav and text'), 'c.wav and text');
  assert.equal(scrubPaths('no paths: 12:30, a/b'), 'no paths: 12:30, a/b');
});
