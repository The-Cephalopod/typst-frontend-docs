# Regression checks

Run from the repository root with Node.js 18 or later. No dependencies or build step are required:

```sh
node tests/data.test.cjs
node tests/startup.test.cjs
node --check app.js
```

The tests evaluate the actual `app.js` in a Node VM with startup disabled, minimal DOM doubles and controlled GitHub, Monaco and Typst responses. They cover shared dependency startup, retries, bounded import discovery, cache isolation, overlapping editor/data loading and cancellation when routes change.

These are behavior regression tests. They do not execute the real CDN libraries, WebAssembly compiler, browser rendering or GitHub API, and they do not measure browser loading performance. Browser, visual, accessibility and real compilation checks remain separate.
