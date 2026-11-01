# Regression checks

Run from the repository root with Node.js 18 or later. No dependencies or build step are required:

```sh
node --test tests/*.test.cjs
node --check app.js
node --check typst-worker.js
```

The tests evaluate the actual `app.js` in a Node VM with startup disabled, minimal DOM doubles and controlled GitHub, Monaco and Typst responses. They cover shared dependency startup, retries, bounded import discovery, cache isolation, overlapping editor/data loading and cancellation when routes change.

These 48 behavior checks cover data loading, startup, editor synchronization, SVG transport, input scheduling and worker failures. They verify that keystrokes never read the entire editor or synchronously call the compiler, continuous input cannot postpone the 16 ms preview deadline, and a worker failure cannot enable compilation on the input thread.

The VM checks do not execute CDN libraries, WebAssembly or browser rendering. The separate browser check does:

```sh
npm install --no-save playwright
npx playwright install chromium
node tests/browser-performance.cjs
node tests/browser-interactions.cjs
```

Alternatively set `BROWSER_CHANNEL=msedge` to use an installed Microsoft Edge. The app itself remains dependency-free and needs no build step. Playwright is only a test dependency. The test serves the source on a temporary localhost port and uses a fresh headless browser with the real pinned Monaco/Typst CDN modules and fonts. It does not connect to a GitHub account or modify any repository.

The fixture is approximately 413 KB of Typst source producing 90 pages. The test records 40 typing samples and eight isolated-edit preview samples, then checks viewport mounting, unchanged-page reuse, scrolling, zoom, navigation in both directions, PDF export, syntax recovery, changing page counts and project reset.

`browser-interactions.cjs` binds the application's real event handlers and clicks rendered text in a project with an included file. It checks that line 183 remains visible after deferred layout, repeated preview clicks preserve undo history, a real mouse click closes Find while its Escape tooltip is present, keyboard Escape still closes Find, and tooltips containing documentation links remain interactive. This catches viewport and hit-testing bugs that checking the selected text alone cannot detect.

Optional environment variables:

- `PERF_ARTIFACT_DIR`: save `measurements.json` and `preview.png` in this directory.
- `TYPST_APP_DIR`: test another extracted source directory.
- `BASELINE=1`: measure an older version without asserting the new virtualization behavior.
- `QUICK=1`: skip timing loops while running browser correctness checks.

The typing metric runs from the page's keydown handler to the second animation frame. It is a conservative browser paint proxy, not an operating-system input-to-photon measurement. Preview timing includes Playwright dispatch, the compile deadline, real WASM compilation/SVG rendering, DOM mounting, readiness polling and two animation frames. The browser suite asserts correctness and bounded mounted content, not machine-specific millisecond limits.
