'use strict';

// Development helper: starts Cargo, walks through the main screens and saves
// screenshots plus the renderer console, then quits.
//
//   npx electron scripts/snapshot.js <out-dir> [project.aep]

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const PROJECT = /\.(aepx?|flp)$/i;
const outDir = path.resolve(process.argv.find((a, i) => i >= 2 && !a.startsWith('-') && !PROJECT.test(a) && !a.endsWith('snapshot.js')) || 'snapshots');
const hasProject = process.argv.some((a) => PROJECT.test(a));
fs.mkdirSync(outDir, { recursive: true });
// Keep test runs out of the real recent list and settings.
app.setPath('userData', path.join(outDir, 'userdata'));
// Started from scripts/, Electron would report its own version; --app-version=x.y.z tests the update prompt.
const versionArg = process.argv.find((a) => a.startsWith('--app-version='));
app.getVersion = () => (versionArg ? versionArg.split('=')[1] : require('../package.json').version);
const log = [];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (e) => log.push(`[${e.level}] ${e.message} (${e.sourceId}:${e.lineNumber})`));
  win.webContents.on('preload-error', (_ev, p, err) => log.push(`[preload-error] ${p}: ${err}`));
  win.webContents.once('did-finish-load', async () => {
    const shot = async (name) => {
      await wait(700);
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(outDir, `${name}.png`), img.toPNG());
    };
    const js = (code) => win.webContents.executeJavaScript(code, true).catch((err) => log.push(`[js-error] ${err.message}`));
    try {
      await wait(hasProject ? 2500 : 1200);
      if (!hasProject) {
        await shot('01-welcome');
        if (versionArg) {
          // The update check runs a few seconds after start.
          for (let i = 0; i < 40 && !(await js(`!!document.querySelector('.update-pill')`)); i++) await wait(500);
          await shot('02-update-available');
          await js(`document.querySelector('.update-pill') && document.querySelector('.update-pill').click()`);
          await shot('03-update-dialog');
        }
      } else if (process.argv.filter((a) => PROJECT.test(a)).length > 1) {
        // Several projects open the batch view.
        await wait(1500);
        await shot('01-batch');
        await js(`[...document.querySelectorAll('.btn')].find(b => b.textContent.trim() === 'Open').click()`);
        await shot('02-batch-project');
      } else {
        await shot('01-assets');
        await js(`document.querySelector('.trow') && document.querySelector('.trow').dispatchEvent(new MouseEvent('mousedown', {bubbles: true}))`);
        await shot('02-assets-selected');
        const tabs = ['insights', 'comps', 'effects', 'duplicates'];
        for (let i = 0; i < tabs.length; i++) {
          await js(`document.querySelectorAll('.tab')[${i + 1}].click()`);
          await shot(`0${i + 3}-${tabs[i]}`);
        }
        await js(`document.querySelectorAll('.tab')[0].click()`);
        await js(`[...document.querySelectorAll('.actionbar .btn')].find(b => b.textContent.includes('Package Project')).click()`);
        await shot('07-package-dialog');
        await js(`document.querySelector('.modal-head .close').click()`);
        await js(`[...document.querySelectorAll('.actionbar .btn')].find(b => b.textContent.includes('Delete Unused')).click()`);
        await shot('08-delete-dialog');
        await js(`document.querySelector('.modal-head .close').click()`);
        await js(`[...document.querySelectorAll('.actionbar .btn')].find(b => b.textContent.includes('Find Missing')).click()`);
        await wait(300);
        await js(`[...document.querySelectorAll('.modal .btn')].find(b => b.textContent.includes('Search now')).click()`);
        await wait(1500);
        await shot('09-missing-dialog');
        await js(`document.querySelector('.modal-head .close').click()`);
        // Tick two rows: the toolbar offers to delete them.
        await js(`[...document.querySelectorAll('.trow .c-check input')].slice(2, 4).forEach((i) => i.click())`);
        await shot('10-two-selected');
        await js(`[...document.querySelectorAll('.toolbar .btn')].find(b => b.textContent.includes('selected')).click()`);
        await shot('11-delete-selected');
        await js(`document.querySelector('.modal-head .close').click()`);
        await js(`document.querySelector('.btn-group .icon-only').click()`);
        await shot('12-delete-menu');
        await js(`[...document.querySelectorAll('.menu-item')].find(b => b.textContent.includes('All media')).click()`);
        await shot('13-delete-all');
        await js(`document.querySelector('.modal-head .close').click()`);
        await js(`document.querySelector('[title="Help"]').click()`);
        await shot('14-help');
        await js(`document.querySelector('.modal-head .close').click()`);
        const looked = await js(`!!([...document.querySelectorAll('.banner .btn')].find(b => b.textContent.includes('Where Cargo looked')))`);
        if (looked) {
          await js(`[...document.querySelectorAll('.banner .btn')].find(b => b.textContent.includes('Where Cargo looked')).click()`);
          await shot('15-leftovers-dialog');
          await js(`document.querySelector('.modal-head .close').click()`);
          await js(`[...document.querySelectorAll('.banner .btn')].find(b => b.textContent.includes('Show them')).click()`);
          await js(`document.querySelector('.trow') && document.querySelector('.trow').dispatchEvent(new MouseEvent('mousedown', {bubbles: true}))`);
          await shot('16-leftovers-list');
        }
        if (process.argv.includes('--flow')) {
          // Package for real into the project's folder and show the result.
          await js(`[...document.querySelectorAll('.actionbar .btn')].find(b => b.textContent.includes('Package Project')).click()`);
          await wait(600);
          await js(`[...document.querySelectorAll('.modal-foot .btn')].find(b => b.textContent.trim() === 'Package').click()`);
          await wait(5000);
          await shot('10-package-result');
          await js(`document.querySelector('.modal-foot .btn.primary') && document.querySelector('.modal-foot .btn.primary').click()`);
          await js(`document.querySelectorAll('.tab')[4].click()`);
          await js(`[...document.querySelectorAll('.btn')].find(b => b.textContent.includes('Find duplicates')).click()`);
          await wait(2000);
          await shot('11-duplicates-result');
          await js(`document.querySelector('.brand').click()`);
          await shot('12-welcome-with-history');
        }
      }
    } catch (err) {
      log.push(`[snapshot-error] ${err.stack}`);
    }
    fs.writeFileSync(path.join(outDir, 'console.log'), log.join('\n'));
    app.quit();
  });
});

require('../src/main/main.js');
