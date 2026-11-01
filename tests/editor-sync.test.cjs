'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const appPath = path.resolve(__dirname, '../app.js');
const noop = () => {};
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness() {
  let source = fs.readFileSync(appPath, 'utf8');
  source = source.replace(/  boot\(\)\.catch\(err => \{[\s\S]*?\n  \}\);\n\}\)\(\);\s*$/, `
  globalThis.appTest = { state, els, syncOpenFileFromEditor, flushEditorSync, resetProjectState };
  updateChangeUI = () => {};
  updateFileTreeDirtyIndicator = () => {};
})();`);
  assert(source.includes('globalThis.appTest'), 'Test instrumentation must disable application boot.');
  const window = {};
  const context = vm.createContext({
    TextEncoder, TextDecoder, Uint8Array, Map, Set, WeakMap, URLSearchParams,
    setTimeout, clearTimeout, console, window, document: {},
  });
  vm.runInContext(source, context, { filename: appPath });
  const app = context.appTest;
  for (const name of ['preview-output', 'preview-error', 'diagnostic-list', 'preview-error-text', 'preview-loading']) {
    app.els[name] = { innerHTML: '', classList: { add: noop, remove: noop } };
  }
  let currentText = '';
  app.state.editor = { getValue: () => currentText };
  app.state.openPath = 'main.typ';
  app.state.fileIndex.set('main.typ', { path: 'main.typ', existing: true });
  const edit = text => {
    currentText = text;
    app.state.editorSyncPending = true;
    app.state.editorSyncPath = app.state.openPath;
  };
  return { app, window, edit };
}

test('overlapping sync calls map edits in order and retain the latest promise', async () => {
  const { app, window, edit } = harness();
  const first = deferred(), second = deferred();
  const mapped = [];
  let active = 0, maximumActive = 0;
  window.$typst = { mapShadow: async (_path, bytes) => {
    active++;
    maximumActive = Math.max(maximumActive, active);
    mapped.push(Buffer.from(bytes).toString());
    await (mapped.length === 1 ? first.promise : second.promise);
    active--;
    return true;
  } };
  edit('first');
  const firstSync = app.syncOpenFileFromEditor();
  await nextTurn();
  edit('latest');
  const latestSync = app.syncOpenFileFromEditor();
  const latestPromise = app.state.shadowSyncPromise;
  await nextTurn();
  assert.deepEqual(mapped, ['first']);
  first.resolve();
  await firstSync;
  await nextTurn();
  assert.equal(app.state.shadowSyncPromise, latestPromise, 'Old completion must not clear a newer sync lock.');
  assert.deepEqual(mapped, ['first', 'latest']);
  let flushed = false;
  const flush = app.flushEditorSync().then(() => { flushed = true; });
  await nextTurn();
  assert.equal(flushed, false, 'Compile/export flush must wait for the newest mapping.');
  second.resolve();
  await Promise.all([latestSync, flush]);
  assert.equal(maximumActive, 1);
  assert.equal(app.state.shadowSyncPromise, null);
});

test('flush drains edits arriving during slow mapping without a three-pass limit', async () => {
  const { app, window, edit } = harness();
  const mapped = [];
  window.$typst = { mapShadow: async (_path, bytes) => {
    mapped.push(Buffer.from(bytes).toString());
    if (mapped.length < 5) edit(`edit ${mapped.length + 1}`);
    await nextTurn();
    return true;
  } };
  edit('edit 1');
  await app.flushEditorSync();
  assert.deepEqual(mapped, ['edit 1', 'edit 2', 'edit 3', 'edit 4', 'edit 5']);
  assert.equal(app.state.editorSyncPending, false);
  assert.equal(app.state.sourceTextCache.get('main.typ'), 'edit 5');
  assert.equal(Buffer.from(app.state.changes.get('main.typ').bytes).toString(), 'edit 5');
});

test('project reset retains the write tail and cancels queued old edits', async () => {
  const { app, window, edit } = harness();
  const oldMap = deferred(), newMap = deferred();
  const mapped = [];
  window.$typst = { mapShadow: async (_path, bytes) => {
    const text = Buffer.from(bytes).toString();
    mapped.push(text);
    await (text === 'old active' ? oldMap.promise : newMap.promise);
    return true;
  } };
  edit('old active');
  const activeSync = app.syncOpenFileFromEditor();
  const activeCancelled = assert.rejects(activeSync, error => error.name === 'AbortError');
  await nextTurn();
  edit('old queued');
  const queuedSync = app.syncOpenFileFromEditor();
  const queuedCancelled = assert.rejects(queuedSync, error => error.name === 'AbortError');
  const persistentTail = app.state.shadowSyncTail;
  app.state.repositoryLoadSerial++;
  app.resetProjectState();
  assert.equal(app.state.shadowSyncTail, persistentTail, 'Reset must not discard in-flight write ordering.');
  app.state.openPath = 'main.typ';
  app.state.fileIndex.set('main.typ', { path: 'main.typ', existing: true });
  edit('new current');
  const currentSync = app.syncOpenFileFromEditor();
  const currentPromise = app.state.shadowSyncPromise;
  await nextTurn();
  assert.deepEqual(mapped, ['old active']);
  oldMap.resolve();
  await Promise.all([activeCancelled, queuedCancelled]);
  await nextTurn();
  assert.deepEqual(mapped, ['old active', 'new current'], 'Old queued bytes must never map into the new project.');
  assert.equal(app.state.shadowSyncPromise, currentPromise);
  assert.equal(app.state.sourceTextCache.get('main.typ'), 'new current');
  assert.equal(app.state.editorSyncPending, false);
  newMap.resolve();
  await currentSync;
});

test('failed latest writes stay pending and a later flush retries them', async () => {
  const { app, window, edit } = harness();
  let calls = 0;
  window.$typst = { mapShadow: async () => {
    if (++calls === 1) throw new Error('Controlled transient failure');
    return true;
  } };
  edit('retry me');
  await assert.rejects(app.syncOpenFileFromEditor(), /Controlled transient failure/);
  assert.equal(app.state.shadowSyncPromise, null);
  assert.equal(app.state.editorSyncPending, true);
  await app.flushEditorSync();
  assert.equal(calls, 2);
  assert.equal(app.state.editorSyncPending, false);
});

test('false map results are errors and retain the pending edit', async () => {
  const { app, window, edit } = harness();
  window.$typst = { mapShadow: async () => false };
  edit('preserve me');
  await assert.rejects(app.flushEditorSync(), /could not update/);
  assert.equal(app.state.editorSyncPending, true);
  assert.equal(Buffer.from(app.state.changes.get('main.typ').bytes).toString(), 'preserve me');
});

test('sync before runtime startup keeps working bytes for later hydration', async () => {
  const { app, edit } = harness();
  edit('before runtime');
  await app.flushEditorSync();
  assert.equal(app.state.editorSyncPending, false);
  assert.equal(app.state.shadowSyncPromise, null);
  assert.equal(app.state.sourceTextCache.get('main.typ'), 'before runtime');
  assert.equal(Buffer.from(app.state.fileBytes.get('main.typ')).toString(), 'before runtime');
});

test('a mismatched editor path aborts rather than reading a different file or looping', async () => {
  const { app, edit } = harness();
  edit('old model');
  app.state.openPath = 'other.typ';
  await assert.rejects(app.flushEditorSync(), error => error.name === 'AbortError');
  assert.equal(app.state.fileBytes.size, 0);
});
