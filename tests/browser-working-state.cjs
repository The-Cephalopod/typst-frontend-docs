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
  if (name === 'app.js') body = body.replace('  boot().catch(err => {', '  window.testApp = { state, openFile, persistDraft };\n  boot().catch(err => {');
  res.writeHead(200, { 'Content-Type': type }).end(mirror ? mirror.rewrite(body) : body);
});

const baseText = '= Draft fixture\n\nOriginal first paragraph.\n\nOriginal last paragraph.\n';
const localText = baseText.replace('Original first', 'Local first');
const remoteText = baseText.replace('Original last', 'Remote last');
const mergedText = localText.replace('Original last', 'Remote last');
const binary = Buffer.from([0, 12, 255, 200]);
const prefix = '/repos/fixture/work';
const trees = new Map();
const blobs = new Map();
const patches = [];
let blobId = 0;
let head = 'initial';
let rejectPush = false;
let editDuringPush = null;
let account = { login: 'writer', id: 10 };

function blob(bytes) {
  const sha = 'blob-' + ++blobId;
  blobs.set(sha, Buffer.from(bytes));
  return sha;
}
function addRevision(name, files) {
  trees.set(name, Object.entries(files).map(([path, bytes]) => ({
    path, type: 'blob', mode: '100644', size: Buffer.byteLength(bytes), sha: blob(bytes),
  })));
}
function changeRevision(next, from, changed) {
  const tree = new Map(trees.get(from).map(file => [file.path, file]));
  for (const [path, value] of Object.entries(changed)) {
    if (value === null) tree.delete(path);
    else tree.set(path, { path, type: 'blob', mode: '100644', size: Buffer.byteLength(value), sha: blob(value) });
  }
  trees.set(next, [...tree.values()]);
}
addRevision('initial', {
  'main.typ': baseText, 'move.txt': 'Rename contents', 'remove.txt': 'Delete contents',
  'untouched.txt': 'Before remote update', 'remote-delete.txt': 'Keep me', 'remote-rename.txt': 'Original name',
});
changeRevision('remote', 'initial', { 'main.typ': remoteText, 'untouched.txt': 'Fetched remote update' });
trees.get('remote').find(file => file.path === 'main.typ').mode = '100755';

async function handleGitHub(route) {
  const req = route.request();
  const name = new URL(req.url()).pathname;
  const sub = name.slice(prefix.length);
  const data = req.postDataJSON();
  let result;
  if (name === '/user') result = account;
  else if (name === prefix) result = { owner: { login: 'fixture' }, name: 'work', default_branch: 'main' };
  else if (sub === '/branches') result = [{ name: 'main' }];
  else if (sub === '/git/ref/heads/main') result = { object: { sha: head } };
  else if (sub.startsWith('/git/commits/')) result = { tree: { sha: sub.split('/').at(-1) } };
  else if (sub.startsWith('/git/trees/')) result = { tree: trees.get(sub.split('/').at(-1)) };
  else if (sub.startsWith('/git/blobs/')) result = { content: blobs.get(sub.split('/').at(-1))?.toString('base64') };
  else if (sub === '/git/blobs') result = { sha: blob(Buffer.from(data.content, 'base64')) };
  else if (sub === '/git/trees') {
    const next = 'pushed-' + patches.length;
    const tree = new Map(trees.get(data.base_tree).map(file => [file.path, file]));
    for (const entry of data.tree) {
      if (entry.sha === null) tree.delete(entry.path);
      else tree.set(entry.path, { ...entry, size: blobs.get(entry.sha).length });
    }
    trees.set(next, [...tree.values()]);
    patches.push(data.tree);
    result = { sha: next };
  } else if (sub === '/git/commits') result = { sha: data.tree };
  else if (sub === '/git/refs/heads/main' && req.method() === 'PATCH') {
    if (rejectPush) return route.fulfill({ status: 422, json: { message: 'Controlled push failure' } });
    if (editDuringPush) await editDuringPush();
    head = data.sha;
    result = { object: { sha: head } };
  }
  await route.fulfill({ status: result ? 200 : 404, json: result || { message: 'Unexpected API request' } });
}

async function open(page, name) {
  await page.evaluate(file => testApp.openFile(file), name);
}
async function edit(page, value) {
  await page.evaluate(text => {
    const { editor } = testApp.state;
    editor.executeEdits('test', [{ range: editor.getModel().getFullModelRange(), text }]);
  }, value);
}
async function save(page) {
  assert(await page.evaluate(() => testApp.persistDraft()));
  await page.getByText(/^Draft saved /).waitFor();
}
async function ready(page, sha) {
  await page.waitForFunction(expected => testApp.state.headSha === expected && testApp.state.openPath === 'main.typ', sha);
}

async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({
    ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}),
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}),
    headless: true,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
    page.on('dialog', dialog => dialog.accept());
    await page.addInitScript(() => localStorage.setItem('typstgit.githubToken', 'fixture-token'));
    await page.route('https://api.github.com/**', handleGitHub);
    await page.goto(`http://127.0.0.1:${server.address().port}/#/repo/fixture/work?branch=main`);
    await ready(page, 'initial');

    await edit(page, localText);
    await page.locator('#upload-file-input').setInputFiles({ name: 'asset.png', mimeType: 'image/png', buffer: binary });
    await page.waitForFunction(() => testApp.state.changes.has('asset.png'));
    await open(page, 'move.txt');
    await page.locator('#rename-file-btn').click();
    await page.locator('#text-prompt-input').fill('moved.txt');
    await page.locator('#text-prompt-confirm').click();
    await page.waitForFunction(() => testApp.state.openPath === 'moved.txt');
    await open(page, 'remove.txt');
    assert.equal(await page.evaluate(() => testApp.state.openPath), 'remove.txt');
    await page.locator('#delete-file-btn').click();
    await page.waitForFunction(() => testApp.state.deletedPaths.has('remove.txt'));
    await page.waitForFunction(() => testApp.state.draft.savedAt && !testApp.state.draft.timer && !testApp.state.draft.paths.size);
    await page.getByText(/^Draft saved /).waitFor();
    await page.reload();
    await ready(page, 'initial');
    assert.deepEqual(await page.evaluate(() => ({
      text: testApp.state.editor.getValue(),
      bytes: Array.from(testApp.state.fileBytes.get('asset.png')),
      move: testApp.state.changes.get('moved.txt').renameFrom,
      deleted: [...testApp.state.deletedPaths].sort(),
    })), { text: localText, bytes: [...binary], move: 'move.txt', deleted: ['move.txt', 'remove.txt'] });
    console.log('PASS IndexedDB restores text, add, binary, rename and delete after reload');

    account = { login: 'another', id: 11 };
    await page.reload();
    await ready(page, 'initial');
    assert.equal(await page.evaluate(() => testApp.state.changes.size), 0);
    account = { login: 'writer', id: 10 };
    head = 'remote';
    await page.reload();
    await ready(page, 'remote');
    assert.equal(await page.evaluate(() => testApp.state.editor.getValue()), mergedText);
    await open(page, 'untouched.txt');
    assert.equal(await page.evaluate(() => testApp.state.editor.getValue()), 'Fetched remote update');
    console.log('PASS drafts are account-scoped and stale recovery merges non-overlapping edits');

    await open(page, 'main.typ');
    await page.locator('#commit-btn').click();
    const modal = page.locator('#commit-modal');
    const mainRow = modal.locator('.commit-file').filter({ hasText: 'main.typ' });
    await mainRow.getByText('View diff').click();
    await mainRow.getByText('- Original first paragraph.').waitFor();
    await mainRow.getByText('+ Local first paragraph.').waitFor();
    const rename = modal.getByRole('checkbox', { name: /move.txt → moved.txt/ });
    assert.equal(await rename.count(), 1);
    await modal.getByRole('checkbox', { name: /asset.png/ }).uncheck();
    await modal.getByRole('checkbox', { name: /remove.txt/ }).uncheck();
    rejectPush = true;
    await page.locator('#confirm-commit-btn').click();
    await page.getByText('Controlled push failure').waitFor();
    assert.equal(await page.evaluate(() => testApp.state.changes.size), 5);
    rejectPush = false;
    editDuringPush = async () => {
      await page.evaluate(async text => {
        const { state, persistDraft } = testApp;
        state.editor.executeEdits('test', [{ range: state.editor.getModel().getFullModelRange(), text }]);
        const save = persistDraft();
        // Keep the next worker write deferred until the commit has accepted
        // its snapshot, as can happen while a long compile is in flight.
        clearTimeout(state.compileTimer);
        clearTimeout(state.editorSyncTimer);
        state.compileTimer = null;
        state.editorSyncTimer = null;
        if (!await save || !state.editorSyncPending) throw new Error('Expected a saved, pending editor edit during the push');
      }, mergedText + '\nA later edit.\n');
      editDuringPush = null;
    };
    await page.locator('#confirm-commit-btn').click();
    await modal.waitFor({ state: 'hidden' });
    assert.deepEqual(patches.at(-1).map(item => item.path).sort(), ['main.typ', 'move.txt', 'moved.txt']);
    assert.equal(patches.at(-1).find(item => item.path === 'main.typ').mode, '100755');
    assert.deepEqual(await page.evaluate(() => [...testApp.state.changes.keys()].sort()), ['asset.png', 'main.typ', 'remove.txt']);
    await save(page);
    await page.reload();
    await ready(page, head);
    assert.match(await page.evaluate(() => testApp.state.editor.getValue()), /A later edit/);
    console.log('PASS commit diff, atomic rename selection, failed push, and edits retained after partial commit');

    const localConflict = mergedText.replace('Local first', 'Local overlap') + '\nA later edit.\n';
    await edit(page, localConflict);
    await open(page, 'remote-delete.txt');
    await edit(page, 'Keep local edits after a remote deletion');
    await open(page, 'remote-rename.txt');
    await edit(page, 'Retain source content under the original name');
    await save(page);
    changeRevision('conflicted', head, {
      'main.typ': mergedText.replace('Local first', 'Remote overlap'),
      'asset.png': Buffer.from([5, 0, 4]),
      'remote-delete.txt': null,
    });
    const advanced = trees.get('conflicted');
    const remoteMoved = advanced.find(item => item.path === 'remote-rename.txt');
    remoteMoved.path = 'new-remote-name.txt';
    head = 'conflicted';
    await page.locator('#refresh-repo-btn').click();
    const sync = page.locator('#sync-modal');
    await sync.waitFor();
    assert(await page.locator('#commit-btn').isDisabled());
    assert.match(await sync.textContent(), /Binary conflict/);
    assert.match(await sync.textContent(), /Delete conflict/);
    assert.match(await sync.textContent(), /Remote moved to new-remote-name.txt/);
    await sync.getByRole('combobox', { name: 'Resolve main.typ' }).selectOption('manual');
    await sync.getByRole('textbox', { name: 'Merged text for main.typ' }).fill(mergedText.replace('Local first', 'Resolved first'));
    await sync.getByRole('combobox', { name: 'Resolve asset.png' }).selectOption('remote');
    await sync.getByRole('combobox', { name: 'Resolve remote-delete.txt' }).selectOption('local');
    await sync.getByRole('combobox', { name: 'Resolve remote-rename.txt' }).selectOption('local');
    await page.locator('#apply-sync-btn').click();
    await sync.waitFor({ state: 'hidden' });
    assert.deepEqual(await page.evaluate(() => [...testApp.state.changes].map(([p, c]) => [p, c.type]).sort()), [
      ['main.typ', 'modify'], ['new-remote-name.txt', 'delete'], ['remote-delete.txt', 'add'],
      ['remote-rename.txt', 'add'], ['remove.txt', 'delete'],
    ]);
    await open(page, 'main.typ');
    assert.match(await page.evaluate(() => testApp.state.editor.getValue()), /Resolved first paragraph/);
    await page.locator('#discard-draft-btn').click();
    await page.getByText('Discarded the local draft.').waitFor();
    await page.reload();
    await ready(page, 'conflicted');
    assert.equal(await page.evaluate(() => testApp.state.changes.size), 0);
    assert.match(await page.evaluate(() => testApp.state.editor.getValue()), /Remote overlap/);
    console.log('PASS text, binary, rename and delete conflict resolution, plus persistent discard');

    await page.waitForFunction(() => document.querySelector('#compile-status').textContent.includes('Up to date'));
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 8;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#237a4a';
      ctx.fillRect(0, 0, 8, 8);
      const png = await new Promise(resolve => canvas.toBlob(resolve));
      const clipboardData = new DataTransfer();
      clipboardData.items.add(new File([png], 'fixture.png', { type: 'image/png' }));
      const { editor } = testApp.state;
      const model = editor.getModel();
      editor.setPosition(model.getPositionAt(model.getValueLength()));
      editor.getDomNode().dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
    });
    await page.locator('#image-paste-filename').fill('fixture.png');
    await page.locator('#image-paste-confirm').click();
    await page.waitForFunction(() => testApp.state.editor.getValue().includes('#image("assets/fixture.png")'));
    assert(await page.evaluate(() => testApp.state.changes.has('assets/fixture.png')));
    await page.locator('#preview-output image').first().waitFor();
    assert.deepEqual(errors, []);
    console.log('PASS image paste adds a working asset and renders it in the worker preview');
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch(error => {
  console.error(error);
  server.close();
  process.exitCode = 1;
});
