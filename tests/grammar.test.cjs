'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const workerPath = path.resolve(__dirname, '../grammar-worker.js');
const messages = [];
const self = { postMessage: message => messages.push(message) };
vm.runInNewContext(readFileSync(workerPath, 'utf8'), { self }, { filename: workerPath });

function request(text, id = 1) {
  self.onmessage({ data: { id, path: 'chapter.typ', text } });
  const reply = messages.pop();
  assert.equal(reply.id, id);
  return reply;
}

function corrections(source) {
  const { diagnostics, error } = request(source);
  assert.equal(error, undefined);
  return Array.from(diagnostics, issue => [source.slice(issue.start, issue.end), issue.replacement]);
}

test('returns local suggestions using UTF-16 offsets and preserves case', () => {
  const source = '📝 This is is a test. We IS ready. i could of done it. They has time.';
  const { diagnostics } = request(source, 42);
  assert.equal(diagnostics[0].start, source.indexOf(' is a test'));
  assert.deepEqual(corrections(source), [[' is', ''], ['IS', 'ARE'], ['i', 'I'], ['of', 'have'], ['has', 'have']]);
});

test('detects a repetition after a distinct word and leaves legitimate constructions alone', () => {
  assert.deepEqual(corrections('This is a a test in the the editor.'), [[' a', ''], [' the', '']]);
  assert.deepEqual(corrections('What it is is unclear. We should of course check. She and I are ready. The variable (i) is defined. “i” is a letter. i\u0301 uses a combining mark.'), []);
});

test('checks Typst headings, emphasis, nested markup and link labels', () => {
  const source = [
    '= The the heading',
    '*This is is a test.* _They has time._',
    '#let chapter = [We is ready. #emph[i will continue.]]',
    '#table([The the table], [This is is a row], "the the string")',
    '#link("https://example.com/the/the")[The the link]',
    'https://example.com/file the the nearby prose.',
  ].join('\n');
  assert.deepEqual(corrections(source), [[' the', ''], [' is', ''], ['has', 'have'], ['is', 'are'], ['i', 'I'], [' the', ''], [' is', ''], [' the', ''], [' the', '']]);
});

test('excludes comments, code strings, math, raw text, links and file paths', () => {
  const source = [
    '// the the',
    '/* the the /* i is */ the the */',
    '#let filename = "the the.typ"',
    '#let numbers = (i, i)',
    '#(if true { "we is" } else { "i are" })',
    '#if false { "the the" }',
    '$ i + "the the $" $',
    '`i is` and ```text\ni has\nthe the\n```',
    '#include "./the the.typ"',
    '#image("the the.png")',
    'See <the-the>, @the-the, https://example.com/the/the, "the the_version.typ" and "../the the/notes".',
    'The the final line.',
  ].join('\n');
  assert.deepEqual(corrections(source), [[' the', '']]);
});

test('caps large diagnostic lists and handles malformed worker messages', () => {
  assert.equal(request('This is is a test. '.repeat(500)).diagnostics.length, 200);
  assert.match(request(undefined).error, /document text/);
  assert.deepEqual(corrections('The the report. #let unfinished = "the the'), [[' the', '']]);
});
