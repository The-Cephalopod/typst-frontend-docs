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
  const body = fs.readFileSync(path.join(root, name), 'utf8');
  res.writeHead(200, { 'Content-Type': type }).end(mirror ? mirror.rewrite(body) : body);
});

async function fontFixture() {
  if (process.env.TYPST_REPO_FONT) return fs.readFileSync(process.env.TYPST_REPO_FONT);
  const response = await fetch('https://cdn.jsdelivr.net/gh/typst/typst-dev-assets@v0.15.0/files/fonts/Roboto-Regular.ttf');
  if (!response.ok) throw new Error(`Could not download the Roboto fixture (${response.status}).`);
  return Buffer.from(await response.arrayBuffer());
}

async function main() {
  const font = await fontFixture();
  const source = Buffer.from('#set text(font: "Roboto")\nRepo font sample\n\n#set text(font: "Libertinus Serif")\nDefault font sample');
  const sourceFile = { path: 'main.typ', type: 'blob', mode: '100644', size: source.length, sha: 'source' };
  const fontFile = { path: 'Roboto.ttf', type: 'blob', mode: '100644', size: font.length, sha: 'font' };
  const responses = new Map([
    ['/repos/fixture/fonts', { owner: { login: 'fixture' }, name: 'fonts', full_name: 'fixture/fonts', default_branch: 'main' }],
    ['/repos/fixture/fonts/branches', [{ name: 'main' }, { name: 'plain' }]],
    ['/repos/fixture/fonts/git/ref/heads/main', { object: { sha: 'font-head' } }],
    ['/repos/fixture/fonts/git/ref/heads/plain', { object: { sha: 'plain-head' } }],
    ['/repos/fixture/fonts/git/commits/font-head', { tree: { sha: 'font-tree' } }],
    ['/repos/fixture/fonts/git/commits/plain-head', { tree: { sha: 'plain-tree' } }],
    ['/repos/fixture/fonts/git/trees/font-tree', { tree: [sourceFile, fontFile] }],
    ['/repos/fixture/fonts/git/trees/plain-tree', { tree: [sourceFile] }],
    ['/repos/fixture/fonts/git/blobs/source', { content: source.toString('base64') }],
    ['/repos/fixture/fonts/git/blobs/font', { content: font.toString('base64') }],
  ]);

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({
    ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}),
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}),
    headless: true,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
    page.on('dialog', dialog => dialog.accept());
    await page.route('https://api.github.com/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      const json = responses.get(pathname);
      await route.fulfill({ status: json ? 200 : 404, json: json || { message: `Unexpected request: ${pathname}` } });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/#/repo/fixture/fonts?branch=main`);

    async function previewText() {
      const text = page.locator('#preview-output .typst-text').filter({ hasText: 'Repo font sample' });
      await text.waitFor({ state: 'visible' });
      return text.evaluate(node => node.getBBox().width);
    }
    const customWidth = await previewText().catch(async error => {
      console.error(await page.locator('#compile-status').textContent(), await page.locator('#diagnostic-list').textContent(), pageErrors);
      throw error;
    });
    await page.waitForFunction(() => document.querySelector('#compile-status').textContent.includes('Up to date'));
    assert.match(await page.locator('#preview-output').textContent(), /Default font sample/);
    const pdfDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export PDF' }).click();
    const pdf = fs.readFileSync(await (await pdfDownload).path());
    assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
    assert.match(pdf.toString('latin1'), /\/BaseFont\s*\/[^\s/]*Roboto/i);
    console.log('PASS repository font changes live glyph metrics and embeds in PDF alongside Typst defaults');

    await page.locator('#upload-file-input').setInputFiles({
      name: 'Roboto.ttf', mimeType: 'font/ttf', buffer: Buffer.from('invalid font'),
    });
    const diagnosticTitles = page.locator('#diagnostic-list strong');
    await diagnosticTitles.filter({ hasText: 'Could not load repository font' }).waitFor();
    assert.match(await page.locator('#diagnostic-list').textContent(), /Roboto\.ttf/);
    assert.notEqual(await previewText(), customWidth);

    await page.locator('#upload-file-input').setInputFiles({ name: 'Roboto.ttf', mimeType: 'font/ttf', buffer: font });
    await page.waitForFunction(() => document.querySelector('#compile-status').textContent.includes('Up to date'));
    assert.equal(await previewText(), customWidth);
    console.log('PASS replacing a damaged font clears its warning and restores preview');

    await page.getByRole('combobox', { name: 'Branch' }).selectOption('plain');
    await page.waitForFunction(() => location.hash.endsWith('branch=plain') && document.querySelector('#repo-sync-status').textContent.includes('plain'));
    assert.notEqual(await previewText(), customWidth);
    await page.getByRole('combobox', { name: 'Branch' }).selectOption('main');
    await page.waitForFunction(() => location.hash.endsWith('branch=main') && document.querySelector('#repo-sync-status').textContent.includes('main'));
    assert.equal(await previewText(), customWidth);
    assert.deepEqual(pageErrors, []);
    console.log('PASS switching branches clears and restores repository fonts');
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => server.close());
