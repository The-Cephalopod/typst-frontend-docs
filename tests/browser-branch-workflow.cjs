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

const project = '/repos/fixture/publish';
const sourceBranch = 'working';
const branch = 'drafts/chapter';
const target = 'release/notes';
const title = 'Publish selected changes';
const description = 'Review the Typst document.\n\nKeep the notes local.';
const message = 'Update the chapter';
const head = 'loaded-revision';
const source = '= Original\n\nExisting document text.\n';
const inserted = 'New paragraph.\n\n';
const edited = inserted + source;
const baseEntry = { path: 'main.typ', type: 'blob', mode: '100644', size: Buffer.byteLength(source), sha: 'source-blob' };
const updatedEntry = { ...baseEntry, size: Buffer.byteLength(edited), sha: 'edited-blob' };
const pullUrl = 'https://github.com/fixture/publish/pull/31';

function mockGitHub() {
  const writes = [];
  const unexpected = [];
  let newHead;
  let pushes = 0;
  let commits = 0;
  let pulls = 0;
  let recoveries = 0;
  const blob = text => ({ content: Buffer.from(text).toString('base64') });
  const replies = new Map([
    ['/user', { id: 912, login: 'fixture' }],
    [project, { owner: { login: 'fixture' }, name: 'publish', full_name: 'fixture/publish', default_branch: 'main' }],
    [`${project}/git/commits/${head}`, { tree: { sha: 'loaded-tree' } }],
    [`${project}/git/commits/pushed-2`, { tree: { sha: 'pushed-tree' } }],
    [`${project}/git/trees/loaded-tree`, { tree: [baseEntry] }],
    [`${project}/git/trees/pushed-tree`, { tree: [updatedEntry] }],
    [`${project}/git/blobs/source-blob`, blob(source)],
    [`${project}/git/blobs/edited-blob`, blob(edited)],
  ]);
  const answer = async route => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const path = url.pathname;
    const reply = (json, status = 200) => route.fulfill({ status, json });
    if (method === 'GET') {
      if (replies.has(path)) return reply(replies.get(path));
      if (path === `${project}/branches`) return reply(['main', sourceBranch, target, ...(newHead ? [branch] : [])].map(name => ({ name })));
      if (path === `${project}/git/ref/heads/${sourceBranch}`) return reply({ object: { sha: head } });
      if (path === `${project}/git/ref/heads/${branch}`) return newHead ? reply({ object: { sha: newHead } }) : reply({ message: 'Branch not found' }, 404);
      if (path === `${project}/pulls`) {
        recoveries++;
        return reply([]);
      }
    } else {
      const body = request.postDataJSON();
      writes.push({ method, path, body, token: request.headers().authorization });
      if (method === 'POST' && path === `${project}/git/refs`) {
        newHead = body.sha;
        return reply({ ref: body.ref, object: { sha: newHead } }, 201);
      }
      if (method === 'POST' && path === `${project}/git/blobs`) return reply({ sha: 'edited-blob' }, 201);
      if (method === 'POST' && path === `${project}/git/trees`) return reply({ sha: 'pushed-tree' }, 201);
      if (method === 'POST' && path === `${project}/git/commits`) return reply({ sha: `pushed-${++commits}` }, 201);
      if (method === 'PATCH' && path === `${project}/git/refs/heads/${branch}`) {
        if (++pushes === 1) return reply({ message: 'Temporary branch update failure' }, 503);
        newHead = body.sha;
        return reply({ ref: `refs/heads/${branch}`, object: { sha: newHead } });
      }
      if (method === 'POST' && path === `${project}/pulls`) {
        if (++pulls === 1) return reply({ message: 'Temporary pull request failure' }, 503);
        return reply({ html_url: pullUrl }, 201);
      }
    }
    unexpected.push(`${method} ${path}`);
    return reply({ message: 'Unexpected fixture request' }, 404);
  };
  return { answer, writes, unexpected, recoveries: () => recoveries };
}

async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({
    ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}),
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}),
    headless: true,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    page.setDefaultTimeout(12000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => { errors.push(dialog.message()); return dialog.accept(); });
    page.on('console', event => { if (event.type() === 'error' && !event.text().includes('503')) console.error(event.text()); });
    await page.addInitScript(() => localStorage.setItem('typstgit.githubToken', 'fixture-token'));
    const provider = mockGitHub();
    await page.route('https://api.github.com/**', provider.answer);
    await page.goto(`http://127.0.0.1:${server.address().port}/#/repo/fixture/publish?branch=${sourceBranch}`);
    const previewReady = () => page.waitForFunction(() => document.querySelector('#compile-status').textContent.includes('Up to date'));
    await previewReady();
    await page.evaluate(text => {
      const [model] = monaco.editor.getModels();
      model.pushEditOperations(null, [{ range: new monaco.Range(1, 1, 1, 1), text }], () => null);
    }, inserted);
    await page.locator('#upload-file-input').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Private draft notes.\n') });
    await page.locator('#file-tree [data-path="notes.txt"]').waitFor();

    const dialog = page.getByRole('dialog', { name: 'Branch and pull request' });
    const action = dialog.locator('#branch-run-btn');
    const progress = dialog.locator('#branch-progress');
    const error = dialog.locator('#branch-error');
    const files = dialog.locator('#branch-files');
    const branchPosts = () => provider.writes.filter(entry => entry.path === `${project}/git/refs`);
    const commitPosts = () => provider.writes.filter(entry => entry.path === `${project}/git/commits`);
    const prPosts = () => provider.writes.filter(entry => entry.path === `${project}/pulls`);
    const dirtyFiles = () => page.locator('#file-tree .file-row:has(.tree-dirty)').evaluateAll(rows => rows.map(row => row.dataset.path));
    const openWorkflow = async () => {
      await page.getByRole('button', { name: 'Branch / PR' }).click();
      await dialog.waitFor();
    };
    await openWorkflow();
    assert.equal(await files.getByRole('checkbox', { name: /main\.typ/ }).isChecked(), true);
    await dialog.getByLabel('Branch name', { exact: true }).fill(branch);
    await dialog.getByLabel('Target branch', { exact: true }).fill(target);
    await dialog.getByLabel('Pull request title').fill(title);
    await dialog.getByLabel('Description', { exact: true }).fill(description);
    await dialog.getByLabel('Commit message').fill(message);
    await files.getByRole('checkbox', { name: /notes\.txt/ }).uncheck();
    await action.click();
    await error.waitFor();
    assert.equal(await error.textContent(), 'Temporary branch update failure');
    assert.equal(await page.getByRole('combobox', { name: 'Branch', exact: true }).inputValue(), branch);
    assert.match(await progress.textContent(), /Created branch drafts\/chapter/);
    assert.deepEqual(await dirtyFiles(), ['main.typ', 'notes.txt']);
    assert.deepEqual(branchPosts().map(({ body }) => body), [{ ref: `refs/heads/${branch}`, sha: head }]);
    assert.equal(prPosts().length, 0);
    console.log('PASS branch created at the loaded revision and both changes survived a failed push');

    // Reload between attempts to verify the working files and stage are durable.
    await page.reload();
    await previewReady();
    await openWorkflow();
    assert.match(await progress.textContent(), /Created branch drafts\/chapter/);
    assert.equal(await files.getByRole('checkbox', { name: /main\.typ/ }).isChecked(), true);
    assert.equal(await files.getByRole('checkbox', { name: /notes\.txt/ }).isChecked(), false);
    await action.click();
    await error.waitFor();
    assert.equal(await error.textContent(), 'Temporary pull request failure');
    assert.match(await progress.textContent(), /Pushed commit pushed-2/);
    assert.deepEqual(await dirtyFiles(), ['notes.txt']);
    assert.equal(branchPosts().length, 1);
    assert.deepEqual(commitPosts().map(({ body }) => body), [1, 2].map(() => ({ message, tree: 'pushed-tree', parents: [head] })));
    assert.deepEqual(provider.writes.filter(entry => entry.path === `${project}/git/trees`).map(({ body }) => body), [1, 2].map(() => ({
      base_tree: 'loaded-tree', tree: [{ path: 'main.typ', mode: '100644', type: 'blob', sha: 'edited-blob' }],
    })));
    assert.deepEqual(provider.writes.filter(entry => entry.path === `${project}/git/blobs`).map(({ body }) => body.content), [1, 2].map(() => Buffer.from(edited).toString('base64')));
    console.log('PASS reloaded retry pushed only the selected file and carried the unselected draft');

    await page.reload();
    await previewReady();
    await openWorkflow();
    assert.match(await progress.textContent(), /Pushed commit pushed-2/);
    await action.click();
    const link = progress.getByRole('link', { name: 'Open pull request' });
    await link.waitFor();
    assert.equal(await link.getAttribute('href'), pullUrl);
    assert.equal(branchPosts().length, 1);
    assert.equal(commitPosts().length, 2);
    assert.equal(provider.recoveries(), 1);
    assert.deepEqual(prPosts().map(({ body }) => body), [1, 2].map(() => ({ head: branch, base: target, title, body: description })));
    assert(provider.writes.every(({ token }) => token === 'Bearer fixture-token'));
    assert.deepEqual(await dirtyFiles(), ['notes.txt']);
    await dialog.locator('.modal-close').click();
    await page.getByRole('combobox', { name: 'Branch', exact: true }).selectOption(sourceBranch);
    await page.waitForURL(`**?branch=${sourceBranch}`);
    await page.waitForFunction(name => document.querySelector('#repo-sync-status').textContent.endsWith(name), sourceBranch);
    await previewReady();
    assert.deepEqual(await dirtyFiles(), []);
    assert.deepEqual(provider.unexpected, []);
    assert.deepEqual(errors, []);
    console.log('PASS pull request retry reused the pushed commit, showed the link, and left the original branch clean');
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => server.close());
