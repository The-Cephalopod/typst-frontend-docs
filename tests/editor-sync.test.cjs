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
  const testUI = { closed: 0, toasts: [] };
  globalThis.appTest = {
    state, els, github, testUI, syncOpenFileFromEditor, flushEditorSync, resetProjectState, commitChanges, openDiagnosticLocation,
    route, createNewFile, renameSelectedFile, uploadFiles, handleEditorPreviewClick,
    mockOpenFile: fn => { openFile = fn; },
    mockTextPrompt: fn => { textPrompt = fn; },
  };
  updateChangeUI = () => {};
  updateFileTreeDirtyIndicator = () => {};
  renderFileTree = () => {};
  scheduleCompile = () => {};
  closeModal = () => { testUI.closed++; state.activeModal = null; };
  toast = message => testUI.toasts.push(message);
  showHome = () => {};
})();`);
  assert(source.includes('globalThis.appTest'), 'Test instrumentation must disable application boot.');
  const window = {};
  const context = vm.createContext({
    TextEncoder, TextDecoder, Uint8Array, Map, Set, WeakMap, URLSearchParams,
    setTimeout, clearTimeout, console, window, document: {}, location: { hash: '#/' },
  });
  vm.runInContext(source, context, { filename: appPath });
  const app = context.appTest;
  for (const name of ['preview-output', 'preview-error', 'diagnostic-list', 'preview-error-text', 'preview-loading',
    'commit-message-input', 'commit-error', 'confirm-commit-btn', 'file-count-label', 'editor-container', 'main-file-label']) {
    app.els[name] = { innerHTML: '', classList: { add: noop, remove: noop, contains: () => false } };
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

test('clicking after the final character reveals that source line in the preview', t => {
  const { app } = harness();
  const { state, els, handleEditorPreviewClick } = app;
  const MouseTargetType = { CONTENT_TEXT: 6, CONTENT_EMPTY: 7, OVERLAY_WIDGET: 10 };
  const sentence = 'A sentence.';
  const position = { lineNumber: 1, column: sentence.length + 1 };
  let reveals = 0;
  state.monaco = { editor: { MouseTargetType } };
  state.editor.getSelection = () => ({ isEmpty: () => true });
  state.editor.getModel = () => ({ getOffsetAt: ({ column }) => column - 1 });
  els['preview-output'].querySelectorAll = () => [];
  state.previewSourceAnchors = [{ path: 'main.typ', offset: 0, length: sentence.length, element: {
    isConnected: true, scrollIntoView: () => { reveals++; }, classList: { add: noop, remove: noop },
  } }];
  t.after(() => clearTimeout(state.previewHighlightTimer));

  handleEditorPreviewClick({ target: { type: MouseTargetType.CONTENT_EMPTY, position, detail: { isAfterLines: false } } });
  assert.equal(reveals, 1);

  handleEditorPreviewClick({ target: { type: MouseTargetType.CONTENT_EMPTY, position, detail: { isAfterLines: true } } });
  handleEditorPreviewClick({ target: { type: MouseTargetType.CONTENT_EMPTY, position: { lineNumber: 2, column: 1 }, detail: { isAfterLines: false } } });
  handleEditorPreviewClick({ target: { type: MouseTargetType.OVERLAY_WIDGET, position } });
  assert.equal(reveals, 1, 'Only clicks next to source text should move the preview.');
});

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

function commitHarness() {
  const h = harness();
  const { app } = h;
  const { state, els, github } = app;
  const calls = [];
  Object.assign(state, {
    repo: { owner: { login: 'fixture' }, name: 'project' }, branch: 'main',
    headSha: 'base-commit', baseTreeSha: 'base-tree', activeModal: 'commit-modal',
  });
  state.originalBytes.set('main.typ', new TextEncoder().encode('base document'));
  els['commit-message-input'].value = 'Update document';
  github.getRef = async (owner, repo, branch) => {
    calls.push(['ref', owner, repo, branch]);
    return { object: { sha: 'base-commit' } };
  };
  github.createBlob = async (owner, repo, bytes) => {
    calls.push(['blob', owner, repo, Buffer.from(bytes).toString()]);
    return { sha: 'pushed-blob' };
  };
  github.createTree = async (owner, repo, tree, entries) => {
    calls.push(['tree', owner, repo, tree, JSON.parse(JSON.stringify(entries))]);
    return { sha: 'pushed-tree' };
  };
  github.createCommit = async (...args) => {
    calls.push(['commit', ...args]);
    return { sha: 'pushed-commit' };
  };
  github.updateRef = async (...args) => { calls.push(['push', ...args]); };
  h.edit('submitted document');
  return { ...h, calls };
}

test('successful commits preserve edits made after the submitted snapshot', async () => {
  const { app, edit, calls } = commitHarness();
  const { state, github, testUI } = app;
  const patch = deferred();
  const originalUpdateRef = github.updateRef;
  github.updateRef = async (...args) => {
    await originalUpdateRef(...args);
    await patch.promise;
  };
  state.fileIndex.set('removed.typ', { path: 'removed.typ', existing: true });
  state.deletedPaths.add('removed.typ');
  state.changes.set('removed.typ', { type: 'delete' });
  const commit = app.commitChanges();
  await nextTurn();
  assert.deepEqual(calls, [
    ['ref', 'fixture', 'project', 'main'],
    ['blob', 'fixture', 'project', 'submitted document'],
    ['tree', 'fixture', 'project', 'base-tree', [
      { path: 'removed.typ', mode: '100644', type: 'blob', sha: null },
      { path: 'main.typ', mode: '100644', type: 'blob', sha: 'pushed-blob' },
    ]],
    ['commit', 'fixture', 'project', 'Update document', 'pushed-tree', 'base-commit'],
    ['push', 'fixture', 'project', 'main', 'pushed-commit'],
  ]);
  edit('newer local document');
  patch.resolve();
  await commit;
  assert.equal(state.headSha, 'pushed-commit');
  assert.equal(state.baseTreeSha, 'pushed-tree');
  assert.equal(state.fileIndex.get('main.typ').sha, 'pushed-blob');
  assert.equal(state.fileIndex.has('removed.typ'), false);
  assert.equal(state.changes.has('removed.typ'), false);
  assert.equal(state.editor.getValue(), 'newer local document');
  assert.equal(state.changes.get('main.typ').pending, true);
  assert.equal(Buffer.from(state.originalBytes.get('main.typ')).toString(), 'submitted document');
  await app.flushEditorSync();
  assert.equal(Buffer.from(state.changes.get('main.typ').bytes).toString(), 'newer local document');
  assert.equal(testUI.closed, 1);
  assert.match(testUI.toasts[0], /Committed 2 changes to main/);
});

test('a rejected push preserves the working copy, including when the branch moved', async () => {
  const { app, calls } = commitHarness();
  const { state, els, github } = app;
  const getRef = github.getRef;
  github.getRef = async () => ({ object: { sha: 'remote-commit' } });
  await app.commitChanges();
  assert.match(els['commit-error'].textContent, /branch changed on GitHub/);
  assert.deepEqual(calls, []);

  github.getRef = getRef;
  github.updateRef = async () => { throw new Error('Non-fast-forward update'); };
  await app.commitChanges();
  assert.match(els['commit-error'].textContent, /Non-fast-forward update/);
  assert.equal(state.headSha, 'base-commit');
  assert.equal(state.baseTreeSha, 'base-tree');
  assert.equal(state.activeModal, 'commit-modal');
  assert.equal(Buffer.from(state.changes.get('main.typ').bytes).toString(), 'submitted document');
  assert.equal(els['confirm-commit-btn'].disabled, false);
});

test('a delayed GitHub response cannot push to or update a newly opened branch', async () => {
  const { app, calls } = commitHarness();
  const { state, github, testUI } = app;
  const blob = deferred();
  const createBlob = github.createBlob;
  github.createBlob = async (...args) => { await createBlob(...args); return blob.promise; };
  const commit = app.commitChanges();
  await nextTurn();
  assert.deepEqual(calls.map(([name]) => name), ['ref', 'blob']);
  state.repositoryLoadSerial++;
  app.resetProjectState();
  state.branch = 'other';
  state.headSha = 'other-commit';
  state.activeModal = 'auth-modal';
  blob.resolve({ sha: 'old-blob' });
  await commit;
  assert.deepEqual(calls.map(([name]) => name), ['ref', 'blob']);
  assert.equal(state.headSha, 'other-commit');
  assert.equal(state.activeModal, 'auth-modal');
  assert.equal(testUI.toasts.length, 0);
});

test('clicking a diagnostic in the open file selects its range without resetting the editor', async () => {
  const { app } = harness();
  const calls = [];
  app.mockOpenFile(() => assert.fail('Reopening the current file would reset its undo history.'));
  app.state.monaco = { editor: { ScrollType: { Smooth: 0 } } };
  Object.assign(app.state.editor, {
    getModel: () => ({ getLineCount: () => 10, getLineMaxColumn: () => 40 }),
    setSelection: range => calls.push(JSON.parse(JSON.stringify(range))),
    revealRangeInCenter: () => calls.push('reveal'),
    focus: () => calls.push('focus'),
  });
  await app.openDiagnosticLocation({
    path: 'main.typ',
    range: { startLine: 5, startColumn: 12, endLine: 6, endColumn: 4 },
  });
  assert.deepEqual(calls, [
    { startLineNumber: 6, startColumn: 12, endLineNumber: 7, endColumn: 4 }, 'reveal', 'focus',
  ]);
});

test('a diagnostic awaiting a file open does not reveal its range in a different project', async () => {
  const { app } = harness();
  const open = deferred();
  app.state.fileIndex.set('included.typ', { path: 'included.typ', existing: true });
  app.mockOpenFile(() => open.promise);
  app.state.editor.setSelection = () => assert.fail('Selection belongs to the previous project.');
  const jump = app.openDiagnosticLocation({
    path: 'included.typ', range: { startLine: 5, startColumn: 12, endLine: 5, endColumn: 13 },
  });
  app.state.repositoryLoadSerial++;
  app.resetProjectState();
  app.state.openPath = 'included.typ';
  open.resolve();
  await jump;
});

test('navigation closes file prompts and ignores a stale create or rename confirmation', async () => {
  for (const action of ['createNewFile', 'renameSelectedFile']) {
    const { app } = harness();
    const prompt = deferred();
    app.mockTextPrompt(() => {
      app.state.activeModal = 'text-prompt-modal';
      return prompt.promise;
    });
    const operation = app[action]();
    await nextTurn();
    assert.equal(app.state.activeModal, 'text-prompt-modal');
    app.route();
    assert.equal(app.testUI.closed, 1);
    prompt.resolve('later.typ');
    await operation;
    assert.equal(app.state.changes.size, 0);
    assert.deepEqual([...app.state.fileIndex.keys()], ['main.typ']);
  }
});

test('a delayed upload cannot add a file to a newly opened project', async () => {
  const { app } = harness();
  const read = deferred();
  const upload = app.uploadFiles({ target: { files: [{ name: 'late.typ', arrayBuffer: () => read.promise }] } });
  app.state.repositoryLoadSerial++;
  app.resetProjectState();
  read.resolve(new TextEncoder().encode('old project upload').buffer);
  await upload;
  assert.equal(app.state.changes.size, 0);
  assert.equal(app.state.fileIndex.size, 0);
});

test('a rename stops writing to the worker when the project changes during unmap', async () => {
  const { app, window } = harness();
  const unmap = deferred();
  const paths = [];
  app.state.fileBytes.set('main.typ', new TextEncoder().encode('main'));
  app.mockTextPrompt(async () => 'renamed.typ');
  window.$typst = {
    unmapShadow: path => { paths.push(path); return unmap.promise; },
    mapShadow: path => paths.push(path),
  };
  const rename = app.renameSelectedFile();
  await nextTurn();
  assert.deepEqual(paths, ['/repo/main.typ']);
  app.state.repositoryLoadSerial++;
  app.resetProjectState();
  unmap.resolve();
  await rename;
  assert.deepEqual(paths, ['/repo/main.typ']);
  assert.equal(app.state.fileIndex.size, 0);
});

test('recreating or renaming onto a tracked deletion retains its original blob for committing', async () => {
  for (const action of ['createNewFile', 'renameSelectedFile']) {
    const { app } = harness();
    const path = 'restored.typ';
    app.state.fileIndex.set(path, { path, existing: true, sha: 'original-destination', mode: '100644' });
    app.state.fileBytes.set('main.typ', new TextEncoder().encode('rename source'));
    app.state.deletedPaths.add(path);
    app.state.changes.set(path, { type: 'delete' });
    app.mockTextPrompt(async () => path);
    app.mockOpenFile(async opened => { app.state.openPath = opened; });
    await app[action]();
    assert.equal(app.state.fileIndex.get(path).sha, 'original-destination');
    assert.equal(app.state.fileIndex.get(path).existing, true);
    assert.equal(app.state.fileIndex.get(path).renameFrom, undefined);
    assert.equal(app.state.changes.get(path).type, 'modify');
    assert.equal(app.state.deletedPaths.has(path), false);
    assert.equal(app.state.openPath, path);
  }
});

test('renaming a tracked file repeatedly retains the first source for a mode-preserving commit', async () => {
  const { app } = harness();
  const { state } = app;
  state.fileIndex.get('main.typ').mode = '100755';
  state.fileBytes.set('main.typ', new TextEncoder().encode('rename source'));
  app.mockOpenFile(async path => { state.openPath = path; });
  for (const path of ['intermediate.typ', 'moved.typ']) {
    app.mockTextPrompt(async () => path);
    await app.renameSelectedFile();
    assert.equal(state.fileIndex.get(path).renameFrom, 'main.typ');
    assert.equal(state.fileIndex.get(path).mode, '100755');
  }
  assert.equal(state.changes.get('main.typ').type, 'delete');
  assert.equal(state.changes.has('intermediate.typ'), false);
  assert.equal(state.changes.get('moved.typ').type, 'add');
});
