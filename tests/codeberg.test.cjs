'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const clientPath = path.resolve(__dirname, '../codeberg.js');
const source = readFileSync(clientPath, 'utf8');
const encoder = new TextEncoder();

function createClient(respond, token = '') {
  const calls = [];
  const window = {};
  const fetch = async (address, options) => {
    const url = new URL(address);
    assert.equal(url.origin, 'https://codeberg.org');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    const call = {
      path: url.pathname.replace(/^\/api\/v1/, ''),
      query: Object.fromEntries(url.searchParams),
      ...options,
      body: options.body ? JSON.parse(options.body) : undefined,
    };
    calls.push(call);
    const response = await respond(call);
    return response instanceof Response ? response : Response.json(response);
  };
  vm.runInNewContext(source, { window, fetch, btoa }, { filename: clientPath });
  return { client: new window.CodebergClient(typeof token === 'function' ? token : () => token), calls };
}

test('normalizes reference and tree response shapes and requests immutable tree pages', async () => {
  const { client, calls } = createClient(({ path, query }) => {
    if (path.endsWith('/git/refs/heads/drafts/notes%20%23one')) {
      return [
        { ref: 'refs/heads/drafts/notes #one-extra', object: { sha: 'wrong' } },
        { ref: 'refs/heads/drafts/notes #one', object: { sha: 'head' } },
      ];
    }
    if (path.endsWith('/git/commits/head')) return { sha: 'head', commit: { tree: { sha: 'tree' } } };
    if (path.endsWith('/git/trees/tree')) return {
      tree: [{ path: query.page === '1' ? 'main.typ' : 'chapter.typ', type: 'blob', mode: '100644' }],
      truncated: query.page === '1',
    };
    if (path.endsWith('/git/blobs/source')) return { content: 'PT0=', encoding: 'base64' };
    throw new Error(`Unexpected read: ${path}`);
  });

  assert.equal((await client.getRef('owner', 'project', 'drafts/notes #one')).object.sha, 'head');
  assert.equal(calls[0].cache, 'no-store');
  assert.equal((await client.getCommit('owner', 'project', 'head')).tree.sha, 'tree');
  assert.deepEqual(calls[1].query, { stat: 'false', verification: 'false', files: 'false' });
  const tree = await client.getTree('owner', 'project', 'tree');
  assert.deepEqual(Array.from(tree.tree, entry => entry.path), ['main.typ', 'chapter.typ']);
  assert.equal(tree.truncated, false);
  assert.equal(calls[2].query.recursive, 'true');
  assert.equal((await client.getBlob('owner', 'project', 'source')).content, 'PT0=');
});

test('uses per-request credentials for validation and Codeberg search response fields', async () => {
  const { client, calls } = createClient(({ path, query }) => {
    if (path === '/user') return { login: 'octavia' };
    if (path === '/repos/octavia/project') return { name: 'project', stars_count: 12 };
    if (path === '/user/repos') return [{ name: 'owned', stars_count: 7 }];
    if (path === '/repos/search') {
      assert.equal(query.q, 'Typst & notes');
      assert.equal(query.includeDesc, 'true');
      return { ok: true, data: [{ name: 'found', stars_count: 9 }] };
    }
    throw new Error(`Unexpected read: ${path}`);
  }, 'stored-token');

  assert.equal((await client.getProfile('candidate')).login, 'octavia');
  assert.equal((await client.getRepo('octavia', 'project', 'scoped')).stargazers_count, 12);
  assert.equal((await client.searchRepos(' Typst & notes '))[0].stargazers_count, 9);
  assert.equal((await client.searchRepos(''))[0].name, 'owned');
  assert.deepEqual(calls.map(call => call.headers.Authorization), ['token candidate', 'token scoped', 'token stored-token', 'token stored-token']);
  assert(calls.every(call => !call.headers['Content-Type'] && !Object.hasOwn(call.query, 'token')));
});

const changes = new Map([
  ['new.typ', { type: 'add', mode: '100644', bytes: encoder.encode('= 新規') }],
  ['edit.typ', { type: 'modify', mode: '100755', sha: 'original-edit', bytes: encoder.encode('= Edited') }],
  ['old.typ', { type: 'delete', mode: '100644', sha: 'original-delete' }],
]);

test('sends one atomic batch with blob preconditions and normalizes the pushed commit', async () => {
  const { client, calls } = createClient(({ method }) => method === 'GET'
    ? [{ ref: 'refs/heads/drafts/chapter', object: { sha: 'head' } }]
    : { commit: { sha: 'pushed', tree: { sha: 'new-tree' }, parents: [{ sha: 'head' }] },
        files: [{ path: 'new.typ', sha: 'new-blob' }, { path: 'edit.typ', sha: 'edited-blob' }, null] }, 'scoped');

  const result = await client.commitFiles('owner', 'project', 'drafts/chapter', 'Update draft', 'head', changes);
  assert.deepEqual(calls.map(call => [call.method, call.path]), [
    ['GET', '/repos/owner/project/git/refs/heads/drafts/chapter'], ['POST', '/repos/owner/project/contents'],
  ]);
  assert.deepEqual(calls[1].body, {
    branch: 'drafts/chapter', message: 'Update draft',
    files: [
      { operation: 'create', path: 'new.typ', content: Buffer.from('= 新規').toString('base64') },
      { operation: 'update', path: 'edit.typ', sha: 'original-edit', content: Buffer.from('= Edited').toString('base64') },
      { operation: 'delete', path: 'old.typ', sha: 'original-delete' },
    ],
  });
  assert.equal(calls[1].headers['Content-Type'], 'application/json');
  assert.equal(result.sha, 'pushed');
  assert.equal(result.treeSha, 'new-tree');
  assert.equal(result.parentSha, 'head');
  assert.deepEqual(Array.from(result.treeEntries, ({ path, mode, sha }) => [path, mode, sha]), [
    ['new.typ', '100644', 'new-blob'], ['edit.typ', '100755', 'edited-blob'], ['old.typ', '100644', null],
  ]);
  assert.equal(changes.size, 3);
});

test('commits a tracked rename as one move and retains the old entry mode', async () => {
  const { client, calls } = createClient(({ method }) => method === 'GET'
    ? [{ ref: 'refs/heads/main', object: { sha: 'head' } }]
    : { commit: { sha: 'pushed', tree: { sha: 'tree' }, parents: [{ sha: 'head' }] },
        files: [{ path: 'scripts/new.sh', sha: 'moved-blob' }] }, 'scoped');
  const result = await client.commitFiles('owner', 'project', 'main', 'Move script', 'head', new Map([
    ['old.sh', { type: 'delete', mode: '100755', sha: 'original' }],
    ['scripts/new.sh', { type: 'add', renameFrom: 'old.sh', bytes: encoder.encode('exit 0') }],
  ]));

  assert.deepEqual(calls[1].body.files, [
    { operation: 'update', path: 'scripts/new.sh', from_path: 'old.sh', sha: 'original', content: 'ZXhpdCAw' },
  ]);
  assert.deepEqual(Array.from(result.treeEntries, ({ path, mode, sha }) => [path, mode, sha]), [
    ['old.sh', '100755', null], ['scripts/new.sh', '100755', 'moved-blob'],
  ]);
});

test('does not write after a changed branch, project or account', async () => {
  let token = 'scoped';
  const moved = createClient(() => [{ ref: 'refs/heads/main', object: { sha: 'other' } }], token);
  await assert.rejects(moved.client.commitFiles('owner', 'project', 'main', 'Update', 'head', changes), { status: 409 });
  assert.equal(moved.calls.length, 1);

  let resolveRead;
  const delayed = createClient(() => new Promise(resolve => { resolveRead = resolve; }), () => token);
  const pending = delayed.client.commitFiles('owner', 'project', 'main', 'Update', 'head', changes);
  token = 'another-token';
  resolveRead([{ ref: 'refs/heads/main', object: { sha: 'head' } }]);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(delayed.calls.length, 1);

  const changedProject = createClient(() => [{ ref: 'refs/heads/main', object: { sha: 'head' } }], token);
  await assert.rejects(changedProject.client.commitFiles('owner', 'project', 'main', 'Update', 'head', changes, () => false), { name: 'AbortError' });
  assert.equal(changedProject.calls.length, 1);
});

test('surfaces a server-side batch conflict and requires an original blob for updates', async () => {
  const { client, calls } = createClient(({ method }) => method === 'GET'
    ? [{ ref: 'refs/heads/main', object: { sha: 'head' } }]
    : Response.json({ message: 'File SHA does not match' }, { status: 409 }), 'scoped');
  await assert.rejects(client.commitFiles('owner', 'project', 'main', 'Update', 'head', changes), {
    status: 409, message: 'File SHA does not match',
  });
  await assert.rejects(client.commitFiles('owner', 'project', 'main', 'Update', 'head', new Map([
    ['edit.typ', { type: 'modify', bytes: encoder.encode('= Edited') }],
  ])), /original Codeberg blob/);
  assert.equal(calls.length, 2);
});
