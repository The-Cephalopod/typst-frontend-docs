'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const appPath = path.resolve(__dirname, '../app.js');
const noop = () => {};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const ticks = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };

function harness() {
  let now = 0, timerSerial = 0;
  const timers = new Map(), workers = [], statuses = [], diagnostics = [];
  const setTimer = (fn, delay = 0) => { const id = ++timerSerial; timers.set(id, { fn, due: now + delay }); return id; };
  const clearTimer = id => timers.delete(id);
  class ClockDate extends Date { static now() { return now; } }
  class WorkerDouble {
    constructor(url, options) { this.url = url; this.options = options; this.posts = []; workers.push(this); }
    postMessage(...args) {
      if (this.throwNextPost) { this.throwNextPost = false; throw new Error('Controlled post failure'); }
      this.posts.push(args);
    }
    terminate() { this.terminated = true; }
    respond(method, result, error) {
      const post = this.posts.find(args => args[0].method === method && !args.responded);
      assert(post, `Expected pending worker request: ${method}`);
      post.responded = true;
      this.onmessage({ data: { id: post[0].id, result, error } });
    }
  }
  const element = () => {
    const classes = new Set();
    return {
      innerHTML: '', textContent: '', disabled: false, style: {},
      classList: {
        add: name => classes.add(name), remove: name => classes.delete(name),
        contains: name => classes.has(name),
        toggle: (name, force) => force ? classes.add(name) : classes.delete(name),
      },
      querySelector(selector) { return selector === 'svg' && this.innerHTML.includes('<svg') ? {} : null; },
      querySelectorAll: () => [],
      setAttribute(name, value) { this[name] = value; },
    };
  };
  let source = fs.readFileSync(appPath, 'utf8');
  source = source.replace(/  boot\(\)\.catch\(err => \{[\s\S]*?\n  \}\);\n\}\)\(\);\s*$/, `
  globalThis.appTest = { state, els, onEditorChanged, scheduleCompile, compilePreview, compilePreviewOnce, exportPdf,
    createWorkerTypstRuntime, ensureTypstRuntime, route,
    setGrammarEnabled,
    hooks(h) {
      if (h.compilePreview) compilePreview = h.compilePreview;
      if (h.compilePreviewOnce) compilePreviewOnce = h.compilePreviewOnce;
      if (h.compileVectorWithDiagnostics) compileVectorWithDiagnostics = h.compileVectorWithDiagnostics;
      if (h.syncOpenFileFromEditor) syncOpenFileFromEditor = h.syncOpenFileFromEditor;
      if (h.hydrateCompilerFS) hydrateCompilerFS = h.hydrateCompilerFS;
      if (h.renderDiagnostics) renderDiagnostics = h.renderDiagnostics;
      if (h.setCompileStatus) setCompileStatus = h.setCompileStatus;
      if (h.loadScript) loadScript = h.loadScript;
      renderRecents = () => {};
      updateChangeUI = () => {};
      updateFileTreeDirtyIndicator = () => {};
      maybeTriggerTypstPathSuggestions = () => {};
      normalizePreviewSvg = () => {};
      if (typeof installPreviewSvg === 'function') installPreviewSvg = svg => { els['preview-output'].innerHTML = svg; };
      buildSourceSearchOrder = () => [];
      schedulePreviewSourceAnchorIndexing = () => {};
      setPreviewZoom = () => {};
    }
  };
})();`);
  assert(source.includes('globalThis.appTest'), 'Test instrumentation must disable boot.');
  const window = {};
  const location = { hash: '#/' };
  const context = vm.createContext({
    TextEncoder, TextDecoder, Uint8Array, Map, Set, WeakMap, URL, URLSearchParams,
    Date: ClockDate, setTimeout: setTimer, clearTimeout: clearTimer,
    cancelAnimationFrame: noop, cancelIdleCallback: noop,
    console: { ...console, warn: noop }, Worker: WorkerDouble,
    window, location, document: { baseURI: 'http://localhost/app/', documentElement: { dataset: { theme: 'dark' } } },
  });
  vm.runInContext(source, context, { filename: appPath });
  const app = context.appTest;
  for (const name of ['editor-view', 'home-view', 'preview-output', 'preview-loading', 'preview-error',
    'diagnostic-list', 'preview-error-text', 'download-pdf-btn', 'compile-status', 'commit-btn',
    'change-count-badge', 'tab-dirty-dot', 'grammar-toggle-btn', 'editor-container']) app.els[name] = element();
  app.state.mainPath = app.state.openPath = 'main.typ';
  app.state.repo = { owner: { login: 'fixture' }, name: 'project' };
  app.state.fileIndex.set('main.typ', { existing: true, size: 7, sha: 'main' });
  app.state.editor = { getValue: () => '= Ready' };
  app.hooks({
    syncOpenFileFromEditor: async () => {}, hydrateCompilerFS: async () => {},
    renderDiagnostics: value => diagnostics.push(value),
    setCompileStatus: (kind, text) => statuses.push({ kind, text }),
  });
  return {
    app, window, location, workers, context, timers, statuses, diagnostics,
    async advance(milliseconds) {
      const target = now + milliseconds;
      for (let guard = 0; guard < 100; guard++) {
        const next = [...timers].filter(([, timer]) => timer.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        const [id, timer] = next;
        now = timer.due; timers.delete(id); timer.fn(); await ticks();
      }
      now = target; await ticks();
    },
    now: () => now,
  };
}

async function continuousInputKeepsFirstFrameDeadline() {
  const h = harness(), calls = [];
  h.app.hooks({ compilePreview: async () => calls.push(h.now()) });
  const serial = h.app.state.compileSerial;
  h.app.onEditorChanged({});
  const timer = h.app.state.compileTimer;
  for (let i = 0; i < 3; i++) { await h.advance(4); h.app.onEditorChanged({}); }
  assert.equal(h.app.state.compileTimer, timer, 'Repeated edits must keep the first preview deadline.');
  assert.equal(h.app.state.compileDueAt, 16);
  assert.equal(h.app.state.compileSerial, serial, 'Typing must not invalidate a running snapshot.');
  assert.equal(h.app.state.editRevision, 4);
  await h.advance(3);
  assert.equal(calls.length, 0);
  await h.advance(1);
  assert.deepEqual(calls, [16], 'Continuous input must still produce a preview after the first 16 ms.');
}

async function keystrokesNeverReadOrCompileTheWholeDocument() {
  const h = harness();
  h.app.state.editor.getValue = () => { throw new Error('A keystroke must not serialize the editor'); };
  h.window.$typst = { mapShadow: () => { throw new Error('A keystroke must not call the compiler'); } };
  h.app.hooks({ syncOpenFileFromEditor: () => { throw new Error('Sync must be deferred'); } });
  for (let i = 0; i < 200; i++) h.app.onEditorChanged({});
  assert.equal(h.app.state.editRevision, 200);
  assert.equal(h.app.state.changes.size, 1);
  assert.equal(h.timers.size, 2, 'Typing must retain only one preview timer and one sync timer.');
  assert.equal(h.app.state.compileDueAt, 16);
}

async function unavailableWorkersNeverLoadTheCompilerOnTheInputThread() {
  const h = harness();
  h.context.Worker = undefined;
  h.app.hooks({ loadScript: () => { throw new Error('UI compiler fallback must never run'); } });
  await assert.rejects(h.app.ensureTypstRuntime(), /requires Web Workers/);
  assert.equal(h.app.state.compilerReady, false);
  h.app.onEditorChanged({});
  assert.equal(h.app.state.editorSyncPending, true);
}

async function queuedCompilesCoalesceToTheLatestRevisionWithoutOverlap() {
  const h = harness(), first = deferred(), second = deferred(), calls = [];
  let active = 0, maximumActive = 0;
  h.app.hooks({ compilePreviewOnce: () => {
    calls.push(h.app.state.editRevision);
    maximumActive = Math.max(maximumActive, ++active);
    return (calls.length === 1 ? first : second).promise.finally(() => { active--; });
  } });
  const running = h.app.compilePreview();
  for (let i = 0; i < 5; i++) h.app.onEditorChanged({});
  assert.equal(calls.length, 1);
  assert.equal(h.app.state.compileQueued, true);
  assert.equal(h.app.state.compileTimer, null, 'An in-flight compile needs one queued batch, not another timer.');
  first.resolve(); await ticks();
  assert.deepEqual(calls, [0, 5], 'The queued compile must take the newest revision.');
  assert.equal(maximumActive, 1);
  second.resolve(); await running;
  assert.equal(h.app.state.compileInFlight, false);
  assert.equal(h.app.state.compileQueued, false);
}

async function completedValidSnapshotsPublishWhileTypingContinues() {
  const h = harness(), first = deferred(), second = deferred();
  h.app.els['preview-output'].innerHTML = '<svg id="old"></svg>';
  let calls = 0;
  h.app.hooks({ compileVectorWithDiagnostics: () => (++calls === 1 ? first : second).promise });
  const running = h.app.compilePreview();
  await ticks();
  const serial = h.app.state.compileSerial;
  h.app.onEditorChanged({});
  assert.equal(h.app.state.compileSerial, serial);
  first.resolve({ svg: '<svg id="snapshot"></svg>', diagnostics: [] });
  await ticks();
  assert.equal(h.app.els['preview-output'].innerHTML, '<svg id="snapshot"></svg>', 'A valid completed snapshot must remain publishable while new input waits.');
  assert.equal(calls, 2);
  second.resolve({ svg: '<svg id="latest"></svg>', diagnostics: [] });
  await running;
  assert.equal(h.app.els['preview-output'].innerHTML, '<svg id="latest"></svg>');
}

async function activePreviewDefersIdleSyncAndTheQueuedPassTakesTheNewestEdit() {
  const h = harness(), first = deferred(), second = deferred(), snapshots = [];
  let compiles = 0;
  h.app.hooks({
    syncOpenFileFromEditor: async () => {
      snapshots.push(h.app.state.editRevision);
      h.app.state.editorSyncPending = false;
    },
    compileVectorWithDiagnostics: () => (++compiles === 1 ? first : second).promise,
  });
  const running = h.app.compilePreview();
  await ticks();
  for (const text of ['a', '', 'b']) {
    h.app.onEditorChanged({ changes: [{ text }] });
    await h.advance(100);
  }
  assert.deepEqual(snapshots, [0], 'The idle timer must not queue intermediate shadow writes behind an active preview.');
  assert.equal(h.app.state.editorSyncPending, true, 'The latest source must remain pending for the queued preview or an explicit flush.');
  first.resolve({ svg: '<svg id="snapshot"></svg>', diagnostics: [] });
  await ticks();
  assert.deepEqual(snapshots, [0, 3], 'The next preview snapshots the latest insertion or deletion directly.');
  assert.equal(h.app.els['preview-output'].innerHTML, '<svg id="snapshot"></svg>', 'The completed preview publishes before the next compile finishes.');
  second.resolve({ svg: '<svg id="latest"></svg>', diagnostics: [] });
  await running;
  assert.equal(h.app.els['preview-output'].innerHTML, '<svg id="latest"></svg>');

  h.app.state.mainPath = null;
  h.app.onEditorChanged({ changes: [{ text: 'c' }] });
  await h.advance(90);
  assert.deepEqual(snapshots, [0, 3, 4], 'Idle syncing resumes when no preview is active.');
}

async function dataEditsAlsoRequestAPreview() {
  const h = harness();
  h.app.state.openPath = 'data.json';
  h.app.state.fileIndex.set('data.json', { existing: true });
  h.app.onEditorChanged({});
  assert.equal(h.app.state.compileDueAt, 16, 'JSON/data edits can affect the main document and must schedule compilation.');
  assert.equal(h.app.state.editorSyncPath, 'data.json');
}

async function changedMainFileAndRouteCannotPublishOldOutput() {
  for (const change of ['main', 'route']) {
    const h = harness(), result = deferred();
    h.app.els['preview-output'].innerHTML = '<svg id="existing"></svg>';
    h.app.hooks({ compileVectorWithDiagnostics: () => result.promise });
    const running = h.app.compilePreviewOnce();
    await ticks();
    if (change === 'main') h.app.state.mainPath = 'other.typ';
    else h.app.route();
    result.resolve({ svg: '<svg id="outdated"></svg>', diagnostics: [] });
    await running;
    assert.equal(h.app.els['preview-output'].innerHTML, '<svg id="existing"></svg>', `Outdated ${change} output must not publish.`);
    assert.equal(h.diagnostics.length, 0);
  }
}

async function stalePdfExportCannotUpdateAnotherProject() {
  const h = harness(), pdf = deferred();
  let requestedPath;
  h.window.$typst = { pdf: options => { requestedPath = options.mainFilePath; return pdf.promise; } };
  const exporting = h.app.exportPdf();
  await ticks();
  assert.equal(requestedPath, '/repo/main.typ');
  h.app.state.repositoryLoadSerial++;
  h.app.state.mainPath = 'other.typ';
  pdf.resolve(new Uint8Array());
  await exporting;
  assert.deepEqual(h.statuses.map(status => status.text), ['Exporting PDF']);
}

async function grammarChecksCoalesceAndNeverOfferStaleEdits() {
  const h = harness();
  const { state, els, onEditorChanged, setGrammarEnabled } = h.app;
  h.app.hooks({ compilePreview: async () => {} });
  let version = 1, reads = 0, provider;
  const model = {
    uri: 'file:///main.typ', getVersionId: () => version,
    getValue: () => { reads++; return 'This is is a test.'; },
    getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }),
    getOffsetAt: position => position.column - 1,
  };
  const markers = [];
  state.editor.getModel = () => model;
  state.monaco = {
    MarkerSeverity: { Info: 2 },
    editor: { setModelMarkers: (_, owner, values) => markers.push({ owner, values }) },
    languages: { registerCodeActionProvider: (_, value) => {
      provider = value;
      return { dispose: () => { provider = null; } };
    } },
  };
  onEditorChanged({});
  await h.advance(300);
  assert.equal(h.workers.length, 0);
  assert.equal(reads, 0);
  assert.equal(provider, undefined);
  setGrammarEnabled(true);
  await h.advance(300);
  const [worker] = h.workers;
  assert.equal(els['grammar-toggle-btn']['aria-pressed'], 'true');
  assert.equal(worker.url.pathname, '/app/grammar-worker.js');
  const first = worker.posts[0][0];

  version++;
  onEditorChanged({});
  await h.advance(150);
  version++;
  onEditorChanged({});
  await h.advance(300);
  assert.equal(worker.posts.length, 1, 'Only one check runs while subsequent edits coalesce.');
  const diagnostics = [{ start: 7, end: 10, message: 'Repeated word.', replacement: '' }];
  worker.onmessage({ data: { id: first.id, diagnostics } });
  assert.equal(markers.length, 0, 'The result was for an older model version.');
  const latest = worker.posts[1][0];
  worker.onmessage({ data: { id: latest.id, diagnostics } });
  assert.equal(markers[0].owner, 'grammar');
  assert.equal(markers[0].values[0].startColumn, 8);

  const range = { startLineNumber: 1, startColumn: 9, endLineNumber: 1, endColumn: 9 };
  const [action] = provider.provideCodeActions(model, range).actions;
  assert.equal(action.edit.edits[0].versionId, version);
  assert.equal(action.edit.edits[0].textEdit.text, '');
  version++;
  assert.equal(provider.provideCodeActions(model, range).actions.length, 0);
  setGrammarEnabled(false);
  assert.equal(els['grammar-toggle-btn']['aria-pressed'], 'false');
  assert.equal(markers.at(-1).values.length, 0);
  assert.equal(worker.terminated, true);
  assert.equal(provider, null);
}

async function latestInvalidSyntaxKeepsTheLastGoodPreviewAndShowsDiagnostics() {
  const h = harness();
  h.app.els['preview-output'].innerHTML = '<svg id="last-good"></svg>';
  h.app.hooks({ compileVectorWithDiagnostics: async () => ({ svg: null, diagnostics: [{
    severity: 'error', message: 'expected expression', path: 'main.typ', range: '1:1',
  }] }) });
  await h.app.compilePreviewOnce();
  assert.equal(h.app.els['preview-output'].innerHTML, '<svg id="last-good"></svg>');
  assert.equal(h.app.state.diagnostics[0].message, 'expected expression');
  assert.equal(h.diagnostics.length, 1);
  assert.equal(h.statuses.at(-1).kind, 'error');
  assert.equal(h.app.els['download-pdf-btn'].disabled, true);
}

async function supersededSyntaxErrorsDoNotReplaceLatestDiagnostics() {
  const h = harness(), result = deferred();
  h.app.els['preview-output'].innerHTML = '<svg id="last-good"></svg>';
  h.app.hooks({ compileVectorWithDiagnostics: () => result.promise });
  const running = h.app.compilePreviewOnce(); await ticks();
  h.app.onEditorChanged({});
  result.resolve({ svg: null, diagnostics: [{ severity: 'error', message: 'outdated syntax error' }] });
  await running;
  assert.equal(h.diagnostics.length, 0, 'An incomplete older snapshot must not flash stale diagnostics while typing.');
  assert.equal(h.app.els['preview-output'].innerHTML, '<svg id="last-good"></svg>');
}

async function supersededWarningsDoNotPublishWithValidPreview() {
  const h = harness(), result = deferred();
  h.app.hooks({ compileVectorWithDiagnostics: () => result.promise });
  const running = h.app.compilePreviewOnce();
  await ticks();
  h.app.onEditorChanged({});
  result.resolve({ svg: '<svg id="snapshot"></svg>', diagnostics: [{ severity: 'warning', message: 'outdated warning' }] });
  await running;
  assert.equal(h.app.els['preview-output'].innerHTML, '<svg id="snapshot"></svg>');
  assert.equal(h.diagnostics.length, 0, 'Do not mark newer source with warnings from an older preview.');
  h.app.hooks({ compileVectorWithDiagnostics: async () => ({
    svg: '<svg id="latest"></svg>', diagnostics: [{ severity: 'warning', message: 'current warning' }],
  }) });
  await h.app.compilePreviewOnce();
  assert.equal(h.app.state.diagnostics[0].message, 'current warning');
}

async function workerClientClonesBuffersAndCleansUpErrors() {
  const h = harness();
  const creating = h.app.createWorkerTypstRuntime();
  const worker = h.workers[0];
  assert.equal(worker.url.pathname, '/app/typst-worker.js');
  assert.equal(worker.options.type, 'module');
  worker.respond('init', { compilerReady: true, rendererReady: true });
  const service = await creating;
  const bytes = new Uint8Array([1, 2, 3]);
  const mapping = service.mapShadow('/repo/main.typ', bytes);
  const post = worker.posts.at(-1);
  assert.equal(post.length, 1, 'RPC must omit a transfer list for cached input files.');
  assert.equal(post[0].args.bytes, bytes);
  assert.equal(bytes.byteLength, 3);
  worker.respond('mapShadow', true); await mapping;
  worker.throwNextPost = true;
  await assert.rejects(service.resetShadow(), /Controlled post failure/);
  const failed = service.unmapShadow('/repo/main.typ');
  const rejection = assert.rejects(failed, error => error.name === 'TypeError' && error.message === 'Controlled operation failure');
  worker.respond('unmapShadow', undefined, { name: 'TypeError', message: 'Controlled operation failure' });
  await rejection;
  const healthy = service.resetShadow(); worker.respond('resetShadow', true); await healthy;

  h.window.$typst = service;
  h.app.state.runtimeInitPromise = Promise.resolve();
  h.app.state.compilerReady = h.app.state.compilerHydrated = true;
  const a = service.resetShadow(), b = service.mapShadow('/repo/main.typ', bytes);
  const rejectedA = assert.rejects(a, /Controlled worker failure/), rejectedB = assert.rejects(b, /Controlled worker failure/);
  worker.onerror({ preventDefault: noop, message: 'Controlled worker failure' });
  await Promise.all([rejectedA, rejectedB]);
  assert.equal(worker.terminated, true);
  assert.equal(h.window.$typst, null);
  assert.equal(h.app.state.runtimeInitPromise, null);
  assert.equal(h.app.state.compilerReady, false);
  assert.equal(h.app.state.compilerHydrated, false);
  const posts = worker.posts.length;
  await assert.rejects(service.resetShadow(), /Controlled worker failure/);
  assert.equal(worker.posts.length, posts, 'A stopped worker must not accumulate pending requests.');
}

async function failedWorkerInitializationNeverBlocksTheEditorAndCanRetry() {
  const h = harness();
  h.app.hooks({ loadScript: async () => { throw new Error('Must not load a UI-thread compiler'); } });
  const ready = h.app.ensureTypstRuntime();
  const worker = h.workers[0];
  const rejected = assert.rejects(ready, /Controlled init failure/);
  worker.respond('init', undefined, { name: 'Error', message: 'Controlled init failure' });
  await rejected;
  assert.equal(worker.terminated, true);
  assert.equal(h.window.$typst, undefined);
  assert.equal(h.app.state.runtimeInitPromise, null);
  h.app.onEditorChanged({});
  assert.equal(h.app.state.editorSyncPending, true, 'Editing remains available after a worker failure.');
  const retry = h.app.ensureTypstRuntime();
  h.workers[1].respond('init', {});
  await retry;
  assert.equal(h.window.$typst.isWorkerRuntime, true);
  assert.equal(h.app.state.compilerReady, true);
}

async function failedCompileStillProcessesNewerQueuedEdit() {
  const h = harness(), first = deferred(), calls = [];
  h.app.hooks({ compilePreviewOnce: () => {
    calls.push(h.app.state.editRevision);
    return calls.length === 1 ? first.promise : Promise.resolve();
  } });
  const running = h.app.compilePreview();
  h.app.onEditorChanged({});
  first.reject(new Error('Transient compiler failure'));
  await running;
  assert.deepEqual(calls, [0, 1], 'A newer edit queued during failure must still compile.');
  assert.equal(h.app.state.compileInFlight, false);
}

async function persistentFailureOfOneRevisionDoesNotLoop() {
  const h = harness();
  let calls = 0;
  h.app.hooks({ compilePreviewOnce: async () => {
    calls++;
    h.app.state.compileQueued = true;
    throw new Error('Persistent controlled failure');
  } });
  await assert.rejects(h.app.compilePreview(), /Persistent controlled failure/);
  assert.equal(calls, 2, 'A failed revision may retry once, but cannot create a busy loop.');
  assert.equal(h.app.state.compileInFlight, false);
  assert.equal(h.app.state.compilePromise, null);
}

async function workerPageDeltasUseReceivedSnapshotsAndRecoverAfterReset() {
  const h = harness();
  const creating = h.app.createWorkerTypstRuntime(), worker = h.workers[0];
  worker.respond('init', {});
  const service = await creating;
  const options = { mainFilePath: '/repo/main.typ', root: '/repo' };
  const meta = { opening: '<svg>', prefix: '<defs/>', suffix: '', closing: '</svg>' };
  let response = service.compilePreview(options);
  worker.respond('compilePreview', { svg: null, svgParts: { ...meta, pages: ['A', 'B'], revision: 1 }, diagnostics: [] });
  assert.deepEqual(Array.from((await response).svgParts.pages), ['A', 'B']);
  // No installation into the preview DOM is required to accept the next delta.
  response = service.compilePreview(options);
  assert.equal(worker.posts.at(-1)[0].args.baseRevision, 1);
  assert.equal(worker.posts.at(-1)[0].args.partsOnly, true);
  worker.respond('compilePreview', { svg: null, svgDelta: { ...meta, baseRevision: 1, revision: 2, pageCount: 3, patches: [{ index: 0, svg: 'A2' }, { index: 2, svg: 'C' }] }, diagnostics: [] });
  assert.deepEqual(Array.from((await response).svgParts.pages), ['A2', 'B', 'C']);
  response = service.compilePreview(options);
  worker.respond('compilePreview', { svg: null, diagnostics: [{ severity: 'error', message: 'incomplete typing' }] });
  await response;
  response = service.compilePreview(options);
  assert.equal(worker.posts.at(-1)[0].args.baseRevision, 2, 'A syntax error must retain the last successful transport base.');
  worker.respond('compilePreview', { svg: null, svgDelta: { ...meta, baseRevision: 2, revision: 3, pageCount: 2, patches: [{ index: 1, svg: 'B3' }] }, diagnostics: [] });
  assert.deepEqual(Array.from((await response).svgParts.pages), ['A2', 'B3']);
  const resetting = service.resetShadow(); worker.respond('resetShadow', true); await resetting;
  response = service.compilePreview(options);
  assert.equal(worker.posts.at(-1)[0].args.baseRevision, undefined);
  worker.respond('compilePreview', { svg: null, svgDelta: { ...meta, baseRevision: 3, revision: 4, pageCount: 2, patches: [] }, diagnostics: [] });
  await ticks();
  assert.equal(worker.posts.at(-1)[0].args.baseRevision, undefined, 'A mismatched base must request a complete snapshot.');
  worker.respond('compilePreview', { svg: null, svgParts: { ...meta, pages: ['X', 'Y'], revision: 5 }, diagnostics: [] });
  assert.deepEqual(Array.from((await response).svgParts.pages), ['X', 'Y']);
  response = service.compilePreview(options);
  const rejected = assert.rejects(response, /incomplete preview/);
  worker.respond('compilePreview', { svg: null, svgDelta: { ...meta, baseRevision: 5, revision: 6, pageCount: 4, patches: [{ index: 3, svg: 'Z' }] }, diagnostics: [] });
  await rejected;
}

(async () => {
  const tests = [continuousInputKeepsFirstFrameDeadline, keystrokesNeverReadOrCompileTheWholeDocument,
    unavailableWorkersNeverLoadTheCompilerOnTheInputThread,
    queuedCompilesCoalesceToTheLatestRevisionWithoutOverlap, completedValidSnapshotsPublishWhileTypingContinues,
    activePreviewDefersIdleSyncAndTheQueuedPassTakesTheNewestEdit,
    dataEditsAlsoRequestAPreview, changedMainFileAndRouteCannotPublishOldOutput, stalePdfExportCannotUpdateAnotherProject,
    grammarChecksCoalesceAndNeverOfferStaleEdits,
    latestInvalidSyntaxKeepsTheLastGoodPreviewAndShowsDiagnostics, supersededSyntaxErrorsDoNotReplaceLatestDiagnostics,
    supersededWarningsDoNotPublishWithValidPreview,
    workerClientClonesBuffersAndCleansUpErrors, failedWorkerInitializationNeverBlocksTheEditorAndCanRetry,
    failedCompileStillProcessesNewerQueuedEdit, persistentFailureOfOneRevisionDoesNotLoop, workerPageDeltasUseReceivedSnapshotsAndRecoverAfterReset];
  for (const test of tests) { await test(); console.log(`PASS ${test.name}`); }
  console.log(`${tests.length} preview scheduling/client checks passed. Timers, browser elements and worker transport are controlled VM doubles.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
