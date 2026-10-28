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
const ticks = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function element() {
  const classes = new Set();
  return {
    classList: {
      add: name => classes.add(name), remove: name => classes.delete(name),
      contains: name => classes.has(name),
      toggle: (name, force) => (force ? classes.add(name) : classes.delete(name)),
    },
    innerHTML: '', textContent: '', style: {},
    querySelector: () => ({ textContent: '' }),
    remove: noop, appendChild: noop,
  };
}

function harness() {
  let source = fs.readFileSync(appPath, 'utf8');
  source = source.replace(/  boot\(\)\.catch\(err => \{[\s\S]*?\n  \}\);\n\}\)\(\);\s*$/, `
  globalThis.appTest = {
    state, els, github, route, loadScript, ensureMonaco, ensureTypstRuntime,
    openFile, openRepository, resetProjectState, hydrateCompilerFS, pooled,
    compilePreviewOnce, compilePreview, showCompileError, handleFatalRepoError,
    hooks(h) {
      if (h.initMonaco) initMonaco = h.initMonaco;
      if (h.loadScript) loadScript = h.loadScript;
      if (h.ensureMonaco) ensureMonaco = h.ensureMonaco;
      if (h.ensureTypstRuntime) ensureTypstRuntime = h.ensureTypstRuntime;
      if (h.showHome) showHome = h.showHome;
      if (h.renderRecents) renderRecents = h.renderRecents;
      if (h.renderFileTree) renderFileTree = h.renderFileTree;
      if (h.updateRepoHeader) updateRepoHeader = h.updateRepoHeader;
      if (h.renderBranches) renderBranches = h.renderBranches;
      if (h.addRecentProject) addRecentProject = h.addRecentProject;
      if (h.hydrateCompilerFS) hydrateCompilerFS = h.hydrateCompilerFS;
      if (h.scheduleCompile) scheduleCompile = h.scheduleCompile;
      if (h.applyDiagnosticMarkersForOpenFile) applyDiagnosticMarkersForOpenFile = h.applyDiagnosticMarkersForOpenFile;
      if (h.settleEditorLayout) settleEditorLayout = h.settleEditorLayout;
      if (h.updateFileTreeSelection) updateFileTreeSelection = h.updateFileTreeSelection;
      if (h.compileVectorWithDiagnostics) compileVectorWithDiagnostics = h.compileVectorWithDiagnostics;
      if (h.compilePreviewOnce) compilePreviewOnce = h.compilePreviewOnce;
    }
  };
})();`);
  assert(source.includes('globalThis.appTest'), 'Test instrumentation must disable application boot.');
  const document = {
    createElement: element,
    head: { appendChild: noop },
    documentElement: { dataset: { theme: 'dark' }, style: { setProperty: noop } },
  };
  const window = {};
  const location = { hash: '#/' };
  const context = vm.createContext({
    TextEncoder, TextDecoder, Uint8Array, Map, Set, WeakMap, URLSearchParams,
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    setTimeout, clearTimeout, cancelAnimationFrame: noop,
    window, document, location, console,
  });
  vm.runInContext(source, context, { filename: appPath });
  const app = context.appTest;
  for (const name of ['home-view', 'editor-view', 'compile-status', 'repo-sync-status',
    'preview-output', 'preview-error', 'diagnostic-list', 'preview-error-text', 'preview-loading',
    'commit-btn', 'change-count-badge', 'tab-dirty-dot', 'main-file-label', 'file-count-label',
    'status-current-file', 'tab-file-name', 'tab-file-icon', 'editor-container', 'binary-file-view']) {
    app.els[name] = element();
  }
  return { app, context, window, document, location };
}

async function homeDoesNotLoadDependencies() {
  const { app } = harness();
  let homes = 0;
  app.hooks({
    showHome: () => homes++,
    ensureMonaco: () => { throw new Error('Home should not initialize Monaco'); },
    ensureTypstRuntime: () => { throw new Error('Home should not initialize Typst'); },
  });
  app.route();
  assert.equal(homes, 1);
  assert.equal(app.state.repositoryLoadSerial, 1);
}

async function monacoStartupSharesAndRetries() {
  const { app } = harness();
  let calls = 0;
  const first = deferred();
  app.hooks({ initMonaco: () => { calls++; return first.promise; } });
  const a = app.ensureMonaco();
  const b = app.ensureMonaco();
  assert.equal(a, b, 'Concurrent startup must share one promise.');
  const rejection = assert.rejects(a, /Controlled failure/);
  first.reject(new Error('Controlled failure'));
  await rejection;
  assert.equal(app.state.editorInitPromise, null);
  app.hooks({ initMonaco: async () => { calls++; app.state.editor = {}; } });
  await app.ensureMonaco();
  await app.ensureMonaco();
  assert.equal(calls, 2, 'Startup failure must be retryable and initialized editor reusable.');
}

async function runtimeStartupSharesAndRetries() {
  const { app, window } = harness();
  let calls = 0;
  const first = deferred();
  app.hooks({ loadScript: () => { calls++; return first.promise; } });
  const a = app.ensureTypstRuntime();
  const b = app.ensureTypstRuntime();
  assert.equal(a, b);
  const rejection = assert.rejects(a, /Controlled failure/);
  first.reject(new Error('Controlled failure'));
  await rejection;
  assert.equal(app.state.runtimeInitPromise, null);
  const configured = [];
  app.hooks({ loadScript: async (url, type) => {
    calls++;
    assert.equal(type, 'module');
    assert(url.includes('@0.8.0-rc3/'), 'Runtime must retain version pin.');
    window.$typst = {
      setCompilerInitOptions: options => configured.push(options.getModule()),
      setRendererInitOptions: options => configured.push(options.getModule()),
    };
  } });
  await app.ensureTypstRuntime();
  await app.ensureTypstRuntime();
  assert.equal(calls, 2);
  assert.equal(configured.length, 2);
  assert(configured.every(url => url.startsWith('https://cdn.jsdelivr.net/') && url.includes('@0.8.0-rc3/')));
  assert.equal(app.state.compilerReady, true);
}

async function scriptFailuresAreRetryable() {
  const { app, document } = harness();
  let script;
  document.head.appendChild = node => { script = node; };
  const failed = app.loadScript('https://cdn.jsdelivr.net/test.js');
  const rejection = assert.rejects(failed, /did not load/);
  script.onerror();
  await rejection;
  assert.equal(script.onload, null);
  assert.equal(script.onerror, null);
  const retried = app.loadScript('https://cdn.jsdelivr.net/test.js');
  script.onload();
  await retried;
}

async function staleMetadataCannotOverwriteRoute() {
  const { app } = harness();
  const metadata = deferred();
  app.github.getRepo = () => metadata.promise;
  app.hooks({ ensureMonaco: async () => {}, ensureTypstRuntime: async () => {} });
  const opening = app.openRepository('old', 'project', null);
  app.state.repositoryLoadSerial++;
  metadata.resolve({ owner: { login: 'old' }, name: 'project', default_branch: 'main' });
  await opening;
  assert.equal(app.state.repo, null, 'A late metadata result must not install an old repository.');
}

async function staleEditorStartupCannotWriteNewProject() {
  const { app } = harness();
  const editor = deferred();
  const bytes = new TextEncoder().encode('= Old');
  app.state.repo = { owner: { login: 'old' }, name: 'project' };
  app.state.fileIndex.set('main.typ', { path: 'main.typ', existing: false, bytes });
  app.hooks({ ensureMonaco: () => editor.promise });
  const opening = app.openFile('main.typ');
  app.resetProjectState();
  editor.resolve();
  await opening;
  assert.equal(app.state.openPath, null, 'An editor waiting for initialization must not activate a different-project file.');
}

async function returningHomeCancelsPendingEditorAndCompileWork() {
  const { app } = harness();
  const editor = deferred();
  const bytes = new TextEncoder().encode('= Old');
  app.state.repo = { owner: { login: 'old' }, name: 'project' };
  app.state.fileIndex.set('main.typ', { path: 'main.typ', existing: false, bytes });
  app.hooks({ ensureMonaco: () => editor.promise, renderRecents: noop });
  let compiled = false;
  app.state.compileTimer = setTimeout(() => { compiled = true; }, 10);
  const compilationSerial = app.state.compileSerial;
  const indexingGeneration = app.state.previewIndexGeneration;
  const opening = app.openFile('main.typ');
  app.route();
  editor.resolve();
  await opening;
  assert.equal(app.state.openPath, null, 'Pending editor startup must not focus or activate a file after returning home.');
  assert.equal(app.state.compileTimer, null);
  assert.equal(compiled, false);
  assert(app.state.compileSerial > compilationSerial);
  assert(app.state.previewIndexGeneration > indexingGeneration);
}

function project(app, name) {
  app.state.repo = { owner: { login: 'fixture' }, name };
  app.state.mainPath = `${name}.typ`;
  app.state.fileIndex.set(`${name}.typ`, {
    path: `${name}.typ`, existing: false, size: 8,
    bytes: new TextEncoder().encode(`= ${name}`),
  });
}

async function runtimeWaitCannotHydrateAReplacementProject() {
  const { app, window } = harness();
  const runtime = deferred();
  const operations = [];
  app.hooks({ ensureTypstRuntime: () => runtime.promise });
  window.$typst = {
    resetShadow: async () => operations.push('reset'),
    mapShadow: async name => { operations.push(name); return true; },
  };
  project(app, 'old');
  const oldHydration = app.hydrateCompilerFS();
  const oldRejected = assert.rejects(oldHydration, error => error.name === 'AbortError');
  await ticks();
  app.state.repositoryLoadSerial++;
  app.resetProjectState();
  project(app, 'new');
  const newHydration = app.hydrateCompilerFS();
  runtime.resolve();
  await oldRejected;
  await newHydration;
  assert.deepEqual(operations, ['reset', '/repo/new.typ'], 'Only the current project may reset and populate the shadow FS.');
  assert.equal(app.state.compilerHydrated, true);
}

async function failedHydrationDrainsWorkersBeforeNextProject() {
  const { app, window } = harness();
  const secondOldMap = deferred();
  const startedSecondOldMap = deferred();
  const operations = [];
  app.hooks({ ensureTypstRuntime: async () => {} });
  window.$typst = {
    resetShadow: async () => operations.push(`reset:${app.state.repo.name}`),
    mapShadow: async name => {
      operations.push(`start:${name}`);
      if (name === '/repo/old.typ') throw new Error('Controlled mapping failure');
      if (name === '/repo/sibling.typ') { startedSecondOldMap.resolve(); await secondOldMap.promise; }
      operations.push(`end:${name}`);
      return true;
    },
  };
  project(app, 'old');
  app.state.fileIndex.set('sibling.typ', { path: 'sibling.typ', existing: false, size: 7, bytes: new TextEncoder().encode('Sibling') });
  const oldHydration = app.hydrateCompilerFS(true);
  const oldRejected = assert.rejects(oldHydration, error => error.name === 'AbortError');
  await startedSecondOldMap.promise;
  await ticks();
  app.state.repositoryLoadSerial++;
  app.resetProjectState();
  project(app, 'new');
  const newHydration = app.hydrateCompilerFS();
  await ticks();
  assert(!operations.includes('reset:new'), 'A new hydration must wait for every old map operation, including after a failure.');
  secondOldMap.resolve();
  await oldRejected;
  await newHydration;
  assert(operations.indexOf('reset:new') > operations.indexOf('end:/repo/sibling.typ'));
  assert.equal(app.state.compilerHydrated, true);
}

async function staleHydrationCannotStartCompilation() {
  const { app } = harness();
  const hydration = deferred();
  let compiles = 0;
  app.state.mainPath = 'main.typ';
  app.hooks({
    hydrateCompilerFS: () => hydration.promise,
    compileVectorWithDiagnostics: async () => { compiles++; return { result: null, diagnostics: [] }; },
    renderRecents: noop,
  });
  const compiling = app.compilePreviewOnce();
  await ticks();
  app.route();
  hydration.resolve();
  await compiling;
  assert.equal(compiles, 0, 'Returning home while hydration waits must not start a stale compile.');
}

async function staleCancellationsDoNotBecomeErrors() {
  const { app } = harness();
  const abort = new Error('Old project cancelled');
  abort.name = 'AbortError';
  app.els['preview-loading'].classList.remove('hidden');
  app.showCompileError(abort);
  app.handleFatalRepoError(abort);
  assert.equal(app.state.diagnostics.length, 0);
  assert.equal(app.els['preview-error-text'].textContent, '');
  assert.equal(app.els['preview-loading'].classList.contains('hidden'), false);
}

async function staleCompileCleanupDoesNotEraseNewCompile() {
  const { app } = harness();
  const oldCompile = deferred();
  const newCompile = deferred();
  let calls = 0;
  app.state.mainPath = 'main.typ';
  app.hooks({ compilePreviewOnce: () => (++calls === 1 ? oldCompile.promise : newCompile.promise) });
  const oldCompilation = app.compilePreview();
  app.state.repositoryLoadSerial++;
  app.resetProjectState();
  app.state.mainPath = 'new.typ';
  const newCompilation = app.compilePreview();
  const currentPromise = app.state.compilePromise;
  oldCompile.resolve();
  await oldCompilation;
  assert.equal(app.state.compileInFlight, true);
  assert.equal(app.state.compilePromise, currentPromise, 'An old compilation must not clear the current compile lock.');
  newCompile.resolve();
  await newCompilation;
  assert.equal(app.state.compileInFlight, false);
}

async function loadedDefaultBranchDoesNotReload() {
  const { app, location } = harness();
  app.state.repo = { owner: { login: 'fixture' }, name: 'project', default_branch: 'main' };
  app.state.branch = 'main';
  app.state.editor = {};
  app.state.headSha = 'loaded';
  app.state.openPath = app.state.mainPath = 'main.typ';
  app.state.compilerHydrated = true;
  app.github.getRepo = () => { throw new Error('Loaded default branch should not refetch.'); };
  const repositorySerial = app.state.repositoryLoadSerial;
  const compileSerial = app.state.compileSerial;
  await app.openRepository('fixture', 'project', null);
  assert.equal(app.state.headSha, 'loaded');
  location.hash = '#/repo/fixture/project?branch=main';
  app.route();
  assert.equal(app.state.repositoryLoadSerial, repositorySerial, 'A redundant loaded route must not invalidate active work.');
  assert.equal(app.state.compileSerial, compileSerial);
}

async function repositoryAndEditorRequestsRunInParallel() {
  const { app } = harness();
  const editor = deferred();
  const metadata = deferred();
  let metadataRequested = false, editorRequested = false;
  app.hooks({
    ensureMonaco: () => { editorRequested = true; return editor.promise; },
    ensureTypstRuntime: async () => {},
    renderFileTree: noop, updateRepoHeader: noop, renderBranches: noop,
    addRecentProject: noop, hydrateCompilerFS: async () => {}, scheduleCompile: noop,
    applyDiagnosticMarkersForOpenFile: noop, settleEditorLayout: noop, updateFileTreeSelection: noop,
  });
  app.github.getRepo = () => { metadataRequested = true; return metadata.promise; };
  app.github.getBranches = async () => [];
  app.github.getRef = async () => ({ object: { sha: 'commit' } });
  app.github.getCommit = async () => ({ tree: { sha: 'tree' } });
  app.github.getTree = async () => ({ tree: [{ path: 'main.typ', type: 'blob', sha: 'blob', size: 7 }] });
  app.github.getBlob = async () => ({ content: Buffer.from('= Ready').toString('base64') });
  const values = [];
  app.state.editor = { setValue: value => values.push(value), getModel: () => ({}), focus: noop };
  app.state.monaco = { editor: { setModelLanguage: noop } };
  const opening = app.openRepository('fixture', 'project', null);
  assert(metadataRequested && editorRequested, 'GitHub metadata must not wait for Monaco startup.');
  metadata.resolve({ owner: { login: 'fixture' }, name: 'project', full_name: 'fixture/project', default_branch: 'main' });
  await ticks();
  assert.equal(values.length, 0, 'Opening must wait for editor readiness before setting source.');
  editor.resolve();
  await opening;
  assert.equal(values[0], '= Ready');
}

(async () => {
  const tests = [homeDoesNotLoadDependencies, monacoStartupSharesAndRetries,
    runtimeStartupSharesAndRetries, scriptFailuresAreRetryable,
    staleMetadataCannotOverwriteRoute, staleEditorStartupCannotWriteNewProject,
    returningHomeCancelsPendingEditorAndCompileWork,
    runtimeWaitCannotHydrateAReplacementProject, failedHydrationDrainsWorkersBeforeNextProject,
    staleHydrationCannotStartCompilation, staleCancellationsDoNotBecomeErrors,
    staleCompileCleanupDoesNotEraseNewCompile,
    loadedDefaultBranchDoesNotReload, repositoryAndEditorRequestsRunInParallel];
  for (const test of tests) {
    await test();
    console.log(`PASS ${test.name}`);
  }
  console.log(`${tests.length} focused startup checks passed. These are VM behavior checks, not browser performance measurements.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
