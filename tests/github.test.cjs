'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const appPath = path.resolve(__dirname, '../app.js');
const source = fs.readFileSync(appPath, 'utf8').replace(
  /  boot\(\)\.catch\(err => \{[\s\S]*?\n  \}\);\n\}\)\(\);\s*$/,
  `  state.token = 'connected'; globalThis.github = github;\n})();`,
);
assert(source.includes('globalThis.github = github'), 'Test instrumentation must disable application boot.');

function createClient(respond) {
  const calls = [];
  const fetch = async (address, options) => {
    const url = new URL(address);
    assert.equal(url.origin, 'https://api.github.com');
    const call = { ...options, method: options.method || 'GET', path: url.pathname, query: Object.fromEntries(url.searchParams),
      body: options.body ? JSON.parse(options.body) : undefined };
    calls.push(call);
    const response = respond(call);
    return response instanceof Response ? response : Response.json(response);
  };
  const context = vm.createContext({ TextEncoder, TextDecoder, fetch, window: {} });
  vm.runInContext(source, context, { filename: appPath });
  const client = context.github;
  return { client, calls };
}

test('creates the exact branch ref, opens a pull request and looks it up for a retry', async () => {
  const branch = 'drafts/appendix';
  const target = 'release/notes';
  const sha = 'cba9876543210cba9876543210cba9876543210cd';
  const pull = { html_url: 'https://github.com/owner/project/pull/23', number: 23,
    head: { ref: branch, repo: { full_name: 'owner/project' } }, base: { ref: target } };
  const { client, calls } = createClient(({ path, method }) => {
    if (path.endsWith('/git/refs')) return { ref: `refs/heads/${branch}`, object: { sha } };
    return method === 'POST' ? pull : [pull];
  });

  assert.equal((await client.createBranch('owner', 'project', branch, sha)).object.sha, sha);
  assert.equal((await client.createPullRequest('owner', 'project', branch, target, 'Review appendix', 'Résumé\n\nSecond paragraph.')).html_url, pull.html_url);
  assert.equal((await client.findOpenPullRequest('owner', 'project', branch, target)).number, 23);
  assert.deepEqual(calls.map(call => [call.method, call.path, call.body]), [
    ['POST', '/repos/owner/project/git/refs', { ref: `refs/heads/${branch}`, sha }],
    ['POST', '/repos/owner/project/pulls', { head: branch, base: target, title: 'Review appendix', body: 'Résumé\n\nSecond paragraph.' }],
    ['GET', '/repos/owner/project/pulls', undefined],
  ]);
  assert.deepEqual(calls[2].query, { state: 'open', head: `owner:${branch}`, base: target });
  assert.equal(calls[2].cache, 'no-store');
  assert(calls.every(call => call.headers.Authorization === 'Bearer connected'));
});

test('preserves GitHub permission and validation errors for branch and pull request operations', async () => {
  const { client } = createClient(({ path }) => path.endsWith('/git/refs')
    ? Response.json({ message: 'Resource not accessible by personal access token' }, { status: 403 })
    : Response.json({ message: 'No commits between branches' }, { status: 422 }));
  await assert.rejects(client.createBranch('owner', 'project', 'feature', 'head'), {
    status: 403, message: 'Resource not accessible by personal access token',
  });
  await assert.rejects(client.createPullRequest('owner', 'project', 'feature', 'main', 'Review', ''), {
    status: 422, message: 'No commits between branches',
  });
});
