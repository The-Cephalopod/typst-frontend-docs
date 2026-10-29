'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const workerPath = path.resolve(__dirname, '../typst-worker.js');
// Evaluate the real splitter without initializing the CDN runtime or a Worker.
const context = vm.createContext({ self: {} });
vm.runInContext(fs.readFileSync(workerPath, 'utf8') + '\nglobalThis.split = splitSvgPages; globalThis.packageSvg = packagePreview;', context, { filename: workerPath });
const split = context.split;
const opening = '<svg class="typst-doc" viewBox="0 0 100 200" xmlns="http://www.w3.org/2000/svg">';
const page = (id, content = '') => `<g class="typst-page" data-tid="${id}" data-page-width="100" data-page-height="100">${content}</g>`;
const join = parts => parts.opening + parts.prefix + parts.pages.join('') + parts.suffix + parts.closing;

function nestedGraphicsAndSharedDefinitionsRemainIntact() {
  const prefix = '<defs class="glyph"><symbol id="glyph"><g><path d="M0 0Z"/></g></symbol></defs>';
  const first = page('one', '<g data-note="a > b"><svg viewBox="0 0 20 20"><g><image href="data:image/svg+xml;base64,PHN2Zy8+"/></g></svg><use href="#glyph"/></g>');
  const second = page('two', '<foreignObject><h5:div xmlns:h5="http://www.w3.org/1999/xhtml">Text &lt; escaped</h5:div></foreignObject>');
  const svg = opening + prefix + first + '\n ' + second + '</svg>\n';
  const parts = split(svg);
  assert(parts);
  assert.equal(parts.opening, opening);
  assert.equal(parts.prefix, prefix);
  assert.equal(parts.pages.length, 2, 'Nested groups and SVG roots must not become separate document pages.');
  assert.equal(parts.pages[0], first + '\n ');
  assert.equal(parts.pages[1], second);
  assert.equal(join(parts), svg, 'Splitting must preserve every original character.');
}

function pageClassIsReadFromItsOwnAttribute() {
  const prefix = '<g data-note=\'class="typst-page"\'><path d="M0 0"/></g>';
  const real = '<g data-title="quoted > delimiter" class=\'extra typst-page selected\'><g class="typst-page">nested</g></g>';
  const svg = opening + prefix + real + '</svg>';
  const parts = split(svg);
  assert(parts);
  assert.equal(parts.pages.length, 1);
  assert.equal(parts.prefix, prefix, 'Class-like text in another attribute must not identify a page.');
  assert.equal(parts.pages[0], real);
  assert.equal(join(parts), svg);
}

function scriptsStylesCommentsAndCdataDoNotAlterDepth() {
  const prefix = '<style><![CDATA[.example::after { content: "<g class=typst-page>"; }]]></style>' +
    '<!-- <g class="typst-page"> --><?fixture processing?>';
  const content = '<![CDATA[<g class="typst-page">text > text</g>]]><path data-label=\'single > quote\'/>';
  const suffix = '<script><![CDATA[if (a < b) { let text = "<g>"; }]]></script>';
  const svg = opening + prefix + page('one', content) + suffix + '</svg>';
  const parts = split(svg);
  assert(parts);
  assert.equal(parts.pages.length, 1);
  assert.equal(parts.prefix, prefix);
  assert.equal(parts.suffix, suffix);
  assert.equal(join(parts), svg);
}

function emptyPagesAndMalformedFallback() {
  const svg = opening + '<g class="typst-page"/>' + '</svg>';
  const parts = split(svg);
  assert(parts);
  assert.equal(parts.pages[0], '<g class="typst-page"/>');
  assert.equal(join(parts), svg);
  for (const malformed of [
    '', null, '<svg><g/></svg>',
    opening + '<g class="typst-page"><path></g></svg>',
    opening + '<g class="typst-page" data-value="unclosed></g></svg>',
    opening + '<g class="typst-page">unclosed',
    opening + page('one') + '<!-- unclosed</svg>',
    opening + page('one') + '<![CDATA[unclosed</svg>',
    opening + page('one') + '<script>unclosed</svg>',
    '<!DOCTYPE svg>' + opening + page('one') + '</svg>',
    opening + page('one') + '<defs/>' + page('two') + '</svg>',
    opening + page('one') + '</svg><svg/>',
  ]) {
    assert.equal(split(malformed), null, `Unexpected markup must keep full-SVG fallback: ${String(malformed).slice(0, 100)}`);
  }
}

function largeUnchangedPagesAreStableAcrossEdits() {
  const pages = Array.from({ length: 45 }, (_, i) => page(String(i), '<g><path d="M0 0L1 1"/></g>'.repeat(200)));
  const before = split(opening + '<defs/>' + pages.join('') + '</svg>');
  pages[22] = page('22', '<g><path d="M1 1L2 2"/></g>');
  const after = split(opening + '<defs/>' + pages.join('') + '</svg>');
  assert(before && after);
  assert.equal(after.pages.length, 45);
  assert.equal(after.pages.filter((source, i) => source !== before.pages[i]).length, 1,
    'Editing one page must leave every other page source reusable.');
}

function transportSendsOnlyChangedPagesForAMatchingRevision() {
  const pages = Array.from({ length: 45 }, (_, i) => page(`p${i}`, `<text>Page ${i}</text>`));
  const svg = opening + '<defs/>' + pages.join('') + '</svg>';
  const first = context.packageSvg(svg, [], { partsOnly: true });
  assert.equal(first.svg, null);
  assert.equal(first.svgParts.pages.length, 45);
  pages[20] = page('changed', '<text>One changed page</text>');
  const edited = opening + '<defs/>' + pages.join('') + '</svg>';
  const update = context.packageSvg(edited, [], { partsOnly: true, baseRevision: first.svgParts.revision });
  assert.equal(update.svg, null);
  assert.equal(update.svgDelta.pageCount, 45);
  assert.equal(update.svgDelta.patches.length, 1);
  assert.equal(update.svgDelta.patches[0].index, 20);
  assert.equal(update.svgDelta.patches[0].svg, pages[20]);
  assert(JSON.stringify(update).length < JSON.stringify(first).length / 4, 'A single-page edit should not clone all 45 page strings.');
  const missed = context.packageSvg(edited, [], { partsOnly: true, baseRevision: first.svgParts.revision });
  assert(missed.svgParts && !missed.svgDelta, 'A mismatched revision must send a complete snapshot.');
}

function transportRetainsSuccessfulBaseAcrossSyntaxErrorsAndHandlesFallback() {
  const svg = opening + page('stable') + '</svg>';
  const first = context.packageSvg(svg, [], { partsOnly: true });
  const invalid = context.packageSvg(null, [{ message: 'syntax error' }], { partsOnly: true });
  assert.equal(invalid.svg, null);
  const corrected = context.packageSvg(svg, [], { partsOnly: true, baseRevision: first.svgParts.revision });
  assert.equal(corrected.svgDelta.patches.length, 0, 'A syntax error must not discard the last usable transport base.');
  const unrecognized = '<svg><path d="M0 0"/></svg>';
  const fallback = context.packageSvg(unrecognized, [], { partsOnly: true, baseRevision: corrected.svgDelta.revision });
  assert.equal(fallback.svg, unrecognized);
  assert.equal(fallback.svgParts, null);
  const recovered = context.packageSvg(svg, [], { partsOnly: true, baseRevision: corrected.svgDelta.revision });
  assert(recovered.svgParts, 'An unknown layout must recover with a full known-layout snapshot.');
}

function transportHandlesPageInsertionAndRemoval() {
  const svg = items => opening + items.join('') + '</svg>';
  const initial = [page('one'), page('two')];
  const first = context.packageSvg(svg(initial), [], { partsOnly: true });
  const inserted = context.packageSvg(svg([...initial, page('three')]), [], { partsOnly: true, baseRevision: first.svgParts.revision });
  assert.equal(inserted.svgDelta.pageCount, 3);
  assert.equal(inserted.svgDelta.patches.length, 1);
  assert.equal(inserted.svgDelta.patches[0].index, 2);
  const removed = context.packageSvg(svg([initial[0]]), [], { partsOnly: true, baseRevision: inserted.svgDelta.revision });
  assert.equal(removed.svgDelta.pageCount, 1);
  assert.equal(removed.svgDelta.patches.length, 0, 'Removing trailing pages only needs a new page count.');
}

const tests = [nestedGraphicsAndSharedDefinitionsRemainIntact, pageClassIsReadFromItsOwnAttribute,
  scriptsStylesCommentsAndCdataDoNotAlterDepth, emptyPagesAndMalformedFallback,
  largeUnchangedPagesAreStableAcrossEdits, transportSendsOnlyChangedPagesForAMatchingRevision,
  transportRetainsSuccessfulBaseAcrossSyntaxErrorsAndHandlesFallback, transportHandlesPageInsertionAndRemoval];
for (const test of tests) { test(); console.log(`PASS ${test.name}`); }
console.log(`${tests.length} SVG page-splitting checks passed. These test structure and fallback behavior, not browser rendering.`);
