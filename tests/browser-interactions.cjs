'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const server = http.createServer((req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204).end(); return; }
  const file = path.join(root, req.url === '/' ? 'index.html' : req.url);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
  let body = fs.readFileSync(file);
  if (file.endsWith('app.js')) body = body.toString().replace(/  boot\(\)\.catch\(err => \{[\s\S]*?\n  \}\);\n\}\)\(\);\s*$/, `
    cacheElements(); loadTheme(); bindEvents();
    window.testApp = { state, els, ensureMonaco, ensureTypstRuntime, compilePreview, openFile, openFileAtOffset,
      schedulePreviewSourceAnchorIndexing, settleEditorLayout };
  })();`);
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
  res.end(body);
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}), headless: true });
  const timeout = setTimeout(() => browser.close(), 120000);
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 960 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.stack));
    page.on('console', msg => { if (msg.type() === 'error') console.log('CONSOLE', msg.text()); });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    console.log('Loaded local application');
    await page.evaluate(async () => {
      const { state, els, ensureMonaco, ensureTypstRuntime, openFile, compilePreview } = testApp;
      els['home-view'].classList.add('hidden'); els['editor-view'].classList.remove('hidden');
      await Promise.all([ensureMonaco(), ensureTypstRuntime()]);
      console.log('Editor and compiler ready');
      state.repo = { owner: { login: 'fixture' }, name: 'project' };
      state.mainPath = 'main.typ';
      state.compilerHydrated = true;
      const files = {
        'main.typ': '#set page(width: 595pt, height: 842pt)\n#include "sections/chapter.typ"',
        'sections/chapter.typ': Array.from({ length: 180 }, (_, i) => '// Comment ' + i).join('\n') + '\n= Chapter\n\nThis uniquely identifiable sentence lives deep inside the chapter.\n\nAnother distinct paragraph is placed here for a repeated navigation test.\n',
      };
      for (const [name, text] of Object.entries(files)) {
        const bytes = new TextEncoder().encode(text);
        state.fileIndex.set(name, { path: name, existing: true, size: bytes.length });
        state.fileBytes.set(name, bytes); state.originalBytes.set(name, bytes);
        state.sourceTextCache.set(name, text);
        await $typst.mapShadow('/repo/' + name, bytes);
      }
      await openFile('main.typ');
      await compilePreview();
    });
    await page.waitForFunction(() => testApp.state.previewSvgCache.pages.some(p => p.group));
    const text = page.locator('#preview-output .typst-text').filter({ hasText: 'This uniquely identifiable sentence' });
    await text.click();
    await page.waitForTimeout(450);
    const navigation = await page.evaluate(() => ({
      path: testApp.state.openPath, position: testApp.state.editor.getPosition(), scroll: testApp.state.editor.getScrollTop(),
      visible: testApp.state.editor.getVisibleRanges().map(r => [r.startLineNumber, r.endLineNumber]),
      selected: testApp.state.editor.getModel().getValueInRange(testApp.state.editor.getSelection()),
    }));
    assert.equal(navigation.path, 'sections/chapter.typ');
    assert.equal(navigation.position.lineNumber, 183);
    assert(navigation.visible.some(([start, end]) => start <= 183 && end >= 183), 'The selected source sentence must stay visible after layout frames.');
    assert.equal(navigation.selected, 'This uniquely identifiable sentence lives deep inside the chapter.');
    console.log('PASS preview click selects and reveals line 183 in an included file');
    // Repeated navigation within the same file must not replace its model or
    // clear undo history. A source edit and its undo remain possible.
    await page.evaluate(() => {
      const editor = testApp.state.editor;
      window.originalModel = editor.getModel();
      window.originalText = editor.getValue();
      editor.executeEdits('test', [{ range: new monaco.Range(1, 1, 1, 1), text: '// edit\n' }]);
      editor.pushUndoStop();
    });
    await text.click();
    await page.waitForTimeout(450);
    assert(await page.evaluate(() => {
      const editor = testApp.state.editor;
      const same = editor.getModel() === originalModel && editor.getModel().canUndo();
      editor.trigger('test', 'undo', null);
      return same && editor.getValue() === originalText;
    }), 'Source navigation must preserve the current model and undo history.');
    console.log('PASS repeated preview navigation preserves undo history');
    await page.keyboard.press('ControlOrMeta+f');
    const find = page.locator('.monaco-editor .find-widget');
    await find.waitFor({ state: 'visible' });
    const close = find.locator('.codicon-widget-close');
    await find.getByRole('textbox', { name: 'Find', exact: true }).fill('sentence');
    await close.hover();
    await page.waitForTimeout(1500);
    assert(await page.evaluate(() => [...document.querySelectorAll('.monaco-hover')].some(e => e.textContent.includes('Close (Escape)'))), 'Exercise the close button while its tooltip is shown.');
    const box = await close.boundingBox();
    await page.mouse.click(box.x + box.width/2, box.y + box.height/2);
    await page.waitForTimeout(450);
    assert.equal(await find.getAttribute('aria-hidden'), 'true', 'A real mouse click must close Find even after hover.');
    assert(await page.evaluate(() => testApp.state.editor.hasTextFocus()));
    console.log('PASS Find closes with the mouse after the Escape tooltip appears');
    await page.keyboard.press('ControlOrMeta+f');
    await page.waitForFunction(() => document.querySelector('.find-widget').getAttribute('aria-hidden') === 'false');
    await page.keyboard.press('Escape');
    assert.equal(await find.getAttribute('aria-hidden'), 'true');
    // A clickable documentation hover must not become click-through.
    assert(await page.evaluate(() => {
      const popup = document.createElement('div');
      popup.className = 'context-view';
      popup.innerHTML = '<div class="monaco-hover compact"><a href="#">Documentation</a></div>';
      testApp.els['editor-container'].appendChild(popup);
      const interactive = getComputedStyle(popup.querySelector('a')).pointerEvents !== 'none';
      popup.remove(); return interactive;
    }));
    console.log('PASS Escape still closes Find and documentation links stay interactive');

    await page.evaluate(() => {
      const { editor } = testApp.state;
      const model = editor.getModel();
      editor.pushUndoStop();
      window.beforeThemeEdit = model.getValue();
      editor.executeEdits('test', [{ range: new monaco.Range(1, 1, 1, 1), text: '// theme test\n' }]);
      editor.pushUndoStop();
      editor.setSelection(new monaco.Selection(1, 4, 1, 9));
    });
    await page.waitForFunction(() => !testApp.state.compileTimer && !testApp.state.compileInFlight);
    await page.evaluate(() => {
      const { editor, compileSerial } = testApp.state;
      const model = editor.getModel();
      window.beforeTheme = { model, text: model.getValue(), selection: editor.getSelection(), compileSerial };
    });
    const theme = page.getByRole('button', { name: 'Light theme', exact: true });
    const editorTheme = page.locator('#editor-view').getByRole('button', { name: 'Light theme', exact: true });
    await editorTheme.focus();
    await page.keyboard.press('Space');
    assert.equal(await theme.getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#home-theme-btn').getAttribute('aria-pressed'), 'true');
    assert(await page.evaluate(() => {
      const { editor, compileSerial } = testApp.state;
      const { model, text, selection } = beforeTheme;
      return document.documentElement.dataset.theme === 'light' &&
        getComputedStyle(document.documentElement).colorScheme === 'light' &&
        getComputedStyle(editor.getDomNode().querySelector('.monaco-editor-background')).backgroundColor === 'rgb(255, 255, 255)' &&
        editor.getModel() === model && model.getValue() === text &&
        editor.getSelection().equalsSelection(selection) && model.canUndo() &&
        compileSerial === beforeTheme.compileSerial && !testApp.state.compileTimer;
    }));
    assert(await page.evaluate(() => {
      const { editor } = testApp.state;
      editor.trigger('test', 'undo', null);
      return editor.getValue() === beforeThemeEdit;
    }));
    await page.waitForFunction(() => !testApp.state.changes.size && !testApp.state.compileInFlight);
    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    assert.equal(await theme.getAttribute('aria-pressed'), 'true');
    await theme.focus();
    await page.keyboard.press('Enter');
    assert.equal(await theme.getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('#editor-theme-btn').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    assert.deepEqual(errors, []);
    console.log('PASS keyboard theme toggles share the persisted preference and preserve the model, selection and undo without compiling');
  } finally { clearTimeout(timeout); await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
