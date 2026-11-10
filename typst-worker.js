/* Keep synchronous Typst WebAssembly work away from the editor's UI thread. */
'use strict';

// The pinned browser bundle assigns its exports to window at module load.
// Its compiler and string-SVG renderer do not require a DOM.
globalThis.window = globalThis;

const RUNTIME_URL = 'https://cdn.jsdelivr.net/npm/@myriaddreamin/typst.ts@0.8.0-rc3/dist/esm/contrib/all-in-one-lite.bundle.js';
const COMPILER_WASM_URL = 'https://cdn.jsdelivr.net/npm/@myriaddreamin/typst-ts-web-compiler@0.8.0-rc3/pkg/typst_ts_web_compiler_bg.wasm';
const RENDERER_WASM_URL = 'https://cdn.jsdelivr.net/npm/@myriaddreamin/typst-ts-renderer@0.8.0-rc3/pkg/typst_ts_renderer_bg.wasm';
let enginePromise;

function getEngine() {
  if (!enginePromise) {
    enginePromise = (async () => {
      const { $typst, loadFonts } = await import(RUNTIME_URL);
      const defaultFontUrls = [];
      $typst.setCompilerInitOptions({
        getModule: () => COMPILER_WASM_URL,
        beforeBuild: [loadFonts([], { assets: ['text'], fetcher: url => {
          defaultFontUrls.push(url);
          return fetch(url);
        } })],
      });
      $typst.setRendererInitOptions({ getModule: () => RENDERER_WASM_URL });
      // Warm both modules before the first edit or SVG conversion.
      const [compiler, renderer] = await Promise.all([$typst.getCompiler(), $typst.getRenderer()]);
      return { runtime: $typst, compiler, renderer, defaultFontUrls };
    })();
  }
  return enginePromise;
}

// Keep source writes and font registration on the same worker queue. Rebuild
// the resolver only when a font changes, never while processing ordinary edits.
const REPOSITORY_FONT = /\.(?:ttf|otf|ttc|otc|woff2?)$/i;
const MAX_REPOSITORY_FONT_BYTES = 25 * 1024 * 1024;
let repositoryFonts = new Map();
let appliedFonts = new Map();
let fontsChanged = false;
let customFontsInstalled = false;
let fontDiagnostics = [];

function setRepositoryFont(path, bytes) {
  if (!REPOSITORY_FONT.test(path)) return;
  const previous = repositoryFonts.get(path) || appliedFonts.get(path);
  // A fallback hydration can map the same assets again. Reuse the installed
  // resolver when its contents are unchanged.
  const font = bytes.byteLength > MAX_REPOSITORY_FONT_BYTES ? null : bytes;
  if (previous !== font && !(previous && font && previous.length === font.length && previous.every((byte, i) => byte === font[i]))) {
    repositoryFonts.set(path, font);
  } else {
    repositoryFonts.set(path, previous);
  }
  fontsChanged = true;
}

async function updateRepositoryFonts({ compiler, defaultFontUrls }) {
  if (repositoryFonts.size === appliedFonts.size && [...repositoryFonts].every(([path, bytes]) => appliedFonts.get(path) === bytes)) {
    fontsChanged = false;
    return;
  }
  const diagnostics = [];
  const builder = new compiler.compilerJs.TypstFontResolverBuilder();
  let consumed = false;
  let registered = 0;
  try {
    for (const path of [...repositoryFonts.keys()].sort()) {
      const bytes = repositoryFonts.get(path);
      try {
        if (!bytes) throw new Error('Use a font file under 25 MB.');
        const info = builder.get_font_info(bytes);
        if (!info?.info?.length) throw new Error('Replace it with a valid TrueType or OpenType font.');
        // Let Typst copy the font into WASM only when the document uses it.
        builder.add_lazy_font(info, () => bytes);
        registered++;
      } catch (error) {
        diagnostics.push({ path, severity: 'warning', message: `Could not load repository font. ${error?.message || 'Replace it with a valid TrueType or OpenType font.'}` });
      }
    }

    if (registered || customFontsInstalled) {
      // Use the same bundled defaults as startup. These versioned assets were
      // just loaded by this worker and can be reused from the browser cache.
      const defaults = await Promise.all(defaultFontUrls.map(async url => {
        const response = await fetch(url, { cache: 'force-cache' });
        if (!response.ok) throw new Error(`Could not reload Typst's default fonts (${response.status}). Check your connection and retry.`);
        return new Uint8Array(await response.arrayBuffer());
      }));
      for (const bytes of defaults) builder.add_raw_font(bytes);
      consumed = true;
      const resolver = await builder.build();
      try {
        await closeIncrementalPreview();
        compiler.setFonts(resolver);
      } finally { resolver.free(); }
    }
    customFontsInstalled = registered > 0;
    fontDiagnostics = diagnostics;
    appliedFonts = new Map(repositoryFonts);
    fontsChanged = false;
  } finally { if (!consumed) builder.free(); }
}

function compileDiagnostics(diagnostics) {
  const result = cloneDiagnostics(diagnostics);
  return fontDiagnostics.length ? [...fontDiagnostics, ...result] : result;
}

function cloneDiagnostics(diagnostics) {
  if (!Array.isArray(diagnostics)) return [];
  try { return JSON.parse(JSON.stringify(diagnostics)); }
  catch {
    return diagnostics.map(item => ({
      severity: String(item?.severity || 'error'),
      message: String(item?.message || item),
    }));
  }
}

function compileOptions(args, format = 0) {
  const options = args?.options || {};
  if (typeof options.mainFilePath !== 'string') throw new TypeError('A main file path is required.');
  return {
    mainFilePath: options.mainFilePath,
    ...(typeof options.root === 'string' ? { root: options.root } : {}),
    ...(options.inputs ? { inputs: options.inputs } : {}),
    diagnostics: options.diagnostics || 'full',
    // CompileFormatEnum.vector = 0, CompileFormatEnum.pdf = 1 in 0.8.0-rc3.
    format,
  };
}

function compileDocument(compiler, args, format = 0) {
  const options = compileOptions(args, format);
  // The pinned compiler.compile() creates a WASM world without explicitly
  // freeing it. Scope each snapshot so a long editing session doesn't retain
  // old documents until the garbage collector happens to finalize them.
  return compiler.runWithWorld(options, world => format === 1 ? world.pdf(options) : world.vector(options));
}

// Split the pinned renderer's SVG without constructing a DOM in the worker.
// Unexpected structure returns null so callers can retain full-SVG rendering.
function splitSvgPages(svg, previousPages = []) {
  if (typeof svg !== 'string') return null;
  // Scan whole tags in the native regexp engine, including quoted delimiters.
  const tag = /<\/?([A-Za-z_][\w:.-]*)[^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/y;
  const closingTail = /[^\s>]*\s*>/y;
  const whitespace = /\s/;
  const stack = [];
  const ranges = [];
  let position = 0, openingEnd = -1, closingStart = -1, closingEnd = -1, pageStart = -1;
  while (position < svg.length) {
    const start = svg.indexOf('<', position);
    if (start < 0) break;
    // The preceding render already validated these exact page bytes. Only
    // reuse them at the root level, where a new page can actually start.
    if (stack.length === 1) {
      const previous = previousPages[ranges.length]?.trimEnd();
      if (previous && svg.startsWith(previous, start)) {
        position = start + previous.length;
        ranges.push([start, position]);
        continue;
      }
    }
    if (svg.startsWith('<!--', start)) {
      const end = svg.indexOf('-->', start + 4);
      if (end < 0) return null;
      position = end + 3;
      continue;
    }
    if (svg.startsWith('<![CDATA[', start)) {
      const end = svg.indexOf(']]>', start + 9);
      if (end < 0) return null;
      position = end + 3;
      continue;
    }
    if (svg.startsWith('<?', start)) {
      const end = svg.indexOf('?>', start + 2);
      if (end < 0) return null;
      position = end + 2;
      continue;
    }
    if (svg.startsWith('<!', start)) return null;
    tag.lastIndex = start;
    const match = tag.exec(svg);
    if (!match) return null;
    const end = tag.lastIndex - 1;
    const closing = svg[start + 1] === '/';
    const name = match[1];
    const nameEnd = start + (closing ? 2 : 1) + name.length;
    if (closing) {
      if (nameEnd !== end) {
        closingTail.lastIndex = nameEnd;
        if (!closingTail.test(svg) || closingTail.lastIndex !== end + 1) return null;
      }
      if (stack.pop() !== name) return null;
      if (stack.length === 1 && pageStart >= 0) {
        ranges.push([pageStart, end + 1]);
        pageStart = -1;
      }
      if (stack.length === 0) { closingStart = start; closingEnd = end + 1; break; }
    } else {
      let tail = end - 1;
      while (whitespace.test(svg[tail])) tail--;
      const selfClosing = svg[tail] === '/';
      if (stack.length === 0) {
        if (name !== 'svg' || openingEnd >= 0 || svg.slice(0, start).trim()) return null;
        openingEnd = end + 1;
      } else if (stack.length === 1 && name === 'g') {
        const attributes = svg.slice(nameEnd, selfClosing ? end - 1 : end);
        let offset = 0, page = false;
        while (offset < attributes.length) {
          const attribute = /^\s+([A-Za-z_][\w:.-]*)\s*=\s*(["'])([\s\S]*?)\2/.exec(attributes.slice(offset));
          if (!attribute) {
            if (attributes.slice(offset).trim()) return null;
            break;
          }
          if (attribute[1] === 'class') page = attribute[3].split(/\s+/).includes('typst-page');
          offset += attribute[0].length;
        }
        if (page) {
          if (selfClosing) ranges.push([start, end + 1]);
          else pageStart = start;
        }
      }
      if (!selfClosing) {
        stack.push(name);
        // CSS and JavaScript can contain literal '<' characters. Their text is
        // irrelevant to page boundaries; retain it byte-for-byte in shared data.
        if (name === 'style' || name === 'script') {
          const rawEnd = svg.indexOf(`</${name}`, end + 1);
          if (rawEnd < 0) return null;
          position = rawEnd;
          continue;
        }
      }
    }
    position = end + 1;
  }
  if (stack.length || closingStart < 0 || !ranges.length || svg.slice(closingEnd).trim()) return null;
  for (let i = 1; i < ranges.length; i++) {
    if (svg.slice(ranges[i - 1][1], ranges[i][0]).trim()) return null;
  }
  return {
    opening: svg.slice(0, openingEnd),
    prefix: svg.slice(openingEnd, ranges[0][0]),
    pages: ranges.map(([start, end], i) => svg.slice(start, i + 1 < ranges.length ? ranges[i + 1][0] : end)),
    suffix: svg.slice(ranges[ranges.length - 1][1], closingStart),
    closing: svg.slice(closingStart),
  };
}

let lastPreviewParts = null;
let previewRevision = 0;

function packagePreview(svg, diagnostics, args = {}) {
  if (!svg) return { svg: null, svgParts: null, diagnostics };
  const previous = lastPreviewParts;
  const parts = splitSvgPages(svg, previous?.pages);
  if (!parts) { lastPreviewParts = null; return { svg, svgParts: null, diagnostics }; }
  lastPreviewParts = { ...parts, revision: ++previewRevision };
  if (!args.partsOnly) return { svg, svgParts: lastPreviewParts, diagnostics };
  if (previous && args.baseRevision === previous.revision) {
    const patches = [];
    for (let index = 0; index < parts.pages.length; index++) {
      if (parts.pages[index] !== previous.pages[index]) patches.push({ index, svg: parts.pages[index] });
    }
    return { svg: null, diagnostics, svgDelta: {
      opening: parts.opening, prefix: parts.prefix, suffix: parts.suffix, closing: parts.closing,
      baseRevision: previous.revision, revision: lastPreviewParts.revision,
      pageCount: parts.pages.length, patches,
    } };
  }
  // A new project, a dropped response or a mismatched base needs a full snapshot.
  return { svg: null, svgParts: lastPreviewParts, diagnostics };
}

const MAX_INCREMENTAL_DELTA_BYTES = 32 * 1024 * 1024;
const INCREMENTAL_DIAGNOSTIC_FORMATS = new Map([['none', 1], ['unix', 2], ['full', 3]]);
let incrementalPreview = null;
let incrementalPreviewDisabled = false;

async function closeIncrementalPreview() {
  const previous = incrementalPreview;
  incrementalPreview = null;
  if (previous) {
    previous.release();
    await previous.closed.catch(() => {});
  }
}

async function incrementalSessionFor(compiler, renderer, identity) {
  if (incrementalPreview?.identity === identity && incrementalPreview.deltaBytes < MAX_INCREMENTAL_DELTA_BYTES) {
    return incrementalPreview;
  }
  await closeIncrementalPreview();
  const server = compiler.create_incr_server();
  let release, ready, failed;
  const held = new Promise(resolve => { release = resolve; });
  const session = new Promise((resolve, reject) => { ready = resolve; failed = reject; });
  // Keep the renderer session alive until the matching compiler server is
  // replaced. runWithSession frees it on exit and we release the server too.
  const closed = Promise.resolve().then(() => renderer.runWithSession(async renderSession => {
    ready(renderSession);
    await held;
  })).finally(() => server.free());
  closed.catch(failed);
  incrementalPreview = { identity, server, session, release, closed, hasVector: false, deltaBytes: 0 };
  return incrementalPreview;
}

async function compileIncrementalPreview(compiler, renderer, args) {
  const options = compileOptions(args);
  const inputs = options.inputs ? Object.entries(options.inputs) : undefined;
  const identity = JSON.stringify([options.root, options.mainFilePath, inputs]);
  const preview = await incrementalSessionFor(compiler, renderer, identity);
  const session = await preview.session;
  // The high-level incremental compile wrapper doesn't free its world.
  // Use the pinned WASM bindings to release every source snapshot explicitly.
  const world = compiler.snapshot(options.root, options.mainFilePath, inputs);
  let result;
  try {
    const diagnosticsFormat = INCREMENTAL_DIAGNOSTIC_FORMATS.get(options.diagnostics) ?? 3;
    result = world.incr_compile(preview.server, diagnosticsFormat);
  } finally {
    world.free();
  }
  const diagnostics = compileDiagnostics(result?.diagnostics);
  // An invalid document has no delta. Keep the last valid renderer state.
  if (!result?.result) return packagePreview(null, diagnostics, args);
  session.manipulateData({ action: preview.hasVector ? 'merge' : 'reset', data: result.result });
  if (preview.hasVector) preview.deltaBytes += result.result.byteLength;
  preview.hasVector = true;
  const svg = await session.renderSvg({});
  return packagePreview(svg, diagnostics, args);
}

const methods = {
  async init() {
    await getEngine();
    return { compilerReady: true, rendererReady: true };
  },
  async reset() {
    const { compiler } = await getEngine();
    await closeIncrementalPreview();
    await compiler.reset();
    return true;
  },
  async resetShadow() {
    const { compiler } = await getEngine();
    await closeIncrementalPreview();
    compiler.resetShadow();
    if (repositoryFonts.size) {
      repositoryFonts.clear();
      fontsChanged = true;
    }
    lastPreviewParts = null;
    return true;
  },
  async mapShadow(args) {
    if (typeof args?.path !== 'string' || !(args.bytes instanceof Uint8Array)) {
      throw new TypeError('A path and Uint8Array are required.');
    }
    const { compiler } = await getEngine();
    if (compiler.mapShadow(args.path, args.bytes) === false) return false;
    setRepositoryFont(args.path, args.bytes);
    return true;
  },
  async unmapShadow(args) {
    if (typeof args?.path !== 'string') throw new TypeError('A path is required.');
    const { compiler } = await getEngine();
    if (compiler.unmapShadow(args.path) === false) return false;
    if (repositoryFonts.delete(args.path)) fontsChanged = true;
    return true;
  },
  async compile(args) {
    const engine = await getEngine();
    const { compiler } = engine;
    if (fontsChanged) await updateRepositoryFonts(engine);
    const result = await compileDocument(compiler, args);
    return { result: result?.result, diagnostics: compileDiagnostics(result?.diagnostics) };
  },
  async svg(args) {
    if (!(args?.vectorData instanceof Uint8Array)) throw new TypeError('Vector data is required.');
    const { runtime } = await getEngine();
    return runtime.svg({ vectorData: args.vectorData });
  },
  async compilePreview(args) {
    const engine = await getEngine();
    const { compiler, renderer, runtime } = engine;
    if (fontsChanged) await updateRepositoryFonts(engine);
    const nativeCompiler = compiler.compiler;
    if (!incrementalPreviewDisabled && typeof nativeCompiler?.create_incr_server === 'function' &&
        typeof nativeCompiler.snapshot === 'function' && typeof renderer?.runWithSession === 'function') {
      try {
        return await compileIncrementalPreview(nativeCompiler, renderer, args);
      } catch {
        // A failed merge may have advanced one half of the pair. Release
        // both and retry with a complete snapshot for this worker's lifetime.
        incrementalPreviewDisabled = true;
        await closeIncrementalPreview();
      }
    }
    const result = await compileDocument(compiler, args);
    const diagnostics = compileDiagnostics(result?.diagnostics);
    // Keep the potentially large vector artifact inside this worker.
    const svg = result?.result ? await runtime.svg({ vectorData: result.result }) : null;
    return packagePreview(svg, diagnostics, args);
  },
  async pdf(args) {
    const engine = await getEngine();
    const { compiler } = engine;
    if (fontsChanged) await updateRepositoryFonts(engine);
    // The convenience pdf wrapper resets compiler caches; native format 1
    // exports the same document while retaining the current compilation state.
    const result = await compileDocument(compiler, args, 1);
    if (!(result?.result instanceof Uint8Array)) {
      const error = new Error('Typst could not export the PDF.');
      error.diagnostics = compileDiagnostics(result?.diagnostics);
      throw error;
    }
    return result.result;
  },
};

let tasks = Promise.resolve();
self.onmessage = event => {
  const { id, method, args } = event.data || {};
  // Serialize compilation, exports and shadow-file updates on one compiler.
  tasks = tasks.then(async () => {
    try {
      if (!Object.prototype.hasOwnProperty.call(methods, method)) {
        throw new TypeError('Unknown Typst worker operation.');
      }
      const result = await methods[method](args);
      // This is freshly exported worker-owned PDF data. Input file buffers
      // are always cloned by the caller so application caches stay attached.
      const transfer = method === 'pdf' ? [result.buffer] : [];
      self.postMessage({ id, result }, transfer);
    } catch (error) {
      self.postMessage({ id, error: {
        name: String(error?.name || 'Error'),
        message: String(error?.message || error),
        ...(error?.diagnostics ? { diagnostics: cloneDiagnostics(error.diagnostics) } : {}),
      } });
    }
  });
};
