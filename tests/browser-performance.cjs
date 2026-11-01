const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const root = path.resolve(process.env.TYPST_APP_DIR || path.join(__dirname, '..'));
const baseline = process.env.BASELINE === '1';
const output = process.env.PERF_ARTIFACT_DIR;
const summary = {};
const server = http.createServer((req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204).end(); return; }
  const file = path.join(root, req.url.split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0]);
  if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
  let body = fs.readFileSync(file);
  if (file.endsWith('app.js')) body = body.toString().replace(/  boot\(\)\.catch\(err => \{[\s\S]*?\n  \}\);\n\}\)\(\);\s*$/, `
    cacheElements();
    window.testApp = { state, els, ensureMonaco, ensureTypstRuntime, compilePreview, onEditorChanged,
      installPreviewSvg, normalizePreviewSvg, schedulePreviewSourceAnchorIndexing, setPreviewZoom,
      resetProjectState, handlePreviewClick, handleEditorPreviewClick,
      revealVirtualPreviewSource: typeof revealVirtualPreviewSource === 'function' ? revealVirtualPreviewSource : null };
  })();`);
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
  res.end(body);
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}), headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 960 } });
    page.on('console', msg => { if (['error', 'warning'].includes(msg.type())) console.log(msg.type(), msg.text().slice(0, 600)); });
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.stack));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(async () => {
      const { state, els, ensureMonaco, ensureTypstRuntime } = testApp;
      els['home-view'].classList.add('hidden'); els['editor-view'].classList.remove('hidden');
      await Promise.all([ensureMonaco(), ensureTypstRuntime()]);
      state.repo = { owner: { login: 'fixture' }, name: 'project' };
      state.mainPath = state.openPath = 'main.typ';
      state.compilerHydrated = true;
      const source = '#set page(width: 595pt, height: 842pt)\n' + Array.from({ length: 45 }, (_, i) => `= Page ${i+1}\n\n` + 'A sentence for a realistic long document with repeated text. '.repeat(150)).join('\n#pagebreak()\n');
      state.suppressEditorChange = true;
      state.editor.setValue(source);
      state.suppressEditorChange = false;
      state.fileIndex.set('main.typ', { existing: true, size: source.length });
      state.originalBytes.set('main.typ', new TextEncoder().encode(source));
      window.longTasks = [];
      new PerformanceObserver(list => longTasks.push(...list.getEntries().map(e => ({ start: e.startTime, duration: e.duration })))).observe({ type: 'longtask', buffered: false });
      testApp.onEditorChanged({});
    });
    const settled = async () => {
      await page.waitForFunction(() => testApp.state.previewSvgCache && !testApp.state.compileTimer && !testApp.state.compileInFlight &&
        testApp.state.previewSvgCache.pages.some(p => p.group) &&
        testApp.state.previewSvgCache.pages.every(p => !p.visible || p.raw === p.mountedRaw));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    };
    await settled();
    summary.initial = await page.evaluate(() => ({ worker: typeof $typst.compilePreview === 'function', pages: testApp.state.previewSvgCache?.pages.length, nodes: document.querySelectorAll('#preview-output *').length, longTasks }));
    console.log('INITIAL', JSON.stringify(summary.initial));
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      longTasks = [];
      testApp.state.editor.setPosition({ lineNumber: 4, column: 1 });
      testApp.state.editor.focus();
      window.inputTimes = [];
      document.addEventListener('keydown', e => {
        const start = performance.now();
        requestAnimationFrame(() => requestAnimationFrame(() => inputTimes.push(performance.now() - start)));
      });
    });
    for (let i = 0; i < (process.env.QUICK ? 0 : 40); i++) { await page.keyboard.type('x'); await page.waitForTimeout(45); }
    await settled();
    await page.waitForTimeout(1000);
    summary.typing = await page.evaluate(() => ({ inputTimes, longTasks, status: document.querySelector('#compile-status').textContent, sourceLength: testApp.state.editor.getValue().length }));
    console.log('TYPING', JSON.stringify(summary.typing));
    summary.previewTimes = [];
    for (let i = 0; i < (process.env.QUICK ? 0 : 8); i++) {
      await page.evaluate(() => { window.previewStart = performance.now(); });
      await page.keyboard.type('q');
      await settled();
      summary.previewTimes.push(await page.evaluate(() => performance.now() - previewStart));
    }
    console.log('PREVIEW', JSON.stringify(summary.previewTimes));
    if (output) {
      fs.mkdirSync(output, { recursive: true });
      await page.screenshot({ path: path.join(output, 'preview.png') });
    }
    if (!baseline) {
      assert.equal(summary.initial.worker, true);
      assert.equal(summary.initial.pages, 90);
      assert(summary.initial.nodes < 30000, 'Off-screen glyphs must not enter the DOM.');
      // Reinstalling an identical snapshot must preserve visible SVG objects.
      assert(await page.evaluate(() => {
        const cache = testApp.state.previewSvgCache;
        const group = cache.pages[0].group;
        testApp.installPreviewSvg('', { opening: cache.opening, prefix: cache.prefix, suffix: cache.suffix, closing: '</svg>', pages: cache.pages.map(p => p.raw) });
        return cache.pages[0].group === group;
      }));
      // Jump to the end: old pages must unmount, and the final page must render.
      await page.evaluate(() => testApp.state.previewSvgCache.pages.at(-1).node.scrollIntoView());
      await page.waitForFunction(() => testApp.state.previewSvgCache.pages.at(-1).group && !testApp.state.previewSvgCache.pages[0].group);
      assert(await page.evaluate(() => document.querySelectorAll('#preview-output *').length < 30000));
      await page.evaluate(() => testApp.setPreviewZoom(0.4));
      await page.waitForTimeout(150);
      assert(await page.evaluate(() => testApp.state.previewSvgCache.pages.filter(p => p.group).length < 8));
      await page.evaluate(() => { testApp.setPreviewZoom(1.5); testApp.state.previewSvgCache.pages[0].node.scrollIntoView(); });
      await page.waitForFunction(() => testApp.state.previewSvgCache.pages[0].group);
      // Source navigation must find an unmounted middle page and mount it.
      await page.evaluate(async () => {
        const offset = testApp.state.editor.getValue().indexOf('Page 20');
        await testApp.revealVirtualPreviewSource('main.typ', offset);
      });
      await page.waitForFunction(() => document.querySelector('.source-jump-highlight')?.textContent.includes('Page 20'));
      assert(await page.evaluate(async () => {
        const target = document.querySelector('.source-jump-highlight');
        await testApp.handlePreviewClick({ target, preventDefault() {} });
        return testApp.state.editor.getModel().getValueInRange(testApp.state.editor.getSelection()) === 'Page 20';
      }), 'Preview text must still navigate to the editor source.');
      // PDF uses the scoped compiler world, independently of mounted pages.
      const pdf = await page.evaluate(async () => {
        const bytes = await $typst.pdf({ mainFilePath: '/repo/main.typ', root: '/repo', diagnostics: 'full' });
        return { header: new TextDecoder().decode(bytes.slice(0, 5)), size: bytes.length };
      });
      assert.equal(pdf.header, '%PDF-'); assert(pdf.size > 1000);
      // Syntax errors retain the last good document; fixing them recovers.
      await page.evaluate(() => {
        window.goodSource = testApp.state.editor.getValue();
        window.goodCache = testApp.state.previewSvgCache;
        testApp.state.editor.setValue('#let broken = (');
      });
      await page.waitForFunction(() => !testApp.state.compileInFlight && testApp.state.diagnostics.length > 0);
      assert(await page.evaluate(() => testApp.state.previewSvgCache === goodCache));
      await page.evaluate(() => testApp.state.editor.setValue('= One page\n\nRecovered.'));
      await settled();
      assert.equal(await page.evaluate(() => testApp.state.previewSvgCache.pages.length), 1);
      await page.evaluate(() => testApp.state.editor.setValue('= One page\n#pagebreak()\n= Second page'));
      await settled();
      assert.equal(await page.evaluate(() => testApp.state.previewSvgCache.pages.length), 2);
      await page.evaluate(() => { testApp.state.repositoryLoadSerial++; testApp.resetProjectState(); });
      await page.waitForTimeout(100);
      assert(await page.evaluate(() => testApp.state.previewPageObserver === null && testApp.state.previewMountTimer === null && !testApp.els['preview-output'].childNodes.length));
      console.log('PASS visible pages, reuse, scrolling, zoom, off-screen source navigation, PDF, syntax recovery, page count changes and reset');
    }
    assert.deepEqual(pageErrors, []);
    if (output) fs.writeFileSync(path.join(output, 'measurements.json'), JSON.stringify(summary, null, 2));
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
