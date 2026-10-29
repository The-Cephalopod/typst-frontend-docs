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
      const { $typst } = await import(RUNTIME_URL);
      $typst.setCompilerInitOptions({ getModule: () => COMPILER_WASM_URL });
      $typst.setRendererInitOptions({ getModule: () => RENDERER_WASM_URL });
      // Warm both modules before the first edit or SVG conversion.
      const [compiler] = await Promise.all([$typst.getCompiler(), $typst.getRenderer()]);
      return { runtime: $typst, compiler };
    })();
  }
  return enginePromise;
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

// Split the pinned renderer's SVG without constructing a DOM in the worker.
// Unexpected structure returns null so callers can retain full-SVG rendering.
function splitSvgPages(svg) {
  if (typeof svg !== 'string') return null;
  const stack = [];
  const ranges = [];
  let position = 0, openingEnd = -1, closingStart = -1, closingEnd = -1, pageStart = -1;
  while (position < svg.length) {
    const start = svg.indexOf('<', position);
    if (start < 0) break;
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
    let end = start + 1, quote = '';
    for (; end < svg.length; end++) {
      const character = svg[end];
      if (quote) { if (character === quote) quote = ''; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === '>') break;
    }
    if (end === svg.length) return null;
    const tag = svg.slice(start, end + 1);
    const match = /^<\/?([A-Za-z_][\w:.-]*)/.exec(tag);
    if (!match) return null;
    const name = match[1];
    const closing = tag[1] === '/';
    const selfClosing = /\/\s*>$/.test(tag);
    if (closing) {
      if (!/^<\/[^\s>]+\s*>$/.test(tag) || stack.pop() !== name) return null;
      if (stack.length === 1 && pageStart >= 0) {
        ranges.push([pageStart, end + 1]);
        pageStart = -1;
      }
      if (stack.length === 0) { closingStart = start; closingEnd = end + 1; break; }
    } else {
      if (stack.length === 0) {
        if (name !== 'svg' || openingEnd >= 0 || svg.slice(0, start).trim()) return null;
        openingEnd = end + 1;
      } else if (stack.length === 1 && name === 'g') {
        const attributes = tag.slice(match[0].length, selfClosing ? -2 : -1);
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
  const parts = splitSvgPages(svg);
  if (!parts) { lastPreviewParts = null; return { svg, svgParts: null, diagnostics }; }
  const previous = lastPreviewParts;
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

const methods = {
  async init() {
    await getEngine();
    return { compilerReady: true, rendererReady: true };
  },
  async reset() {
    const { compiler } = await getEngine();
    await compiler.reset();
    return true;
  },
  async resetShadow() {
    const { compiler } = await getEngine();
    compiler.resetShadow();
    lastPreviewParts = null;
    return true;
  },
  async mapShadow(args) {
    if (typeof args?.path !== 'string' || !(args.bytes instanceof Uint8Array)) {
      throw new TypeError('A path and Uint8Array are required.');
    }
    const { compiler } = await getEngine();
    return compiler.mapShadow(args.path, args.bytes) !== false;
  },
  async unmapShadow(args) {
    if (typeof args?.path !== 'string') throw new TypeError('A path is required.');
    const { compiler } = await getEngine();
    return compiler.unmapShadow(args.path) !== false;
  },
  async compile(args) {
    const { compiler } = await getEngine();
    const result = await compiler.compile(compileOptions(args));
    return { result: result?.result, diagnostics: cloneDiagnostics(result?.diagnostics) };
  },
  async svg(args) {
    if (!(args?.vectorData instanceof Uint8Array)) throw new TypeError('Vector data is required.');
    const { runtime } = await getEngine();
    return runtime.svg({ vectorData: args.vectorData });
  },
  async compilePreview(args) {
    const { compiler, runtime } = await getEngine();
    const result = await compiler.compile(compileOptions(args));
    const diagnostics = cloneDiagnostics(result?.diagnostics);
    // Keep the potentially large vector artifact inside this worker.
    const svg = result?.result ? await runtime.svg({ vectorData: result.result }) : null;
    return packagePreview(svg, diagnostics, args);
  },
  async pdf(args) {
    const { compiler } = await getEngine();
    // The convenience pdf wrapper resets compiler caches; native format 1
    // exports the same document while retaining the current compilation state.
    const result = await compiler.compile(compileOptions(args, 1));
    if (!(result?.result instanceof Uint8Array)) {
      const error = new Error('Typst could not export the PDF.');
      error.diagnostics = cloneDiagnostics(result?.diagnostics);
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
