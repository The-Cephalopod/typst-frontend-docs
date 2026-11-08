'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const workerPath = path.resolve(__dirname, '../typst-worker.js');
const source = fs.readFileSync(workerPath, 'utf8');
const options = { mainFilePath: '/repo/main.typ', root: '/repo', diagnostics: 'full' };
const svg = '<svg><g class="typst-page"><path /></g></svg>';
const vector = new Uint8Array([1]);
const pdf = new Uint8Array([37, 80, 68, 70]);

function harness() {
  const calls = [];
  const control = { invalid: false, renderFails: false };
  const compiler = {
    compiler: {
      create_incr_server() {
        calls.push('server opened');
        return { free() { calls.push('server freed'); } };
      },
      snapshot(root, mainPath) {
        calls.push(['snapshot', root, mainPath]);
        return {
          incr_compile(server, diagnostics) {
            assert(server);
            assert.equal(diagnostics, 3);
            return control.invalid ? { diagnostics: [{ message: 'Expected expression' }] } : { result: vector };
          },
          free() { calls.push('world freed'); },
        };
      },
    },
    async runWithWorld(_options, run) {
      return run({
        vector() { calls.push('full vector'); return { result: vector }; },
        pdf() { calls.push('pdf'); return { result: pdf }; },
      });
    },
    async reset() { calls.push('compiler reset'); },
    resetShadow() { calls.push('shadow reset'); },
  };
  const renderer = {
    async runWithSession(run) {
      calls.push('session opened');
      try {
        return await run({
          manipulateData({ action, data }) { assert.equal(data, vector); calls.push(action); },
          async renderSvg() {
            if (control.renderFails) throw new Error('Renderer failed');
            return svg;
          },
        });
      } finally {
        calls.push('session freed');
      }
    },
  };
  const runtime = { async svg() { calls.push('full svg'); return svg; } };
  const context = vm.createContext({ self: {}, engine: { compiler, renderer, runtime }, Uint8Array });
  vm.runInContext(source + '\ngetEngine = async () => engine; globalThis.workerMethods = methods;', context, { filename: workerPath });
  return { methods: context.workerMethods, calls, control, compiler };
}

test('incremental preview keeps its base across invalid source and PDF export', async () => {
  const { methods, calls, control } = harness();
  const first = await methods.compilePreview({ options, partsOnly: true });
  assert(first.svgParts);
  control.invalid = true;
  const invalid = await methods.compilePreview({ options, partsOnly: true, baseRevision: first.svgParts.revision });
  assert.equal(invalid.svgParts, null);
  assert.equal(invalid.diagnostics[0].message, 'Expected expression');
  assert.equal(await methods.pdf({ options }), pdf);
  control.invalid = false;
  const recovered = await methods.compilePreview({ options, partsOnly: true, baseRevision: first.svgParts.revision });
  assert.equal(recovered.svgDelta.patches.length, 0);
  assert.deepEqual(calls.filter(call => typeof call === 'string'), [
    'server opened', 'session opened', 'world freed', 'reset', 'world freed', 'pdf', 'world freed', 'merge',
  ]);
  await methods.reset();
  assert.deepEqual(calls.slice(-3), ['session freed', 'server freed', 'compiler reset']);
});

test('a different main or shadow reset frees the matching server and renderer', async () => {
  const { methods, calls } = harness();
  const first = await methods.compilePreview({ options, partsOnly: true });
  const newOptions = { ...options, mainFilePath: '/repo/chapter.typ' };
  const next = await methods.compilePreview({ options: newOptions, partsOnly: true, baseRevision: first.svgParts.revision });
  assert(next.svgDelta);
  assert.deepEqual(calls.slice(5, 9), ['session freed', 'server freed', 'server opened', 'session opened']);
  await methods.resetShadow();
  assert.deepEqual(calls.slice(-3), ['session freed', 'server freed', 'shadow reset']);
  const fresh = await methods.compilePreview({ options: newOptions, partsOnly: true, baseRevision: next.svgDelta.revision });
  assert(fresh.svgParts);
  await methods.reset();
});

test('a renderer failure releases incremental state and retries through the full preview path', async () => {
  const { methods, calls, control } = harness();
  const first = await methods.compilePreview({ options, partsOnly: true });
  control.renderFails = true;
  const retried = await methods.compilePreview({ options, partsOnly: true, baseRevision: first.svgParts.revision });
  assert(retried.svgDelta);
  assert.deepEqual(calls.slice(-6), ['world freed', 'merge', 'session freed', 'server freed', 'full vector', 'full svg']);
  control.renderFails = false;
  await methods.resetShadow();
  await methods.compilePreview({ options });
  assert.equal(calls.filter(call => call === 'server opened').length, 1);
  assert.deepEqual(calls.slice(-3), ['shadow reset', 'full vector', 'full svg']);
});

test('the full worker preview remains usable without native incremental bindings', async () => {
  const { methods, calls, compiler } = harness();
  delete compiler.compiler;
  const result = await methods.compilePreview({ options });
  assert.equal(result.svg, svg);
  assert.deepEqual(calls, ['full vector', 'full svg']);
});
