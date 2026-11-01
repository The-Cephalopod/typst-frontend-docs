# Editor latency fix

The preview now mounts SVG content only for pages near the viewport. Off-screen pages keep their exact dimensions as lightweight placeholders. This removes the large document's glyph DOM from the browser's typing/layout/paint workload while preserving scrolling, zoom, source navigation and PDF export.

Other changes:

- Compile and render exclusively in a Web Worker. If initialization fails, the editor stays usable and the preview reports the error; a later compile can retry. There is no silent main-thread WebAssembly fallback.
- Start a preview batch after 16 ms, reduced from 40 ms. Continued typing keeps the original deadline and coalesces changes during compilation.
- Update dirty indicators once when a file becomes dirty instead of on every keystroke.
- Mount one visible page per event-loop task and reuse unchanged page DOM and shared glyph definitions.
- Scope compiler snapshots with the pinned runtime's `runWithWorld` API so old WASM worlds are explicitly released.
- Resolve jumps to off-screen pages on demand, yielding during the search and cancelling if typing resumes.

## Measured comparison

Tested on November 1, 2026 using headless Microsoft Edge, the actual Monaco and Typst WASM dependencies, and the same local fixture before and after the fix. The fixture contains approximately 413 KB of source and produces 90 pages. Startup/download time is excluded from the edit measurements.

| Metric | Original ZIP | Updated source |
| --- | ---: | ---: |
| Typing paint proxy, 40 samples | 300–403 ms | 15–23 ms |
| Isolated edit to settled preview, 8 samples | 1,132–1,266 ms | 308–345 ms |
| Initial preview DOM elements | 450,977 | 10,235 |
| Main-thread tasks over 50 ms during typing run | 50 | 0 |

The typing metric measures keydown to the second animation frame. Preview timing includes browser-driver dispatch, compilation, SVG rendering, DOM mounting, polling and two animation frames. These are measured browser proxies on a synthetic long document, not a guarantee of identical latency on every device or document. Very complex individual pages still require browser rendering work.

## Validation and use

All 48 VM behavior checks and JavaScript syntax checks pass. The real-browser suite also passes viewport mounting, unchanged-page reuse, scrolling, zoom, source navigation in both directions, PDF export, syntax-error recovery, page insertion/removal and project reset. See `tests/README.md` for commands and metric definitions; raw measurements are in `tests/measurements/`.

Deploy this folder using the same static hosting setup as before. Replace `app.js`, `styles.css` and `typst-worker.js` together, and reload the site. Keep `typst-worker.js` served alongside `app.js` over HTTP/HTTPS. No application build or new runtime dependency is required. The included `.assetsignore` keeps tests and documentation out of the deployed assets.
