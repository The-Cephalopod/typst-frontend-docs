'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const appPath = path.resolve(__dirname, '../app.js');
const encodeBlob = text => ({ content: Buffer.from(text).toString('base64') });
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

function harness(files = {}) {
  let source = fs.readFileSync(appPath, 'utf8');
  source = source.replace(/  boot\(\)\.catch\(err => \{[\s\S]*?\n  \}\);\n\}\)\(\);\s*$/, `  globalThis.appTest = { state, github, els, getFileBytes, collectCompilerDependencyEntries, resetProjectState };\n})();`);
  assert(source.includes('globalThis.appTest'), 'Test instrumentation must disable application boot.');
  const context = vm.createContext({
    TextEncoder, TextDecoder, Uint8Array, Map, Set, WeakMap, URLSearchParams,
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    setTimeout, clearTimeout, console, window: {}, document: {},
  });
  vm.runInContext(source, context, { filename: appPath });
  const app = context.appTest;
  for (const name of ['preview-output', 'preview-error', 'diagnostic-list', 'preview-error-text', 'preview-loading', 'commit-btn', 'change-count-badge', 'tab-dirty-dot']) {
    app.els[name] = { innerHTML: '', classList: { add() {}, remove() {}, toggle() {} } };
  }
  project(app, files);
  return app;
}

function project(app, files) {
  app.state.repo = { owner: { login: 'fixture' }, name: 'project' };
  app.state.fileIndex = new Map(Object.entries(files).map(([name, text]) => [name, {
    path: name, sha: name, existing: true, size: Buffer.byteLength(text),
  }]));
}

async function duplicateRequestsShareAndCache() {
  const app = harness({ 'main.typ': '= Fixture' });
  let calls = 0;
  app.github.getBlob = async () => { calls++; await nextTurn(); return encodeBlob('= Fixture'); };
  const values = await Promise.all(Array.from({ length: 3 }, () => app.getFileBytes('main.typ')));
  assert.equal(calls, 1, 'Concurrent requests for one blob must share a download.');
  assert(values.every(bytes => bytes === values[0]), 'Consumers must share the decoded bytes.');
  assert.equal(Buffer.from(values[0]).toString(), '= Fixture');
  assert.equal(await app.getFileBytes('main.typ'), values[0]);
  assert.equal(calls, 1, 'Completed responses must remain cached.');
}

async function dependencyDiscoveryIsBoundedAndDeterministic() {
  const files = {
    'main.typ': Array.from({ length: 16 }, (_, i) => `#include "lib/${i}.typ"`).join('\n') + '\n#include "failed.typ"\n#import "@preview/example:1.0.0"\n#image("assets/photo.png")',
    'shared.typ': '#include "main.typ"\n#json("assets/data.json")',
    'failed.typ': 'not fetched', 'assets/photo.png': 'image',
    'assets/data.json': '{"fixture":true}', 'fonts/fixture.ttf': 'font',
    'unused.typ': '= Unrelated',
  };
  for (let i = 0; i < 16; i++) files[`lib/${i}.typ`] = '#include "../shared.typ"';
  const app = harness(files);
  app.state.mainPath = 'main.typ';
  app.state.fileBytes.set('main.typ', new TextEncoder().encode(files['main.typ']));
  let calls = 0, active = 0, maximumActive = 0;
  app.github.getBlob = async (_owner, _repo, sha) => {
    calls++; active++; maximumActive = Math.max(active, maximumActive);
    await nextTurn();
    active--;
    if (sha === 'failed.typ') throw new Error('Controlled failure');
    return encodeBlob(files[sha]);
  };
  const selected = await app.collectCompilerDependencyEntries([...app.state.fileIndex]);
  const paths = Array.from(selected, ([name]) => name);
  assert.deepEqual(paths, ['main.typ', 'fonts/fixture.ttf',
    ...Array.from({ length: 16 }, (_, i) => `lib/${i}.typ`),
    'failed.typ', 'assets/photo.png', 'shared.typ', 'assets/data.json'],
  'Selection must preserve order, fonts, relative assets, shared/cyclic imports and failed paths for fallback.');
  assert.equal(calls, 18, 'Unrelated files, fonts and assets need not be read during import discovery.');
  assert.equal(maximumActive, 8, 'Sibling imports must overlap within the eight-request bound.');
}

async function failedRequestsRetryAndKeepSizeGuard() {
  const app = harness({ 'main.typ': '= Fixture', 'large.typ': '' });
  let calls = 0;
  app.github.getBlob = async () => {
    if (++calls === 1) throw new Error('Controlled failure');
    return encodeBlob('= Fixture');
  };
  await assert.rejects(app.getFileBytes('main.typ'), /Controlled failure/);
  assert.equal(app.state.fileRequests.size, 0);
  await app.getFileBytes('main.typ');
  assert.equal(calls, 2, 'Failed in-flight entries must permit retry.');
  app.state.fileIndex.get('large.typ').size = 26 * 1024 * 1024;
  await assert.rejects(app.getFileBytes('large.typ'), /too large/);
  assert.equal(calls, 2, 'Oversized blobs must fail before a network request.');
}

async function staleProjectAndReplacedFileResponsesAreIsolated() {
  const app = harness({ 'main.typ': '= Old' });
  let releaseOld;
  app.github.getBlob = () => new Promise(resolve => { releaseOld = resolve; });
  const oldRejected = assert.rejects(app.getFileBytes('main.typ'), error => error.name === 'AbortError');
  app.resetProjectState();
  assert.equal(app.state.fileRequests.size, 0, 'Project reset must clear pending entries.');
  project(app, { 'main.typ': '= New' });
  let releaseNew;
  app.github.getBlob = () => new Promise(resolve => { releaseNew = resolve; });
  const newRequest = app.getFileBytes('main.typ');
  releaseOld(encodeBlob('= Old'));
  await oldRejected;
  assert.equal(app.state.fileBytes.size, 0);
  assert.equal(app.state.originalBytes.size, 0);
  assert.equal(app.state.sourceTextCache.size, 0);
  assert.equal(app.state.fileRequests.size, 1, 'Old cleanup must not remove the new project request.');
  releaseNew(encodeBlob('= New'));
  assert.equal(Buffer.from(await newRequest).toString(), '= New');

  app.resetProjectState();
  project(app, { 'main.typ': '= Before upload' });
  let releaseReplaced;
  app.github.getBlob = () => new Promise(resolve => { releaseReplaced = resolve; });
  const replacedRejected = assert.rejects(app.getFileBytes('main.typ'), error => error.name === 'AbortError');
  app.state.fileIndex.set('main.typ', { path: 'main.typ', existing: false, bytes: new TextEncoder().encode('= Uploaded') });
  releaseReplaced(encodeBlob('= Before upload'));
  await replacedRejected;
  assert.equal(app.state.fileBytes.size, 0, 'A replaced file must not receive stale network content.');
}

async function staleDiscoveryCannotContinueIntoNewProject() {
  const app = harness({ 'main.typ': '#include "child.typ"', 'child.typ': '= Child' });
  app.state.mainPath = 'main.typ';
  let release, calls = 0;
  app.github.getBlob = () => { calls++; return new Promise(resolve => { release = resolve; }); };
  const rejected = assert.rejects(app.collectCompilerDependencyEntries([...app.state.fileIndex]), error => error.name === 'AbortError');
  app.resetProjectState();
  project(app, { 'main.typ': '= New' });
  release(encodeBlob('#include "child.typ"'));
  await rejected;
  assert.equal(calls, 1, 'Cancelled discovery must not fetch an old child from the new project.');
  assert.equal(app.state.fileBytes.size, 0);
}

(async () => {
  const tests = [duplicateRequestsShareAndCache, dependencyDiscoveryIsBoundedAndDeterministic,
    failedRequestsRetryAndKeepSizeGuard, staleProjectAndReplacedFileResponsesAreIsolated,
    staleDiscoveryCannotContinueIntoNewProject];
  for (const test of tests) { await test(); console.log(`PASS ${test.name}`); }
  console.log(`${tests.length} data-loading checks passed. These are VM behavior checks, not browser performance measurements.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
