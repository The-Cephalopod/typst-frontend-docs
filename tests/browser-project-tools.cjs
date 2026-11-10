'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(process.env.TYPST_APP_DIR || path.join(__dirname, '..'));
const mirror = process.env.TYPST_CDN_HELPER ? require(process.env.TYPST_CDN_HELPER) : null;
const server = http.createServer((req, res) => {
  if (mirror?.staticAssets(req, res)) return;
  const name = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html';
  const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(name)];
  if (!type || !/^[\w.-]+$/.test(name) || !fs.existsSync(path.join(root, name))) {
    res.writeHead(404).end();
    return;
  }
  let body = fs.readFileSync(path.join(root, name), 'utf8');
  if (name === 'app.js') body = body.replace('  boot().catch(err => {', '  window.testApp = { state };\n  boot().catch(err => {');
  res.writeHead(200, { 'Content-Type': type }).end(mirror ? mirror.rewrite(body) : body);
});

const source = new Map(Object.entries({
  'main.typ': '= Root\n#include "sections/chapter.typ"\n#figure(rect(width: 12pt, height: 12pt), caption: [Box])\n#table(columns: 2, [Left], [Right])\n#heading(level: 2)[Program heading]\n',
  'sections/chapter.typ': '== Included chapter\n\nChapter needle.\n\n/*\n= Commented heading\n*/\n\n```typ\n= Raw heading\n```\n',
  'alternate.typ': '= Alternate entry\n',
  'notes.txt': '\uFEFFFirst needle\r\nSecond needle\n',
  'other.md': 'Intro\r\nneedle other\n',
  'binary.txt': 'needle\0ignored',
}));
for (let i = 0; i < 8; i++) source.set(`assets/${i}.txt`, 'Unrelated text');
const project = '/repos/fixture/tools';
const tree = [...source].map(([name, text], i) => ({
  path: name, type: 'blob', mode: '100644', size: Buffer.byteLength(text), sha: `blob-${i}`,
}));
const responses = new Map([
  [project, { owner: { login: 'fixture' }, name: 'tools', default_branch: 'main' }],
  [project + '/branches', [{ name: 'main' }]],
  [project + '/git/ref/heads/main', { object: { sha: 'head' } }],
  [project + '/git/commits/head', { tree: { sha: 'tree' } }],
  [project + '/git/trees/tree', { tree }],
  ...tree.map(({ path, sha }) => [project + '/git/blobs/' + sha, { content: Buffer.from(source.get(path)).toString('base64') }]),
]);

async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({
    ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}),
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}),
    headless: true,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
    page.setDefaultTimeout(12000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
    page.on('dialog', dialog => {
      if (dialog.type() === 'alert') errors.push(dialog.message());
      return dialog.accept();
    });
    let trackReads = false;
    let outstanding = 0;
    let peakReads = 0;
    await page.route('https://api.github.com/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      const json = responses.get(pathname);
      const tracked = trackReads && pathname.includes('/git/blobs/');
      if (tracked) {
        peakReads = Math.max(peakReads, ++outstanding);
        await new Promise(resolve => setTimeout(resolve, 35));
      }
      try { await route.fulfill({ status: json ? 200 : 404, json: json || { message: 'Unexpected request' } }); }
      finally { if (tracked) outstanding--; }
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/#/repo/fixture/tools?branch=main`);
    await page.waitForFunction(() => document.querySelector('#compile-status').textContent.includes('Up to date')).catch(async error => {
      console.error(await page.locator('#compile-status').textContent(), await page.locator('#diagnostic-list').textContent(), errors);
      throw error;
    });
    await page.getByRole('button', { name: 'Outline', exact: true }).click();
    const outline = page.locator('#project-outline-results');
    await outline.getByRole('button', { name: 'Included chapter', exact: true }).waitFor();
    assert.equal(await outline.locator(':scope > ul > li > ul').getByRole('button', { name: 'Included chapter', exact: true }).count(), 1);
    assert.match(await outline.textContent(), /FigureBox/);
    assert.match(await outline.textContent(), /TableLine 4/);
    assert.match(await outline.textContent(), /Program heading/);
    assert.doesNotMatch(await outline.textContent(), /Commented heading|Raw heading/);
    await outline.getByRole('button', { name: 'Included chapter', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => {
      const { editor, openPath } = testApp.state;
      return [openPath, editor.getModel().getValueInRange(editor.getSelection())];
    }), ['sections/chapter.typ', 'Included chapter']);
    await page.evaluate(() => {
      testApp.state.editor.executeEdits('test', [{ range: new monaco.Range(1, 4, 1, 20), text: 'Updated chapter' }]);
    });
    await outline.getByRole('button', { name: 'Updated chapter', exact: true }).waitFor();

    console.log('PASS outline includes nested source headings, figures and tables, jumps to included files, and updates for edits');

    await page.getByRole('button', { name: 'main.typ', exact: true }).click();
    await page.evaluate(() => {
      const { editor } = testApp.state;
      const model = editor.getModel();
      const end = model.getPositionAt(model.getValueLength());
      editor.executeEdits('test', [{ range: monaco.Range.fromPositions(end), text: '\nDraft Needle\n' }]);
    });
    await page.locator('[data-project-tool="search"]').click();
    const search = page.locator('#project-search-panel');
    const searchStatus = search.getByRole('status');
    const submit = search.getByRole('button', { name: 'Search', exact: true });
    await search.getByRole('searchbox', { name: 'Find in project' }).fill('needle');
    trackReads = true;
    await submit.click();
    await page.waitForFunction(() => document.querySelector('#project-search-status').textContent.startsWith('5 matches'));
    trackReads = false;
    assert.equal(peakReads, 4);
    assert(!(await page.evaluate(() => testApp.state.fileBytes.has('notes.txt'))), 'Search should not retain unopened repository bytes.');
    const other = search.getByRole('button', { name: /needle other/ });
    await other.click();
    await page.waitForFunction(() => testApp.state.openPath === 'other.md');
    assert.deepEqual(await page.evaluate(() => {
      const { editor } = testApp.state;
      return [editor.getPosition().lineNumber, editor.getModel().getValueInRange(editor.getSelection())];
    }), [2, 'needle']);
    await page.evaluate(() => {
      const { editor } = testApp.state;
      editor.executeEdits('test', [{ range: editor.getSelection(), text: 'changed' }]);
    });

    await search.getByRole('textbox', { name: 'Replace with' }).fill('token');
    await search.getByRole('button', { name: 'Preview', exact: true }).click();
    await search.getByRole('button', { name: 'Clear selection' }).click();
    await search.getByRole('checkbox', { name: 'Replace in notes.txt, line 2, column 8' }).check();
    await search.getByRole('checkbox', { name: 'Replace in other.md, line 2, column 1' }).check();
    await search.getByRole('button', { name: 'Apply selected (2)', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#project-search-status').textContent.includes('Skipped 1 outdated match.'));
    assert.match(await searchStatus.textContent(), /Replaced 1 match/);
    assert.deepEqual(await page.evaluate(() => [
      new TextDecoder('utf-8', { ignoreBOM: true }).decode(testApp.state.fileBytes.get('notes.txt')),
      testApp.state.editor.getValue().replaceAll('\r\n', '\n'),
    ]), ['\uFEFFFirst needle\r\nSecond token\n', 'Intro\nchanged other\n']);
    console.log('PASS project search includes drafts and unopened files, bounds provider reads, jumps to results, and replaces only selected current matches');

    await submit.click();
    await page.waitForFunction(() => document.querySelector('#project-search-status').textContent.startsWith('3 matches'));
    await search.getByRole('button', { name: /Draft Needle/ }).click();
    await page.waitForFunction(() => testApp.state.openPath === 'main.typ');
    await search.getByRole('button', { name: 'Preview', exact: true }).click();
    await search.getByRole('button', { name: 'Clear selection' }).click();
    await search.getByRole('checkbox', { name: /Replace in main\.typ/ }).check();
    await search.getByRole('button', { name: 'Apply selected (1)', exact: true }).click();
    await page.waitForFunction(() => testApp.state.editor.getValue().includes('Draft token'));
    assert(await page.evaluate(() => {
      const { editor } = testApp.state;
      editor.trigger('test', 'undo');
      return editor.getValue().includes('Draft Needle');
    }));
    console.log('PASS replacing matches in the active Monaco tab preserves undo');

    const selectEntry = async name => {
      await page.locator('#main-file-btn').click();
      await page.locator('#main-file-list').getByRole('button', { name: new RegExp(name) }).click();
    };
    await page.getByRole('button', { name: 'Outline', exact: true }).click();
    await selectEntry('alternate.typ');
    await outline.getByRole('button', { name: 'Alternate entry', exact: true }).waitFor();
    assert.equal(await outline.getByRole('button', { name: 'Updated chapter', exact: true }).count(), 0);
    await selectEntry('main.typ');
    await outline.getByRole('button', { name: 'Updated chapter', exact: true }).waitFor();
    await page.setViewportSize({ width: 490, height: 850 });
    await page.locator('#workspace-switcher').getByRole('button', { name: 'Files' }).click();
    await outline.getByRole('button', { name: 'Updated chapter', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#editor-workspace').dataset.pane === 'editor' &&
      testApp.state.openPath === 'sections/chapter.typ');
    assert.deepEqual(errors, []);
    console.log('PASS outline updates for preview entry point changes and source jumps reveal the editor on narrow screens');
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => server.close());
