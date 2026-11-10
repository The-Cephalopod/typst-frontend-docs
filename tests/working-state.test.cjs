'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const context = vm.createContext({ window: {} });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../working-state.js'), 'utf8'), context);
const { changeGroups, splitLines, lineHunks, mergeText, remoteMoves } = context.window.TypstWorkingState;

test('line hunks reconstruct the new file and retain terminators', () => {
  const base = splitLines('first\r\nrepeat\nrepeat\nthird\nlast');
  const updated = splitLines('first\r\nrepeat\nsecond\nthird\nnew\nlast\n');
  const hunks = lineHunks(base, updated);
  let cursor = 0;
  const result = [];
  for (const hunk of hunks) {
    result.push(...base.slice(cursor, hunk.start), ...hunk.lines);
    cursor = hunk.end;
  }
  result.push(...base.slice(cursor));
  assert.equal(result.join(''), updated.join(''));
});

test('three-way merge combines independent additions, edits, and deletions', () => {
  const original = 'a\r\nb\r\nc\r\nd\r\ne';
  const local = 'local\r\na\r\nb\r\nC\r\nd\r\ne';
  const remote = 'a\r\nc\r\nd\r\ne\r\n';
  assert.equal(mergeText(original, local, remote), 'local\r\na\r\nC\r\nd\r\ne\r\n');
});

test('three-way merge deduplicates identical edits and signals conflicts', () => {
  assert.equal(mergeText('one\ntwo\n', 'ONE\ntwo\n', 'ONE\nTWO\n'), 'ONE\nTWO\n');
  assert.equal(mergeText('one\ntwo\n', 'one\nlocal\n', 'one\nremote\n'), null);
  assert.equal(mergeText('line\n', 'local\nline\n', 'remote\nline\n'), null);
});

test('file selection groups a rename onto a tracked destination', () => {
  const changes = new Map([
    ['old.typ', { type: 'delete' }],
    ['renamed.typ', { type: 'modify', renameFrom: 'old.typ' }],
    ['unselected.png', { type: 'add' }],
  ]);
  assert.deepEqual(Array.from(changeGroups(changes), group => [group.type, ...group.paths]), [
    ['rename', 'old.typ', 'renamed.typ'], ['add', 'unselected.png'],
  ]);
});

test('rename inference uses an unambiguous deleted and added blob pair', () => {
  const blob = { sha: 'same', mode: '100644' };
  const base = new Map([['original.txt', blob], ['unchanged.txt', blob]]);
  const remote = new Map([['unchanged.txt', blob], ['renamed.txt', blob]]);
  assert.deepEqual([...remoteMoves(base, remote)].map(pair => [...pair]), [['original.txt', 'renamed.txt']]);
  remote.set('copy.txt', blob);
  assert.equal(remoteMoves(base, remote).size, 0);
});
