/* Typst Git Editor
 * Static client-side GitHub + Typst editor.
 * GitHub tokens never pass through an application server.
 */

(() => {
  'use strict';

  const API_VERSION = '2026-03-10';
  const STORAGE = {
    recents: 'typstgit.recents.v1',
    token: 'typstgit.githubToken',
    theme: 'typstgit.theme',
    fontSize: 'typstgit.editorFontSize',
  };
  const MAX_PROJECT_BYTES = 80 * 1024 * 1024;
  const MAX_SINGLE_BLOB_BYTES = 25 * 1024 * 1024;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: false });

  const TEXT_EXTENSIONS = new Set([
    'typ','txt','md','markdown','json','csv','yaml','yml','toml','xml','html','css','js','mjs','cjs','ts','tsx','jsx',
    'py','rs','go','java','c','h','cpp','hpp','sh','ps1','bat','ini','conf','bib','gitignore','gitattributes','lock','svg'
  ]);
  const IMAGE_EXTENSIONS = new Set(['png','jpg','jpeg','gif','webp','svg','bmp','avif']);
  const FONT_EXTENSIONS = new Set(['ttf','otf','woff','woff2']);
  const DATA_EXTENSIONS = new Set(['json','csv','yaml','yml','toml','xml','bib']);

  const $ = (id) => document.getElementById(id);
  const els = {};
  const state = {
    token: null,
    profile: null,
    repo: null,
    branch: null,
    branches: [],
    headSha: null,
    baseTreeSha: null,
    rawTree: [],
    fileIndex: new Map(),
    fileBytes: new Map(),
    fileRequests: new Map(),
    originalBytes: new Map(),
    sourceTextCache: new Map(),
    changes: new Map(),
    pathsCache: null,
    typPathsCache: null,
    treeCache: null,
    fileTreeRows: new Map(),
    fileTreeRenderTimer: null,
    editorSyncTimer: null,
    editorSyncPending: false,
    editorSyncPath: null,
    shadowSyncPromise: null,
    shadowSyncTail: Promise.resolve(),
    openPath: null,
    mainPath: null,
    deletedPaths: new Set(),
    expandedFolders: new Set(),
    compilerHydrated: false,
    compilerHydrating: false,
    compilerHydrationPromise: null,
    compilerHydrationTail: Promise.resolve(),
    compilerReady: false,
    editor: null,
    editorInitPromise: null,
    runtimeInitPromise: null,
    workerDisabled: false,
    repositoryLoadSerial: 0,
    editorModel: null,
    suppressEditorChange: false,
    monaco: null,
    editorResizeObserver: null,
    editorLayoutFrame: 0,
    compileTimer: null,
    compileDueAt: 0,
    compileSerial: 0,
    compileInFlight: false,
    compileQueued: false,
    compilePromise: null,
    editRevision: 0,
    compilerNeedsReset: true,
    previewZoom: 1,
    previewFit: false,
    previewSvgCache: null,
    promptResolver: null,
    activeModal: null,
    diagnostics: [],
    sourceSearchOrder: [],
    previewLastJump: null,
    previewSourceAnchors: [],
    previewAnchorMap: new WeakMap(),
    previewHighlightTimer: null,
    previewIndexGeneration: 0,
    previewIndexHandle: null,
    previewIndexStartTimer: null,
    imagePasteResolver: null,
    imagePasteContext: null,
  };

  class GitHubClient {
    constructor(getToken) { this.getToken = getToken; }

    async request(path, options = {}) {
      const headers = {
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': API_VERSION,
        ...(options.headers || {}),
      };
      const token = this.getToken();
      if (token) headers.Authorization = `Bearer ${token}`;
      if (options.body && typeof options.body !== 'string') {
        headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(options.body);
      }
      const response = await fetch(`https://api.github.com${path}`, { ...options, headers });
      let data = null;
      if (response.status !== 204) {
        const text = await response.text();
        try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      }
      if (!response.ok) {
        const message = data?.message || `GitHub request failed (${response.status})`;
        const err = new Error(message);
        err.status = response.status;
        err.data = data;
        throw err;
      }
      return data;
    }

    getProfile() { return this.request('/user'); }
    getRepo(owner, repo) { return this.request(`/repos/${enc(owner)}/${enc(repo)}`); }
    getBranches(owner, repo) { return this.request(`/repos/${enc(owner)}/${enc(repo)}/branches?per_page=100`); }
    getRef(owner, repo, branch) {
      const ref = `heads/${branch.split('/').map(encodeURIComponent).join('/')}`;
      return this.request(`/repos/${enc(owner)}/${enc(repo)}/git/ref/${ref}`);
    }
    getCommit(owner, repo, sha) { return this.request(`/repos/${enc(owner)}/${enc(repo)}/git/commits/${sha}`); }
    getTree(owner, repo, treeSha) { return this.request(`/repos/${enc(owner)}/${enc(repo)}/git/trees/${treeSha}?recursive=1`); }
    getBlob(owner, repo, sha) { return this.request(`/repos/${enc(owner)}/${enc(repo)}/git/blobs/${sha}`); }
    createBlob(owner, repo, bytes) {
      return this.request(`/repos/${enc(owner)}/${enc(repo)}/git/blobs`, {
        method: 'POST', body: { content: bytesToBase64(bytes), encoding: 'base64' }
      });
    }
    createTree(owner, repo, baseTree, entries) {
      return this.request(`/repos/${enc(owner)}/${enc(repo)}/git/trees`, {
        method: 'POST', body: { base_tree: baseTree, tree: entries }
      });
    }
    createCommit(owner, repo, message, treeSha, parentSha) {
      return this.request(`/repos/${enc(owner)}/${enc(repo)}/git/commits`, {
        method: 'POST', body: { message, tree: treeSha, parents: [parentSha] }
      });
    }
    updateRef(owner, repo, branch, sha) {
      const ref = `heads/${branch.split('/').map(encodeURIComponent).join('/')}`;
      return this.request(`/repos/${enc(owner)}/${enc(repo)}/git/refs/${ref}`, {
        method: 'PATCH', body: { sha, force: false }
      });
    }
    async searchRepos(query) {
      const q = query.trim();
      if (!q && state.token) {
        return this.request('/user/repos?sort=updated&direction=desc&per_page=18&affiliation=owner,collaborator,organization_member');
      }
      if (!q) return [];
      const result = await this.request(`/search/repositories?q=${encodeURIComponent(`${q} in:name,description`)}&sort=updated&order=desc&per_page=18`);
      return result.items || [];
    }
  }

  const github = new GitHubClient(() => state.token);

  function enc(s) { return encodeURIComponent(s); }
  function ext(path) {
    const name = path.split('/').pop() || '';
    if (name.startsWith('.') && !name.slice(1).includes('.')) return name.slice(1).toLowerCase();
    const i = name.lastIndexOf('.');
    return i < 0 ? '' : name.slice(i + 1).toLowerCase();
  }
  function basename(path) { return path.split('/').pop() || path; }
  function dirname(path) { const i = path.lastIndexOf('/'); return i < 0 ? '' : path.slice(0, i); }
  function normalizeRepoPath(path) {
    return String(path || '').trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/{2,}/g, '/');
  }
  function resolveProjectPath(path) {
    const parts = String(path || '').replace(/\\/g, '/').split('/');
    const out = [];
    for (const part of parts) {
      if (!part || part === '.') continue;
      if (part === '..') out.pop();
      else out.push(part);
    }
    return out.join('/');
  }
  function resolveTypstReference(fromPath, reference) {
    const ref = String(reference || '').trim();
    if (!ref || ref.startsWith('@') || /^[a-z]+:\/\//i.test(ref)) return '';
    if (ref.startsWith('/')) return resolveProjectPath(ref.slice(1));
    const base = dirname(fromPath);
    return resolveProjectPath(base ? `${base}/${ref}` : ref);
  }
  function relativeProjectPath(fromDir, targetPath) {
    const from = resolveProjectPath(fromDir).split('/').filter(Boolean);
    const target = resolveProjectPath(targetPath).split('/').filter(Boolean);
    let i = 0;
    while (i < from.length && i < target.length && from[i] === target[i]) i++;
    const parts = [...Array(from.length - i).fill('..'), ...target.slice(i)];
    return parts.join('/') || basename(targetPath);
  }
  function escapeHtml(value) {
    return String(value).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  }
  function sameBytes(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  function bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }
  function base64ToBytes(base64) {
    const clean = String(base64 || '').replace(/\s/g, '');
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 ** 2) return `${(n/1024).toFixed(1)} KB`;
    return `${(n/1024/1024).toFixed(1)} MB`;
  }
  function timeAgo(iso) {
    if (!iso) return 'Recently opened';
    const seconds = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    const units = [[31536000,'y'],[2592000,'mo'],[86400,'d'],[3600,'h'],[60,'m']];
    for (const [size,label] of units) if (seconds >= size) return `${Math.floor(seconds/size)}${label} ago`;
    return 'just now';
  }

  function cacheElements() {
    [
      'home-view','editor-view','connect-github-btn','github-account-label','home-theme-btn','open-repo-form','repo-url-input',
      'recent-projects','recent-empty','recent-search-input','github-search-form','github-search-input','github-search-results',
      'repo-owner-label','repo-name-label','repo-private-badge','repo-title-btn','branch-select','compile-status','refresh-repo-btn',
      'download-pdf-btn','commit-btn','change-count-badge','editor-account-btn','file-count-label','new-file-btn','upload-file-btn','upload-folder-btn',
      'rename-file-btn','delete-file-btn','file-search-input','file-tree','main-file-btn','main-file-label','upload-file-input','upload-folder-input',
      'sidebar-resizer','preview-resizer','code-pane','editor-container','binary-file-view','binary-file-name','binary-file-meta','download-binary-btn',
      'tab-file-icon','tab-file-name','tab-dirty-dot','editor-font-minus','editor-font-plus','preview-page-label','zoom-out-btn','zoom-reset-btn',
      'zoom-in-btn','fit-preview-btn','preview-scroll','preview-stage','preview-loading','preview-error','preview-error-text','diagnostic-summary','diagnostic-list','preview-output',
      'status-current-file','cursor-position','repo-sync-status','modal-backdrop','auth-modal','github-token-input','remember-token-checkbox',
      'auth-error','disconnect-github-btn','save-github-token-btn','commit-modal','commit-summary','commit-message-input','commit-error',
      'confirm-commit-btn','text-prompt-modal','text-prompt-kicker','text-prompt-title','text-prompt-label','text-prompt-input','text-prompt-error',
      'text-prompt-confirm','main-file-modal','main-file-list','image-paste-modal','image-paste-title','image-paste-destination',
      'image-paste-filename','image-paste-width','image-paste-caption','image-paste-kind-image','image-paste-kind-figure',
      'image-paste-error','image-paste-confirm','toast-root'
    ].forEach(id => els[id] = $(id));
  }

  async function boot() {
    cacheElements();
    loadTheme();
    loadToken();
    bindEvents();
    renderRecents();
    validateStoredToken();
    route();
  }

  function loadTheme() {
    const saved = localStorage.getItem(STORAGE.theme) || 'dark';
    document.documentElement.dataset.theme = saved;
    els['home-theme-btn'] && (els['home-theme-btn'].textContent = saved === 'dark' ? '☾' : '☀');
  }
  function toggleTheme() {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem(STORAGE.theme, next);
    els['home-theme-btn'].textContent = next === 'dark' ? '☾' : '☀';
    if (state.editor && state.monaco) state.monaco.editor.setTheme(next === 'dark' ? 'typst-dark' : 'typst-light');
  }
  function loadToken() {
    state.token = sessionStorage.getItem(STORAGE.token) || localStorage.getItem(STORAGE.token) || null;
    updateAccountUI();
  }
  async function validateStoredToken() {
    if (!state.token) return;
    try {
      state.profile = await github.getProfile();
    } catch {
      clearToken();
    }
    updateAccountUI();
  }
  function saveToken(token, remember) {
    sessionStorage.removeItem(STORAGE.token);
    localStorage.removeItem(STORAGE.token);
    (remember ? localStorage : sessionStorage).setItem(STORAGE.token, token);
    state.token = token;
  }
  function clearToken() {
    sessionStorage.removeItem(STORAGE.token);
    localStorage.removeItem(STORAGE.token);
    state.token = null;
    state.profile = null;
    updateAccountUI();
  }
  function updateAccountUI() {
    const connected = Boolean(state.token && state.profile);
    els['connect-github-btn']?.classList.toggle('connected', connected);
    if (els['github-account-label']) els['github-account-label'].textContent = connected ? state.profile.login : (state.token ? 'Connecting…' : 'Connect GitHub');
    if (els['editor-account-btn']) els['editor-account-btn'].textContent = connected ? state.profile.login.slice(0,2).toUpperCase() : 'GH';
    els['disconnect-github-btn']?.classList.toggle('hidden', !state.token);
  }

  function bindEvents() {
    window.addEventListener('hashchange', route);
    window.addEventListener('beforeunload', (e) => {
      if (state.changes.size) { e.preventDefault(); e.returnValue = ''; }
    });
    els['home-theme-btn'].addEventListener('click', toggleTheme);
    els['connect-github-btn'].addEventListener('click', openAuthModal);
    els['editor-account-btn'].addEventListener('click', openAuthModal);
    els['open-repo-form'].addEventListener('submit', e => { e.preventDefault(); navigateToRepoInput(els['repo-url-input'].value); });
    els['recent-search-input'].addEventListener('input', renderRecents);
    els['github-search-form'].addEventListener('submit', handleGitHubSearch);
    els['repo-title-btn'].addEventListener('click', () => { if (state.repo) window.open(state.repo.html_url, '_blank', 'noopener'); });
    els['branch-select'].addEventListener('change', onBranchChange);
    els['refresh-repo-btn'].addEventListener('click', () => reloadCurrentRepo(true));
    els['download-pdf-btn'].addEventListener('click', exportPdf);
    els['commit-btn'].addEventListener('click', openCommitModal);
    els['file-search-input'].addEventListener('input', scheduleFileTreeRender);
    els['new-file-btn'].addEventListener('click', createNewFile);
    els['upload-file-btn'].addEventListener('click', () => els['upload-file-input'].click());
    els['upload-folder-btn'].addEventListener('click', () => els['upload-folder-input'].click());
    els['upload-file-input'].addEventListener('change', uploadFiles);
    els['upload-folder-input'].addEventListener('change', uploadFiles);
    els['rename-file-btn'].addEventListener('click', renameSelectedFile);
    els['delete-file-btn'].addEventListener('click', deleteSelectedFile);
    els['main-file-btn'].addEventListener('click', openMainFileModal);
    els['download-binary-btn'].addEventListener('click', downloadCurrentBinary);
    els['editor-font-minus'].addEventListener('click', () => changeEditorFont(-1));
    els['editor-font-plus'].addEventListener('click', () => changeEditorFont(1));
    els['zoom-out-btn'].addEventListener('click', () => setPreviewZoom(state.previewZoom - .1));
    els['zoom-in-btn'].addEventListener('click', () => setPreviewZoom(state.previewZoom + .1));
    els['zoom-reset-btn'].addEventListener('click', () => setPreviewZoom(1));
    els['fit-preview-btn'].addEventListener('click', fitPreviewWidth);
    els['save-github-token-btn'].addEventListener('click', connectGitHub);
    els['disconnect-github-btn'].addEventListener('click', () => { clearToken(); closeModal(); toast('GitHub account disconnected.'); });
    els['confirm-commit-btn'].addEventListener('click', commitChanges);
    els['text-prompt-confirm'].addEventListener('click', resolveTextPrompt);
    els['text-prompt-input'].addEventListener('keydown', e => { if (e.key === 'Enter') resolveTextPrompt(); });
    els['image-paste-confirm'].addEventListener('click', resolveImagePastePrompt);
    els['image-paste-filename'].addEventListener('keydown', e => { if (e.key === 'Enter') resolveImagePastePrompt(); });
    els['image-paste-width'].addEventListener('keydown', e => { if (e.key === 'Enter') resolveImagePastePrompt(); });
    els['image-paste-kind-image'].addEventListener('change', updateImagePasteCaptionState);
    els['image-paste-kind-figure'].addEventListener('change', updateImagePasteCaptionState);
    document.querySelectorAll('[data-close-modal]').forEach(btn => btn.addEventListener('click', closeModal));
    els['modal-backdrop'].addEventListener('click', e => { if (e.target === els['modal-backdrop']) closeModal(); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && state.activeModal) closeModal();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (!els['editor-view'].classList.contains('hidden')) openCommitModal();
      }
    });
    els['preview-output'].addEventListener('click', handlePreviewClick);
    els['editor-container'].addEventListener('paste', handleEditorImagePaste, true);
    setupResizer(els['sidebar-resizer'], 'sidebar');
    setupResizer(els['preview-resizer'], 'preview');
  }


  function scheduleEditorLayout() {
    if (!state.editor) return;
    if (state.editorLayoutFrame) cancelAnimationFrame(state.editorLayoutFrame);
    state.editorLayoutFrame = requestAnimationFrame(() => {
      state.editorLayoutFrame = 0;
      if (!state.editor || els['editor-container'].classList.contains('hidden')) return;
      const rect = els['editor-container'].getBoundingClientRect();
      const width = Math.floor(rect.width);
      const height = Math.floor(rect.height);
      if (width <= 0 || height <= 0) return;
      state.editor.layout({ width, height });
    });
  }

  function settleEditorLayout(resetScroll = false) {
    scheduleEditorLayout();
    requestAnimationFrame(() => {
      scheduleEditorLayout();
      if (resetScroll && state.editor) {
        state.editor.setScrollTop(0);
        state.editor.setScrollLeft(0);
      }
    });
  }

  // Only editor routes need these large, version-pinned CDN dependencies.
  // Share startup across route changes and allow a failed download to be retried.
  function loadScript(src, type = '') {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      if (type) script.type = type;
      const finish = (err) => {
        clearTimeout(timer);
        script.onload = script.onerror = null;
        if (err) { script.remove(); reject(err); }
        else resolve();
      };
      const timer = setTimeout(() => finish(new Error('Editor dependency timed out. Check the browser network connection.')), 60000);
      script.onload = () => finish();
      script.onerror = () => finish(new Error('Editor dependency did not load. Check the browser network connection or content-blocking settings.'));
      document.head.appendChild(script);
    });
  }

  function ensureMonaco() {
    if (state.editor) return Promise.resolve();
    if (!state.editorInitPromise) {
      state.editorInitPromise = initMonaco().catch(err => {
        state.editorInitPromise = null;
        throw err;
      });
    }
    return state.editorInitPromise;
  }

  async function initMonaco() {
    if (!window.require) await loadScript('https://cdn.jsdelivr.net/npm/monaco-editor@0.56.0/min/vs/loader.js');
    if (!window.require) throw new Error('Monaco loader did not load.');
    window.require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.56.0/min/vs' } });
    await new Promise((resolve, reject) => {
      window.require(['vs/editor/editor.main'], resolve, reject);
    });
    state.monaco = window.monaco;
    registerTypstLanguage();
    registerTypstPathCompletion();
    defineMonacoThemes();
    const fontSize = Math.max(11, Math.min(22, Number(localStorage.getItem(STORAGE.fontSize) || 14)));
    document.documentElement.style.setProperty('--editor-font-size', `${fontSize}px`);
    state.editor = state.monaco.editor.create(els['editor-container'], {
      value: '',
      language: 'typst',
      theme: document.documentElement.dataset.theme === 'dark' ? 'typst-dark' : 'typst-light',
      automaticLayout: false,
      minimap: { enabled: false },
      fontSize,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
      fontLigatures: true,
      lineHeight: 21,
      tabSize: 2,
      insertSpaces: true,
      wordWrap: 'on',
      smoothScrolling: true,
      scrollBeyondLastLine: false,
      padding: { top: 12, bottom: 12 },
      renderWhitespace: 'selection',
      cursorBlinking: 'smooth',
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: true, indentation: true },
      suggest: { showWords: true },
    });
    state.editor.onDidChangeModelContent(e => onEditorChanged(e));
    state.editor.onDidChangeCursorPosition(e => {
      els['cursor-position'].textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
    });
    state.editor.onMouseUp(handleEditorPreviewClick);

    // Monaco's automaticLayout can lag behind CSS-grid/resizer changes, especially
    // with word wrapping. Keep its measured viewport tied to the actual visible host.
    if (window.ResizeObserver) {
      state.editorResizeObserver?.disconnect?.();
      state.editorResizeObserver = new ResizeObserver(() => scheduleEditorLayout());
      const resizeTargets = [els['editor-container'], els['code-pane']].filter(el => el instanceof Element);
      resizeTargets.forEach(el => state.editorResizeObserver.observe(el));
    }
    window.addEventListener('resize', scheduleEditorLayout, { passive: true });
    settleEditorLayout();
  }

  function registerTypstLanguage() {
    const m = state.monaco;
    m.languages.register({ id: 'typst', extensions: ['.typ'], aliases: ['Typst','typst'] });
    m.languages.setLanguageConfiguration('typst', {
      comments: { lineComment: '//', blockComment: ['/*','*/'] },
      brackets: [['{','}'],['[',']'],['(',')']],
      autoClosingPairs: [
        { open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' },
        { open: '"', close: '"' }, { open: '$', close: '$' }, { open: '`', close: '`' }
      ],
      surroundingPairs: [
        { open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' },
        { open: '"', close: '"' }, { open: '$', close: '$' }, { open: '*', close: '*' }, { open: '_', close: '_' }
      ]
    });
    m.languages.setMonarchTokensProvider('typst', {
      defaultToken: '',
      tokenizer: {
        root: [
          [/\/\*/, 'comment', '@comment'],
          [/\/\/.*$/, 'comment'],
          [/^\s*=+\s.*$/, 'keyword.heading'],
          [/^\s*[-+]\s+/, 'keyword.list'],
          [/^\s*\d+[.)]\s+/, 'keyword.list'],
          [/#(?:let|set|show|import|include|if|else|for|while|return|context)\b/, 'keyword'],
          [/#?[a-zA-Z_][\w-]*(?=\s*\()/, 'type.function'],
          [/@[a-zA-Z_][\w:-]*/, 'tag'],
          [/\$[^$]*\$/, 'string.math'],
          [/`[^`]*`/, 'string.code'],
          [/"([^"\\]|\\.)*"/, 'string'],
          [/\b(?:true|false|none|auto)\b/, 'constant'],
          [/\b\d+(?:\.\d+)?(?:pt|cm|mm|in|em|fr|deg|rad|%|s|ms)?\b/, 'number'],
          [/\*[^*]+\*/, 'strong'],
          [/_[^_]+_/, 'emphasis'],
          [/[{}()[\]]/, '@brackets'],
          [/[+\-*\/=<>!&|]+/, 'operator'],
        ],
        comment: [[/[^/*]+/, 'comment'], [/\*\//, 'comment', '@pop'], [/[/*]/, 'comment']]
      }
    });
  }

  const TYPST_FILE_ARG_FUNCTIONS = new Map([
    ['include', new Set(['typ'])],
    ['import', new Set(['typ'])],
    ['image', IMAGE_EXTENSIONS],
    ['bibliography', new Set(['bib','yaml','yml'])],
    ['csv', new Set(['csv'])],
    ['json', new Set(['json'])],
    ['yaml', new Set(['yaml','yml'])],
    ['xml', new Set(['xml'])],
    ['read', null],
  ]);

  function registerTypstPathCompletion() {
    const m = state.monaco;
    m.languages.registerCompletionItemProvider('typst', {
      triggerCharacters: ['"', '/'],
      provideCompletionItems(model, position) {
        const context = getTypstFileArgumentContext(model, position);
        if (!context || !state.openPath) return { suggestions: [] };

        const allowed = TYPST_FILE_ARG_FUNCTIONS.get(context.fn);
        const currentPath = state.openPath;
        const currentDir = dirname(currentPath);
        const query = context.typed.toLowerCase();
        const candidates = [];

        for (const targetPath of effectivePaths()) {
          if (targetPath === currentPath || targetPath.endsWith('/')) continue;
          const extension = ext(targetPath);
          if (allowed && !allowed.has(extension)) continue;

          const relativePath = relativeProjectPath(currentDir, targetPath).replace(/\\/g, '/');
          const score = scorePathSuggestion(query, targetPath, relativePath);
          if (query && score < 0) continue;
          candidates.push({ targetPath, relativePath, score });
        }

        candidates.sort((a, b) => b.score - a.score || a.relativePath.length - b.relativePath.length || a.relativePath.localeCompare(b.relativePath));
        const top = candidates.slice(0, 80);
        const kind = m.languages.CompletionItemKind.File;
        const range = new m.Range(position.lineNumber, context.startColumn, position.lineNumber, context.endColumn);

        return {
          suggestions: top.map(({ targetPath, relativePath }) => ({
            label: {
              label: basename(targetPath),
              description: relativePath === basename(targetPath) ? '' : relativePath,
            },
            kind,
            detail: targetPath,
            documentation: `Insert ${context.fn} path: ${relativePath}`,
            insertText: relativePath,
            filterText: `${basename(targetPath)} ${targetPath} ${relativePath}`,
            sortText: pathSuggestionSortText(query, targetPath, relativePath),
            range,
          }))
        };
      }
    });
  }

  function getTypstFileArgumentContext(model, position) {
    if (!model || model.getLanguageId() !== 'typst') return null;
    const line = model.getLineContent(position.lineNumber);
    const cursor = Math.max(0, position.column - 1);
    const beforeCursor = line.slice(0, cursor);

    // Find the nearest unescaped opening quote on this line.
    let quote = -1;
    for (let i = cursor - 1; i >= 0; i--) {
      if (line[i] !== '"') continue;
      let slashes = 0;
      for (let j = i - 1; j >= 0 && line[j] === '\\'; j--) slashes++;
      if (slashes % 2 === 0) { quote = i; break; }
    }
    if (quote < 0) return null;

    // If another unescaped quote exists between the opening quote and cursor,
    // the cursor is no longer inside this string.
    for (let i = quote + 1; i < cursor; i++) {
      if (line[i] !== '"') continue;
      let slashes = 0;
      for (let j = i - 1; j > quote && line[j] === '\\'; j--) slashes++;
      if (slashes % 2 === 0) return null;
    }

    const prefix = beforeCursor.slice(0, quote);
    const fnMatch = prefix.match(/#\s*(include|import)\s*$|#?\s*(image|bibliography|csv|json|yaml|xml|read)\s*\(\s*$/i);
    if (!fnMatch) return null;
    const fn = String(fnMatch[1] || fnMatch[2] || '').toLowerCase();
    if (!TYPST_FILE_ARG_FUNCTIONS.has(fn)) return null;

    let closing = cursor;
    for (let i = cursor; i < line.length; i++) {
      if (line[i] !== '"') continue;
      let slashes = 0;
      for (let j = i - 1; j > quote && line[j] === '\\'; j--) slashes++;
      if (slashes % 2 === 0) { closing = i; break; }
    }

    return {
      fn,
      typed: line.slice(quote + 1, cursor),
      startColumn: quote + 2,
      endColumn: closing + 1,
    };
  }

  function scorePathSuggestion(query, targetPath, relativePath) {
    if (!query) return 1;
    const q = query.toLowerCase().replace(/^\.\//, '');
    const name = basename(targetPath).toLowerCase();
    const nameStem = name.replace(/\.[^.]+$/, '');
    const full = targetPath.toLowerCase();
    const rel = relativePath.toLowerCase();

    if (nameStem === q || name === q) return 1000;
    if (nameStem.startsWith(q)) return 900 - Math.min(nameStem.length - q.length, 100);
    if (name.startsWith(q)) return 850 - Math.min(name.length - q.length, 100);
    if (nameStem.includes(q)) return 760 - nameStem.indexOf(q);
    if (name.includes(q)) return 720 - name.indexOf(q);
    if (rel.startsWith(q) || full.startsWith(q)) return 680;
    if (rel.includes(q)) return 620 - Math.min(rel.indexOf(q), 100);
    if (full.includes(q)) return 580 - Math.min(full.indexOf(q), 100);

    // Lightweight subsequence matching lets "drive" find "drivetrain_di.typ"
    // without introducing a heavyweight fuzzy-search dependency.
    let qi = 0;
    let gaps = 0;
    let last = -1;
    for (let i = 0; i < nameStem.length && qi < q.length; i++) {
      if (nameStem[i] === q[qi]) {
        if (last >= 0) gaps += i - last - 1;
        last = i;
        qi++;
      }
    }
    if (qi === q.length) return 420 - Math.min(gaps, 200);
    return -1;
  }

  function pathSuggestionSortText(query, targetPath, relativePath) {
    const score = scorePathSuggestion(String(query || '').toLowerCase(), targetPath, relativePath);
    const inverted = String(Math.max(0, 9999 - Math.max(0, score))).padStart(4, '0');
    return `${inverted}-${relativePath.toLowerCase()}`;
  }

  function maybeTriggerTypstPathSuggestions(changeEvent) {
    if (!state.editor || !state.openPath || ext(state.openPath) !== 'typ' || state.suppressEditorChange) return;
    if (!changeEvent?.changes?.length) return;
    const inserted = changeEvent.changes.map(c => c.text).join('');
    if (!inserted || inserted.length > 4 || !/[A-Za-z0-9_./-]$/.test(inserted)) return;
    const model = state.editor.getModel();
    const position = state.editor.getPosition();
    if (!getTypstFileArgumentContext(model, position)) return;
    queueMicrotask(() => {
      if (state.editor && state.editor.hasTextFocus()) state.editor.trigger('typst-file-path', 'editor.action.triggerSuggest', {});
    });
  }

  function defineMonacoThemes() {
    const m = state.monaco;
    m.editor.defineTheme('typst-dark', {
      base: 'vs-dark', inherit: true,
      rules: [
        { token: 'keyword', foreground: '7FCFA4' }, { token: 'keyword.heading', foreground: 'D8E6DE', fontStyle: 'bold' },
        { token: 'type.function', foreground: '81B6E8' }, { token: 'string', foreground: 'D7C58A' },
        { token: 'string.math', foreground: 'D5A7E8' }, { token: 'comment', foreground: '6F7680', fontStyle: 'italic' },
        { token: 'number', foreground: 'E7A77B' }, { token: 'tag', foreground: '7FCFA4' },
      ],
      colors: {
        'editor.background': '#17181B', 'editor.foreground': '#DDE0E5', 'editorLineNumber.foreground': '#575D67',
        'editorLineNumber.activeForeground': '#AEB3BD', 'editorCursor.foreground': '#59C38A', 'editor.selectionBackground': '#2B604599',
        'editor.inactiveSelectionBackground': '#29453470', 'editorIndentGuide.background1': '#25282E', 'editorIndentGuide.activeBackground1': '#3A3E46',
      }
    });
    m.editor.defineTheme('typst-light', {
      base: 'vs', inherit: true,
      rules: [
        { token: 'keyword', foreground: '238356' }, { token: 'type.function', foreground: '2C6EA4' },
        { token: 'string', foreground: '8C6A24' }, { token: 'comment', foreground: '818791', fontStyle: 'italic' },
        { token: 'number', foreground: 'A85F34' },
      ],
      colors: {
        'editor.background': '#FFFFFF', 'editorCursor.foreground': '#258C5C', 'editor.selectionBackground': '#BEEBD2AA',
      }
    });
  }

  async function createWorkerTypstRuntime() {
    const worker = new Worker(new URL('./typst-worker.js', document.baseURI), { type: 'module' });
    const pending = new Map();
    let nextId = 0;
    let failure = null;
    let ready = false;
    let previewParts = null;
    let service;
    const fail = error => {
      if (failure) return;
      failure = error;
      previewParts = null;
      worker.terminate();
      for (const task of pending.values()) task.reject(error);
      pending.clear();
      if (ready && window.$typst === service) {
        // Recover through the compatibility runtime if a worker is unavailable.
        window.$typst = null;
        state.workerDisabled = true;
        state.runtimeInitPromise = null;
        state.compilerReady = false;
        state.compilerHydrated = false;
        state.compilerNeedsReset = true;
      }
    };
    worker.onerror = event => {
      event.preventDefault();
      fail(new Error(event.message || 'The background Typst compiler stopped.'));
    };
    worker.onmessageerror = () => fail(new Error('The background Typst compiler returned an unreadable response.'));
    worker.onmessage = event => {
      const task = pending.get(event.data?.id);
      if (!task) return;
      pending.delete(event.data.id);
      if (event.data.error) {
        const error = new Error(event.data.error.message);
        error.name = event.data.error.name || 'Error';
        error.diagnostics = event.data.error.diagnostics;
        task.reject(error);
      } else task.resolve(event.data.result);
    };
    const request = (method, args = {}) => new Promise((resolve, reject) => {
      if (failure) { reject(failure); return; }
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      try {
        // Clone file buffers: transferring them would detach editor caches.
        worker.postMessage({ id, method, args });
      } catch (error) { pending.delete(id); reject(error); }
    });
    const compiler = {
      reset: () => request('reset'),
      compile: options => request('compile', { options }),
    };
    const preview = async options => {
      let result = await request('compilePreview', { options, partsOnly: true, baseRevision: previewParts?.revision });
      if (result.svgDelta && result.svgDelta.baseRevision !== previewParts?.revision) {
        result = await request('compilePreview', { options, partsOnly: true });
      }
      if (result.svgDelta) {
        const delta = result.svgDelta;
        const pages = previewParts.pages.slice(0, delta.pageCount);
        for (const patch of delta.patches) {
          if (!Number.isInteger(patch.index) || patch.index < 0 || patch.index >= delta.pageCount || typeof patch.svg !== 'string') {
            throw new Error('The background compiler returned an invalid page update.');
          }
          pages[patch.index] = patch.svg;
        }
        if (pages.length !== delta.pageCount || Array.from({ length: delta.pageCount }, (_, index) => typeof pages[index]).some(type => type !== 'string')) {
          throw new Error('The background compiler returned an incomplete preview.');
        }
        result.svgParts = {
          opening: delta.opening, prefix: delta.prefix, pages,
          suffix: delta.suffix, closing: delta.closing, revision: delta.revision,
        };
        delete result.svgDelta;
      }
      if (result.svgParts) previewParts = result.svgParts;
      else if (typeof result.svg === 'string') previewParts = null;
      return result;
    };
    service = {
      getCompiler: async () => compiler,
      resetShadow: async () => { const result = await request('resetShadow'); previewParts = null; return result; },
      mapShadow: (path, bytes) => request('mapShadow', { path, bytes }),
      unmapShadow: path => request('unmapShadow', { path }),
      compilePreview: preview,
      svg: options => request('svg', options),
      pdf: options => request('pdf', { options }),
    };
    const timeout = setTimeout(() => fail(new Error('Background Typst compiler initialization timed out.')), 60000);
    try {
      await request('init');
      ready = true;
      return service;
    } catch (error) { fail(error); throw error; }
    finally { clearTimeout(timeout); }
  }

  function ensureTypstRuntime() {
    if (!state.runtimeInitPromise) {
      state.runtimeInitPromise = (async () => {
        if (!window.$typst && !state.workerDisabled && typeof Worker === 'function') {
          try {
            window.$typst = await createWorkerTypstRuntime();
            state.compilerReady = true;
            return;
          } catch (error) {
            state.workerDisabled = true;
            console.warn('Background Typst initialization failed; using the browser runtime.', error);
          }
        }
        if (!window.$typst) await loadScript('https://cdn.jsdelivr.net/npm/@myriaddreamin/typst.ts@0.8.0-rc3/dist/esm/contrib/all-in-one-lite.bundle.js', 'module');
        if (!window.$typst) throw new Error('Typst runtime did not initialize.');
        window.$typst.setCompilerInitOptions({
          getModule: () => 'https://cdn.jsdelivr.net/npm/@myriaddreamin/typst-ts-web-compiler@0.8.0-rc3/pkg/typst_ts_web_compiler_bg.wasm',
        });
        window.$typst.setRendererInitOptions({
          getModule: () => 'https://cdn.jsdelivr.net/npm/@myriaddreamin/typst-ts-renderer@0.8.0-rc3/pkg/typst_ts_renderer_bg.wasm',
        });
        // Pay initialization cost while the repository opens, before typing.
        await Promise.all([
          window.$typst.getCompiler?.(),
          window.$typst.getRenderer?.(),
        ]);
        state.compilerReady = true;
      })().catch(err => {
        state.runtimeInitPromise = null;
        throw err;
      });
    }
    return state.runtimeInitPromise;
  }

  function route() {
    const parsed = parseHash();
    if (parsed?.type === 'repo' && isRepositoryLoaded(parsed.owner, parsed.repo, parsed.branch)) return;
    const serial = ++state.repositoryLoadSerial;
    if (!parsed || parsed.type === 'home') {
      showHome();
      return;
    }
    if (parsed.type === 'repo') openRepository(parsed.owner, parsed.repo, parsed.branch, serial).catch(err => {
      if (serial === state.repositoryLoadSerial) handleFatalRepoError(err);
    });
  }

  function parseHash() {
    const hash = location.hash || '#/';
    const [pathPart, queryPart] = hash.slice(1).split('?');
    const parts = pathPart.split('/').filter(Boolean);
    if (!parts.length) return { type: 'home' };
    if (parts[0] === 'repo' && parts.length >= 3) {
      const params = new URLSearchParams(queryPart || '');
      return { type: 'repo', owner: decodeURIComponent(parts[1]), repo: decodeURIComponent(parts[2]), branch: params.get('branch') };
    }
    return { type: 'home' };
  }

  function showHome() {
    clearTimeout(state.compileTimer);
    state.compileTimer = null;
    state.compileDueAt = 0;
    state.compileSerial++;
    cancelPreviewSourceAnchorIndexing();
    els['editor-view'].classList.add('hidden');
    els['home-view'].classList.remove('hidden');
    renderRecents();
  }

  function navigateToRepoInput(value) {
    try {
      const { owner, repo } = parseRepoInput(value);
      location.hash = `#/repo/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function parseRepoInput(value) {
    const input = String(value || '').trim();
    if (!input) throw new Error('Enter a GitHub repository URL.');
    let owner, repo;
    if (/^https?:\/\//i.test(input)) {
      const url = new URL(input);
      if (!/(^|\.)github\.com$/i.test(url.hostname)) throw new Error('Only github.com repository URLs are supported.');
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length < 2) throw new Error('That URL does not contain a repository.');
      [owner, repo] = parts;
    } else {
      const parts = input.replace(/^github\.com\//i,'').split('/').filter(Boolean);
      if (parts.length < 2) throw new Error('Use owner/repository or a full GitHub URL.');
      [owner, repo] = parts;
    }
    repo = repo.replace(/\.git$/i,'');
    if (!owner || !repo) throw new Error('Invalid GitHub repository.');
    return { owner, repo };
  }

  function isRepositoryLoaded(owner, repo, requestedBranch) {
    return !els['editor-view'].classList.contains('hidden') && state.editor && state.headSha &&
      (!state.mainPath || (state.openPath && state.compilerHydrated)) &&
      state.repo?.owner?.login === owner && state.repo?.name === repo &&
      state.branch === (requestedBranch || state.repo.default_branch);
  }

  async function openRepository(owner, repo, requestedBranch, serial) {
    if (isRepositoryLoaded(owner, repo, requestedBranch)) return;
    if (serial === undefined) serial = ++state.repositoryLoadSerial;
    resetProjectState();
    els['home-view'].classList.add('hidden');
    els['editor-view'].classList.remove('hidden');
    setCompileStatus('busy', 'Loading repository');
    setSyncStatus('Reading GitHub…');

    const editorReady = ensureMonaco();
    // Attach handlers immediately while repository requests run in parallel.
    editorReady.catch(() => {});
    ensureTypstRuntime().catch(err => {
      if (serial === state.repositoryLoadSerial) showCompileError(err);
    });

    const meta = await github.getRepo(owner, repo);
    if (serial !== state.repositoryLoadSerial) return;
    state.repo = meta;
    state.branch = requestedBranch || meta.default_branch;
    updateRepoHeader();

    const [branches, ref] = await Promise.all([
      github.getBranches(owner, repo).catch(() => []),
      github.getRef(owner, repo, state.branch)
    ]);
    if (serial !== state.repositoryLoadSerial) return;
    state.branches = branches;
    renderBranches();
    if (!await loadTreeAtRef(ref.object.sha, serial)) return;
    chooseInitialMainFile();
    renderFileTree();
    addRecentProject();

    if (state.mainPath) await openFile(state.mainPath);
    else { await editorReady; if (serial === state.repositoryLoadSerial) showNoTypstFiles(); }
    if (serial !== state.repositoryLoadSerial) return;

    setSyncStatus(`GitHub • ${state.branch}`);
    hydrateCompilerFS().then(() => {
      if (serial === state.repositoryLoadSerial) scheduleCompile(0);
    }).catch(showCompileError);
  }

  async function loadTreeAtRef(commitSha, serial = state.repositoryLoadSerial) {
    const { owner, name: repo } = state.repo;
    const commit = await github.getCommit(owner.login, repo, commitSha);
    if (serial !== state.repositoryLoadSerial) return false;
    const tree = await github.getTree(owner.login, repo, commit.tree.sha);
    if (serial !== state.repositoryLoadSerial) return false;
    if (tree.truncated) toast('This repository is very large. GitHub returned a truncated file tree.', 'error', 6000);
    state.headSha = commitSha;
    state.baseTreeSha = commit.tree.sha;
    state.rawTree = tree.tree || [];
    state.fileIndex.clear();
    for (const item of state.rawTree) if (item.type === 'blob') state.fileIndex.set(item.path, { ...item, existing: true });
    invalidatePathCaches();
    els['file-count-label'].textContent = `${state.fileIndex.size} files`;
    return true;
  }

  function resetProjectState() {
    clearTimeout(state.compileTimer);
    state.compileTimer = null;
    state.compileDueAt = 0;
    clearTimeout(state.fileTreeRenderTimer);
    clearTimeout(state.editorSyncTimer);
    cancelPreviewSourceAnchorIndexing();
    state.repo = null; state.branch = null; state.branches = []; state.headSha = null; state.baseTreeSha = null;
    state.rawTree = []; state.fileIndex = new Map(); state.fileBytes = new Map(); state.fileRequests = new Map(); state.originalBytes = new Map(); state.sourceTextCache = new Map(); state.changes = new Map();
    state.pathsCache = null; state.typPathsCache = null; state.treeCache = null; state.fileTreeRows = new Map(); state.fileTreeRenderTimer = null;
    state.editorSyncTimer = null; state.editorSyncPending = false; state.editorSyncPath = null; state.shadowSyncPromise = null;
    state.openPath = null; state.mainPath = null; state.deletedPaths = new Set(); state.expandedFolders = new Set();
    state.compilerHydrated = false; state.compilerHydrating = false; state.compilerHydrationPromise = null; state.compilerNeedsReset = true;
    state.compileInFlight = false; state.compileQueued = false; state.compilePromise = null; state.compileSerial++;
    state.diagnostics = []; state.sourceSearchOrder = []; state.previewLastJump = null; state.previewSourceAnchors = []; state.previewAnchorMap = new WeakMap();
    if (state.previewSvgCache?.mode === 'cards') els['preview-output'].style.gap = state.previewSvgCache.previousGap;
    state.previewSvgCache = null;
    els['preview-output'].innerHTML = '';
    els['preview-error'].classList.add('hidden');
    els['diagnostic-list'].innerHTML = '';
    els['preview-error-text'].classList.add('hidden');
    els['preview-loading'].classList.remove('hidden');
    updateChangeUI();
  }

  function updateRepoHeader() {
    const r = state.repo;
    els['repo-owner-label'].textContent = r.owner.login;
    els['repo-name-label'].textContent = r.name;
    els['repo-private-badge'].classList.toggle('hidden', !r.private);
    els['repo-title-btn'].title = `Open ${r.full_name} on GitHub`;
  }

  function renderBranches() {
    const select = els['branch-select'];
    select.innerHTML = '';
    const names = state.branches.map(b => b.name);
    if (!names.includes(state.branch)) names.unshift(state.branch);
    for (const name of names) {
      const o = document.createElement('option'); o.value = name; o.textContent = name; o.selected = name === state.branch; select.appendChild(o);
    }
  }

  async function onBranchChange() {
    const next = els['branch-select'].value;
    if (next === state.branch) return;
    if (state.changes.size && !confirm('Switch branches and discard your uncommitted changes?')) {
      els['branch-select'].value = state.branch; return;
    }
    location.hash = `#/repo/${encodeURIComponent(state.repo.owner.login)}/${encodeURIComponent(state.repo.name)}?branch=${encodeURIComponent(next)}`;
  }

  async function reloadCurrentRepo(confirmDiscard = false) {
    if (!state.repo) return;
    if (confirmDiscard && state.changes.size && !confirm('Reload from GitHub and discard your uncommitted changes?')) return;
    const owner = state.repo.owner.login, name = state.repo.name, branch = state.branch;
    await openRepositoryForce(owner, name, branch);
  }

  async function openRepositoryForce(owner, repo, branch) {
    const serial = ++state.repositoryLoadSerial;
    resetProjectState();
    setCompileStatus('busy', 'Reloading repository');
    const meta = await github.getRepo(owner, repo);
    if (serial !== state.repositoryLoadSerial) return;
    state.repo = meta; state.branch = branch || meta.default_branch;
    updateRepoHeader();
    const [ref, branches] = await Promise.all([
      github.getRef(owner, repo, state.branch),
      github.getBranches(owner, repo).catch(() => [])
    ]);
    if (serial !== state.repositoryLoadSerial) return;
    state.branches = branches;
    renderBranches();
    if (!await loadTreeAtRef(ref.object.sha, serial)) return;
    chooseInitialMainFile();
    renderFileTree();
    addRecentProject();
    if (state.mainPath) await openFile(state.mainPath);
    if (serial !== state.repositoryLoadSerial) return;
    setSyncStatus(`GitHub • ${state.branch}`);
    await hydrateCompilerFS();
    await compilePreview();
  }

  function chooseInitialMainFile() {
    const typFiles = effectivePaths().filter(p => ext(p) === 'typ');
    const preferred = ['main.typ','document.typ','index.typ'];
    state.mainPath = preferred.find(p => typFiles.includes(p)) || typFiles.find(p => !p.includes('/')) || typFiles[0] || null;
    if (state.mainPath) {
      els['main-file-label'].textContent = state.mainPath;
      expandParents(state.mainPath);
    }
  }

  function showNoTypstFiles() {
    state.openPath = null;
    state.suppressEditorChange = true;
    state.editor.setValue('// No .typ files found in this repository.\n// Create one with the + button in the Files panel.');
    state.suppressEditorChange = false;
    els['tab-file-name'].textContent = 'No Typst file';
    els['preview-loading'].classList.add('hidden');
    els['preview-error'].classList.remove('hidden');
    els['diagnostic-summary'].textContent = 'No Typst file';
    els['diagnostic-list'].innerHTML = '';
    els['preview-error-text'].classList.remove('hidden');
    els['preview-error-text'].textContent = 'No .typ file is available to compile. Create a Typst file and choose it as the main file.';
    setCompileStatus('error', 'No Typst file');
  }

  function invalidatePathCaches() {
    state.pathsCache = null;
    state.typPathsCache = null;
    state.treeCache = null;
  }

  function effectivePaths() {
    if (state.pathsCache) return state.pathsCache;
    state.pathsCache = [...state.fileIndex.keys()]
      .filter(p => !state.deletedPaths.has(p))
      .sort((a,b) => a.localeCompare(b, undefined, { sensitivity:'base' }));
    return state.pathsCache;
  }

  function effectiveTypPaths() {
    if (!state.typPathsCache) state.typPathsCache = effectivePaths().filter(path => ext(path) === 'typ');
    return state.typPathsCache;
  }

  function cachedFileTree() {
    if (!state.treeCache) state.treeCache = buildTree(effectivePaths());
    return state.treeCache;
  }

  function scheduleFileTreeRender(delay = 70) {
    clearTimeout(state.fileTreeRenderTimer);
    state.fileTreeRenderTimer = setTimeout(() => {
      state.fileTreeRenderTimer = null;
      renderFileTree();
    }, delay);
  }

  function renderFileTree() {
    const root = cachedFileTree();
    const filter = els['file-search-input'].value.trim().toLowerCase();
    const container = els['file-tree'];
    container.innerHTML = '';
    state.fileTreeRows = new Map();
    if (filter) {
      for (const path of paths.filter(p => p.toLowerCase().includes(filter))) container.appendChild(makeFileRow(path, 0, true));
      return;
    }
    renderTreeNodes(root.children, container, 0, '');
  }

  function buildTree(paths) {
    const root = { children: new Map(), files: [] };
    for (const path of paths) {
      const parts = path.split('/');
      let node = root;
      parts.forEach((part, i) => {
        if (i === parts.length - 1) node.files.push({ name: part, path });
        else {
          if (!node.children.has(part)) node.children.set(part, { name: part, children: new Map(), files: [] });
          node = node.children.get(part);
        }
      });
    }
    return root;
  }

  function renderTreeNodes(children, container, depth, parentPath) {
    const folders = [...children.values()].sort((a,b) => a.name.localeCompare(b.name));
    for (const folder of folders) {
      const full = parentPath ? `${parentPath}/${folder.name}` : folder.name;
      const row = document.createElement('div');
      row.className = 'tree-row folder-row';
      row.style.paddingLeft = `${6 + depth * 14}px`;
      const expanded = state.expandedFolders.has(full);
      row.innerHTML = `<span class="chevron">${expanded ? '▼' : '▶'}</span><span class="folder-icon">▰</span><span class="file-label">${escapeHtml(folder.name)}</span>`;
      row.addEventListener('click', () => { expanded ? state.expandedFolders.delete(full) : state.expandedFolders.add(full); renderFileTree(); });
      container.appendChild(row);
      if (expanded) {
        renderTreeNodes(folder.children, container, depth + 1, full);
        for (const file of folder.files.sort((a,b)=>a.name.localeCompare(b.name))) container.appendChild(makeFileRow(file.path, depth + 1));
      }
    }
    if (depth === 0) {
      const rootFiles = buildTree(effectivePaths()).files;
      for (const file of rootFiles.sort((a,b)=>a.name.localeCompare(b.name))) container.appendChild(makeFileRow(file.path, 0));
    } else {
      // Files are rendered by the parent folder in renderTreeNodes.
    }
  }

  // Render helper for a node's files; called explicitly for nested folders.
  function makeFileRow(path, depth, flat = false) {
    const row = document.createElement('div');
    row.className = `tree-row file-row${path === state.openPath ? ' selected' : ''}`;
    row.setAttribute('role','treeitem');
    row.dataset.path = path;
    state.fileTreeRows.set(path, row);
    row.style.paddingLeft = `${6 + (flat ? 0 : depth * 14)}px`;
    const icon = fileIcon(path);
    const changed = state.changes.has(path);
    row.innerHTML = `<span class="chevron"></span><span class="file-type-icon ${icon.cls}">${icon.label}</span><span class="file-label">${escapeHtml(flat ? path : basename(path))}</span>${changed ? '<span class="tree-dirty">●</span>' : ''}`;
    row.title = path;
    row.addEventListener('click', () => openFile(path).catch(err => {
      if (err?.name !== 'AbortError') toast(err.message,'error');
    }));
    return row;
  }

  function fileTreeRow(path) {
    const row = state.fileTreeRows.get(path);
    return row?.isConnected ? row : null;
  }

  function updateFileTreeSelection(path) {
    els['file-tree'].querySelectorAll('.file-row.selected').forEach(row => row.classList.remove('selected'));
    fileTreeRow(path)?.classList.add('selected');
  }

  function updateFileTreeDirtyIndicator(path, dirty = state.changes.has(path)) {
    const row = fileTreeRow(path);
    if (!row) return;
    let dot = row.querySelector('.tree-dirty');
    if (dirty && !dot) {
      dot = document.createElement('span');
      dot.className = 'tree-dirty';
      dot.textContent = '●';
      row.appendChild(dot);
    } else if (!dirty && dot) {
      dot.remove();
    }
  }

  // Replace renderTreeNodes with a correct recursive implementation including local files.
  function renderTreeNodesFixed(nodeMap, container, depth, parentPath) {
    const folders = [...nodeMap.values()].sort((a,b) => a.name.localeCompare(b.name));
    for (const folder of folders) {
      const full = parentPath ? `${parentPath}/${folder.name}` : folder.name;
      const row = document.createElement('div');
      row.className = 'tree-row folder-row';
      row.style.paddingLeft = `${6 + depth * 14}px`;
      const expanded = state.expandedFolders.has(full);
      row.innerHTML = `<span class="chevron">${expanded ? '▼' : '▶'}</span><span class="folder-icon">▰</span><span class="file-label">${escapeHtml(folder.name)}</span>`;
      row.addEventListener('click', () => { expanded ? state.expandedFolders.delete(full) : state.expandedFolders.add(full); renderFileTree2(); });
      container.appendChild(row);
      if (expanded) {
        renderTreeNodesFixed(folder.children, container, depth + 1, full);
        for (const file of folder.files.sort((a,b)=>a.name.localeCompare(b.name))) container.appendChild(makeFileRow(file.path, depth + 1));
      }
    }
  }
  function renderFileTree2() {
    const paths = effectivePaths();
    els['file-count-label'].textContent = `${paths.length} files`;
    const root = cachedFileTree();
    const filter = els['file-search-input'].value.trim().toLowerCase();
    const container = els['file-tree'];
    container.innerHTML = '';
    state.fileTreeRows = new Map();
    if (filter) {
      for (const path of paths.filter(p => p.toLowerCase().includes(filter))) container.appendChild(makeFileRow(path, 0, true));
      return;
    }
    renderTreeNodesFixed(root.children, container, 0, '');
    for (const file of root.files.sort((a,b)=>a.name.localeCompare(b.name))) container.appendChild(makeFileRow(file.path, 0));
  }
  renderFileTree = renderFileTree2;

  function expandParents(path) {
    const parts = path.split('/'); parts.pop();
    let cur = '';
    let changed = false;
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      if (!state.expandedFolders.has(cur)) {
        state.expandedFolders.add(cur);
        changed = true;
      }
    }
    return changed;
  }

  function fileIcon(path) {
    const e = ext(path);
    if (e === 'typ') return { cls:'typ', label:'T' };
    if (IMAGE_EXTENSIONS.has(e)) return { cls:'img', label:'▧' };
    if (FONT_EXTENSIONS.has(e)) return { cls:'font', label:'A' };
    if (DATA_EXTENSIONS.has(e)) return { cls:'data', label:'{}' };
    return { cls:'', label:'·' };
  }

  async function getFileBytes(path) {
    if (state.fileBytes.has(path)) return state.fileBytes.get(path);
    if (state.fileRequests.has(path)) return state.fileRequests.get(path);
    const meta = state.fileIndex.get(path);
    if (!meta) throw new Error(`File not found: ${path}`);
    if (!meta.existing && meta.bytes) {
      state.fileBytes.set(path, meta.bytes); return meta.bytes;
    }
    if (meta.size > MAX_SINGLE_BLOB_BYTES) throw new Error(`${path} is too large to load in this editor (${formatBytes(meta.size)}).`);
    const requests = state.fileRequests;
    const fileIndex = state.fileIndex;
    const { owner, name } = state.repo;
    const request = (async () => {
      const blob = await github.getBlob(owner.login, name, meta.sha);
      // A late response must not populate a different project or replaced file.
      if (state.fileRequests !== requests || state.fileIndex !== fileIndex || fileIndex.get(path) !== meta) {
        const error = new Error('Project changed while loading a file.');
        error.name = 'AbortError';
        throw error;
      }
      const bytes = base64ToBytes(blob.content);
      state.fileBytes.set(path, bytes);
      if (!state.originalBytes.has(path)) state.originalBytes.set(path, bytes.slice());
      if (isTextPath(path) && !looksBinary(bytes)) state.sourceTextCache.set(path, decoder.decode(bytes));
      return bytes;
    })();
    requests.set(path, request);
    try {
      return await request;
    } finally {
      // Rejections can be retried, and old projects cannot clear new requests.
      if (requests.get(path) === request) requests.delete(path);
    }
  }

  function isTextPath(path) {
    const e = ext(path);
    return TEXT_EXTENSIONS.has(e) || e === '';
  }

  async function openFile(path) {
    const serial = state.repositoryLoadSerial;
    const fileIndex = state.fileIndex;
    if (state.deletedPaths.has(path)) return;
    if (state.openPath && state.openPath !== path) await flushEditorSync();
    if (serial !== state.repositoryLoadSerial || fileIndex !== state.fileIndex) return;
    const [bytes] = await Promise.all([getFileBytes(path), ensureMonaco()]);
    if (serial !== state.repositoryLoadSerial || fileIndex !== state.fileIndex) return;
    state.openPath = path;
    const expanded = expandParents(path);
    if (expanded) renderFileTree();
    else updateFileTreeSelection(path);
    els['status-current-file'].textContent = path;
    els['tab-file-name'].textContent = basename(path);
    const icon = fileIcon(path);
    els['tab-file-icon'].className = `file-type-icon ${icon.cls}`;
    els['tab-file-icon'].textContent = icon.label;
    updateDirtyTab();

    if (!isTextPath(path) || looksBinary(bytes)) {
      els['editor-container'].classList.add('hidden');
      els['binary-file-view'].classList.remove('hidden');
      els['binary-file-name'].textContent = basename(path);
      els['binary-file-meta'].textContent = `${formatBytes(bytes.length)} • ${ext(path).toUpperCase() || 'binary'} file`;
      return;
    }
    els['binary-file-view'].classList.add('hidden');
    els['editor-container'].classList.remove('hidden');
    const text = sourceText(path) || decoder.decode(bytes);
    state.suppressEditorChange = true;
    state.editor.setValue(text);
    const language = ext(path) === 'typ' ? 'typst' : languageForPath(path);
    state.monaco.editor.setModelLanguage(state.editor.getModel(), language);
    state.suppressEditorChange = false;
    applyDiagnosticMarkersForOpenFile();
    settleEditorLayout(true);
    state.editor.focus();
  }

  function looksBinary(bytes) {
    const limit = Math.min(bytes.length, 8000);
    for (let i = 0; i < limit; i++) if (bytes[i] === 0) return true;
    return false;
  }
  function languageForPath(path) {
    const map = { js:'javascript',mjs:'javascript',cjs:'javascript',ts:'typescript',tsx:'typescript',jsx:'javascript',json:'json',css:'css',html:'html',md:'markdown',markdown:'markdown',py:'python',rs:'rust',sh:'shell',xml:'xml',yaml:'yaml',yml:'yaml' };
    return map[ext(path)] || 'plaintext';
  }

  function onEditorChanged(changeEvent) {
    if (state.suppressEditorChange || !state.openPath) return;
    const path = state.openPath;
    const meta = state.fileIndex.get(path);

    // Keep each keystroke cheap. Encoding the whole document, comparing it
    // against the original, and updating Typst's shadow FS are debounced.
    state.editorSyncPending = true;
    state.editorSyncPath = path;
    if (!state.changes.has(path)) {
      state.changes.set(path, { type: meta?.existing ? 'modify' : 'add', pending: true });
    }
    updateChangeUI();
    updateFileTreeDirtyIndicator(path, true);

    clearTimeout(state.editorSyncTimer);
    state.editorSyncTimer = setTimeout(() => {
      state.editorSyncTimer = null;
      syncOpenFileFromEditor().catch(err => console.error('Editor sync failed', err));
    }, 90);

    // Publish completed snapshots while typing, then compile the newest edit.
    // Cancelling every in-flight result would starve a long document's preview.
    state.editRevision++;
    cancelPreviewSourceAnchorIndexing();
    state.previewSourceAnchors = [];
    state.previewAnchorMap = new WeakMap();
    if (state.mainPath) scheduleCompile();
    maybeTriggerTypstPathSuggestions(changeEvent);
  }

  async function syncOpenFileFromEditor() {
    const serial = state.repositoryLoadSerial;
    const fileIndex = state.fileIndex;
    if (!state.editorSyncPending || !state.editorSyncPath) {
      if (state.shadowSyncPromise) await state.shadowSyncPromise;
      assertCurrentRepository(serial, fileIndex);
      return;
    }
    const path = state.editorSyncPath;
    if (path !== state.openPath) {
      const error = new Error('Editor file changed while syncing.');
      error.name = 'AbortError';
      throw error;
    }

    clearTimeout(state.editorSyncTimer);
    state.editorSyncTimer = null;
    state.editorSyncPending = false;

    const text = state.editor.getValue();
    const bytes = encoder.encode(text);
    state.fileBytes.set(path, bytes);
    state.sourceTextCache.set(path, text);

    const original = state.originalBytes.get(path);
    const meta = state.fileIndex.get(path);
    if (meta?.existing && original && sameBytes(bytes, original)) state.changes.delete(path);
    else state.changes.set(path, { type: meta?.existing ? 'modify' : 'add', bytes });

    updateChangeUI();
    updateFileTreeDirtyIndicator(path);

    if (window.$typst) {
      const runtime = window.$typst;
      // Keep writes ordered while allowing newer keystrokes to remain pending.
      // This tail survives project resets until old writes have completed.
      const sync = state.shadowSyncTail.then(async () => {
        assertCurrentRepository(serial, fileIndex);
        const mapped = await runtime.mapShadow(`/repo/${path}`, bytes);
        assertCurrentRepository(serial, fileIndex);
        if (mapped === false) throw new Error(`Typst could not update project file: ${path}`);
      });
      state.shadowSyncTail = sync.catch(() => {});
      state.shadowSyncPromise = sync;
      try {
        await sync;
      } catch (err) {
        assertCurrentRepository(serial, fileIndex);
        // A failed latest update stays available for the next compile/retry.
        if (state.shadowSyncPromise === sync && !state.editorSyncPending && state.openPath === path) {
          state.editorSyncPending = true;
          state.editorSyncPath = path;
        }
        throw err;
      } finally {
        if (state.shadowSyncPromise === sync) state.shadowSyncPromise = null;
      }
    }
  }

  async function flushEditorSync() {
    const serial = state.repositoryLoadSerial;
    const fileIndex = state.fileIndex;
    while (true) {
      assertCurrentRepository(serial, fileIndex);
      if (state.editorSyncPending) await syncOpenFileFromEditor();
      else if (state.shadowSyncPromise) await state.shadowSyncPromise;
      else return;
    }
  }

  function updateChangeUI() {
    const count = state.changes.size;
    els['commit-btn'].disabled = count === 0;
    els['change-count-badge'].classList.toggle('hidden', count === 0);
    els['change-count-badge'].textContent = count;
    updateDirtyTab();
  }
  function updateDirtyTab() {
    els['tab-dirty-dot'].classList.toggle('hidden', !state.openPath || !state.changes.has(state.openPath));
  }

  async function hydrateCompilerFS(force = false) {
    if (!state.mainPath) return;
    if (state.compilerHydrated && !force) return;
    if (state.compilerHydrationPromise && !force) return state.compilerHydrationPromise;

    const serial = state.repositoryLoadSerial;
    const fileIndex = state.fileIndex;
    const checkCurrent = () => assertCurrentRepository(serial, fileIndex);
    // Typst has one shared shadow FS. Finish old reset/map operations before
    // hydrating a new project, even when the old hydration was cancelled.
    const hydration = state.compilerHydrationTail.then(async () => {
      checkCurrent();
      state.compilerHydrating = true;
      try {
        setCompileStatus('busy', 'Loading project files');
        await waitForTypstRuntime();
        checkCurrent();
        await state.shadowSyncTail;
        checkCurrent();
        if (state.compilerNeedsReset && typeof window.$typst.getCompiler === 'function') {
          const compiler = await window.$typst.getCompiler();
          checkCurrent();
          await compiler.reset();
          checkCurrent();
          state.compilerNeedsReset = false;
        }
        await window.$typst.resetShadow();
        checkCurrent();

        const entries = [...state.fileIndex.entries()].filter(([path, meta]) =>
          !state.deletedPaths.has(path) && (meta.size || 0) <= MAX_SINGLE_BLOB_BYTES
        );
        const allTotal = entries.reduce((sum, [, meta]) => sum + (meta.size || 0), 0);

        // Normal startup follows literal include/import/file references from
        // the selected main document instead of downloading every repository
        // blob. Dynamic file access falls back to the force-hydration retry.
        let selected = force ? entries : await collectCompilerDependencyEntries(entries);
        checkCurrent();
        let selectedTotal = selected.reduce((sum, [, meta]) => sum + (meta.size || 0), 0);
        if (selectedTotal > MAX_PROJECT_BYTES || (force && allTotal > MAX_PROJECT_BYTES)) {
          selected = entries.filter(([path]) => shouldHydratePriority(path));
          selectedTotal = selected.reduce((sum, [, meta]) => sum + (meta.size || 0), 0);
          toast(`This repository is ${formatBytes(allTotal)}. Preview loaded Typst/project assets under the ${formatBytes(MAX_PROJECT_BYTES)} browser limit.`, 'error', 7000);
        }

        let done = 0;
        const mappedPaths = new Set();
        await pooled(selected, 8, async ([path]) => {
          checkCurrent();
          const bytes = await getFileBytes(path);
          checkCurrent();
          const mapped = await window.$typst.mapShadow(`/repo/${path}`, bytes);
          checkCurrent();
          if (mapped === false) throw new Error(`Typst could not map project file: ${path}`);
          mappedPaths.add(path);
          done++;
          if (done % 8 === 0 || done === selected.length) {
            setCompileStatus('busy', `Loading files ${done}/${selected.length}`);
          }
        });
        checkCurrent();

        for (const [path, change] of state.changes) {
          checkCurrent();
          if (change.type === 'delete') await window.$typst.unmapShadow(`/repo/${path}`);
          else if (!mappedPaths.has(path) && change.bytes) {
            const mapped = await window.$typst.mapShadow(`/repo/${path}`, change.bytes);
            checkCurrent();
            if (mapped === false) throw new Error(`Typst could not map changed file: ${path}`);
          }
          checkCurrent();
        }

        state.compilerHydrated = true;
        setCompileStatus('busy', 'Compiling');
      } catch (err) {
        checkCurrent();
        throw err;
      } finally {
        if (serial === state.repositoryLoadSerial && fileIndex === state.fileIndex) state.compilerHydrating = false;
      }
    });

    state.compilerHydrationTail = hydration.catch(() => {});
    state.compilerHydrationPromise = hydration;
    try {
      return await hydration;
    } finally {
      if (state.compilerHydrationPromise === hydration) state.compilerHydrationPromise = null;
    }
  }

  function assertCurrentRepository(serial, fileIndex) {
    if (serial === state.repositoryLoadSerial && fileIndex === state.fileIndex) return;
    const error = new Error('Project changed while loading compiler files.');
    error.name = 'AbortError';
    throw error;
  }

  function shouldHydratePriority(path) {
    const e = ext(path);
    return e === 'typ' || IMAGE_EXTENSIONS.has(e) || DATA_EXTENSIONS.has(e) || FONT_EXTENSIONS.has(e) || ['pdf','svg','txt','md','markdown'].includes(e);
  }

  async function collectCompilerDependencyEntries(entries) {
    const serial = state.repositoryLoadSerial;
    const fileIndex = state.fileIndex;
    const byPath = new Map(entries);
    const selected = new Set();
    const typQueue = [];
    const queued = new Set();

    const addPath = path => {
      const clean = normalizeRepoPath(path);
      if (!clean || !byPath.has(clean) || selected.has(clean)) return;
      selected.add(clean);
      if (ext(clean) === 'typ' && !queued.has(clean)) {
        queued.add(clean);
        typQueue.push(clean);
      }
    };

    addPath(state.mainPath);

    // Repo fonts are inexpensive to discover and can be referenced by future
    // font-registration support without requiring a second full hydration.
    for (const [path] of entries) if (FONT_EXTENSIONS.has(ext(path))) addPath(path);

    while (typQueue.length) {
      const level = typQueue.splice(0);
      const texts = new Map();
      // Sibling imports are independent: fetch a level in parallel, then parse
      // in queue order so dependency and source-search ordering stays stable.
      await pooled(level, 8, async path => {
        try {
          assertCurrentRepository(serial, fileIndex);
          const bytes = await getFileBytes(path);
          assertCurrentRepository(serial, fileIndex);
          texts.set(path, sourceText(path) || decoder.decode(bytes));
        } catch (err) {
          if (err?.name === 'AbortError') throw err;
          // Preserve the existing compiler diagnostic/fallback behavior.
        }
      });
      for (const path of level) {
        if (!texts.has(path)) continue;
        const text = texts.get(path);

        // Literal module references.
        const moduleRegex = /#?\s*(?:include|import)\s*(?:\(\s*)?["']([^"']+)["']/g;
        let match;
        while ((match = moduleRegex.exec(text))) {
          const ref = resolveTypstReference(path, match[1]);
          if (ref) addPath(ref);
        }

        // Common repo-backed data and asset functions.
        const fileRegex = /#?\s*(?:image|bibliography|csv|json|yaml|xml|read)\s*\(\s*["']([^"']+)["']/g;
        while ((match = fileRegex.exec(text))) {
          const ref = resolveTypstReference(path, match[1]);
          if (ref) addPath(ref);
        }
      }
    }

    // A missing/dynamic dependency will cause an access-denied diagnostic,
    // which triggers the existing force hydration path.
    return [...selected].map(path => [path, byPath.get(path)]);
  }

  async function pooled(items, concurrency, fn) {
    let index = 0;
    let failed = false;
    let failure;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (!failed && index < items.length) {
        const i = index++;
        try { await fn(items[i], i); }
        catch (err) { if (!failed) { failed = true; failure = err; } }
      }
    });
    // A rejected worker must not leave shadow-FS writes running after callers
    // release the hydration queue to the next project.
    await Promise.all(workers);
    if (failed) throw failure;
  }

  function waitForTypstRuntime() { return ensureTypstRuntime(); }

  function scheduleCompile(delay = 40) {
    if (!state.mainPath || els['editor-view'].classList.contains('hidden')) return;
    if (state.compileInFlight) {
      state.compileQueued = true;
      return;
    }
    const dueAt = Date.now() + delay;
    // Anchor the deadline to the first edit in a batch, rather than postponing
    // it on every keystroke. Continuous typing must still produce previews.
    if (state.compileTimer != null && state.compileDueAt <= dueAt) return;
    clearTimeout(state.compileTimer);
    state.compileDueAt = dueAt;
    state.compileTimer = setTimeout(() => {
      state.compileTimer = null;
      state.compileDueAt = 0;
      compilePreview().catch(showCompileError);
    }, delay);
  }

  async function compilePreview() {
    if (!state.mainPath) return;
    if (state.compileInFlight) {
      state.compileQueued = true;
      return state.compilePromise;
    }

    const repositorySerial = state.repositoryLoadSerial;
    state.compileInFlight = true;
    const compilation = (async () => {
      let failedRevision = null;
      try {
        do {
          state.compileQueued = false;
          try {
            await compilePreviewOnce();
            failedRevision = null;
          } catch (error) {
            // A newer edit queued during a transient failure still needs its
            // own pass. Retry at most once per revision to avoid a busy loop.
            if (repositorySerial === state.repositoryLoadSerial && state.compileQueued && failedRevision !== state.editRevision) {
              failedRevision = state.editRevision;
              continue;
            }
            throw error;
          }
        } while (repositorySerial === state.repositoryLoadSerial && state.compileQueued);
      } finally {
        if (state.compilePromise === compilation) {
          state.compileInFlight = false;
          state.compilePromise = null;
        }
      }
    })();
    state.compilePromise = compilation;
    return compilation;
  }

  async function compilePreviewOnce() {
    if (!state.mainPath) return;
    const repositorySerial = state.repositoryLoadSerial;
    const mainPath = state.mainPath;
    const revision = state.editRevision;
    // One ordered snapshot is enough for this preview. Commit/export still
    // drain every pending edit; previews must not chase a moving typing stream.
    await syncOpenFileFromEditor();
    if (repositorySerial !== state.repositoryLoadSerial) return;
    const serial = ++state.compileSerial;
    const isCurrent = () => serial === state.compileSerial && mainPath === state.mainPath;
    if (!els['preview-output'].querySelector('svg')) els['preview-loading'].classList.remove('hidden');
    setCompileStatus('busy', 'Compiling');
    await hydrateCompilerFS();
    if (!isCurrent()) return;

    let result;
    try {
      result = await compileVectorWithDiagnostics();
      if (!isCurrent()) return;
      if (hasAccessDeniedDiagnostic(result.diagnostics)) {
        state.compilerHydrated = false;
        await hydrateCompilerFS(true);
        if (!isCurrent()) return;
        result = await compileVectorWithDiagnostics();
      }
    } catch (err) {
      if (!isCurrent()) return;
      if (isAccessDeniedCompilerError(err)) {
        state.compilerHydrated = false;
        await hydrateCompilerFS(true);
        if (!isCurrent()) return;
        result = await compileVectorWithDiagnostics();
      } else {
        throw err;
      }
    }

    if (!isCurrent()) return;
    const diagnostics = normalizeDiagnostics(result?.diagnostics || []);
    const errors = diagnostics.filter(d => d.severity === 'error');
    const warnings = diagnostics.filter(d => d.severity === 'warning');
    const hasPreview = typeof result?.svg === 'string' || result?.svgParts || result?.result;
    if (!hasPreview) {
      // Incomplete syntax during typing should not flash an obsolete error or
      // remove the last successful preview. A quiet latest edit shows diagnostics.
      if (revision !== state.editRevision) return;
      state.diagnostics = diagnostics;
      renderDiagnostics(diagnostics);
      els['preview-loading'].classList.add('hidden');
      els['download-pdf-btn'].disabled = true;
      if (!diagnostics.length) throw new Error('Typst compilation failed without a diagnostic message.');
      setCompileStatus('error', errors.length === 1 ? '1 error' : `${errors.length} errors`);
      return;
    }

    const svg = result.svgParts ? (result.svg || '') : (typeof result.svg === 'string' ? result.svg : await window.$typst.svg({ vectorData: result.result }));
    if (!isCurrent()) return;
    state.diagnostics = diagnostics;
    renderDiagnostics(diagnostics);
    installPreviewSvg(svg, result.svgParts);
    els['preview-loading'].classList.add('hidden');
    normalizePreviewSvg();
    state.sourceSearchOrder = buildSourceSearchOrder();
    schedulePreviewSourceAnchorIndexing();
    setPreviewZoom(state.previewZoom, false);
    els['download-pdf-btn'].disabled = false;
    if (state.compileQueued || revision !== state.editRevision) setCompileStatus('busy', 'Compiling');
    else if (errors.length) setCompileStatus('error', errors.length === 1 ? '1 error' : `${errors.length} errors`);
    else if (warnings.length) setCompileStatus('warn', warnings.length === 1 ? '1 warning' : `${warnings.length} warnings`);
    else setCompileStatus('ok', 'Up to date');
  }

  async function compileVectorWithDiagnostics() {
    if (typeof window.$typst.compilePreview === 'function') {
      return window.$typst.compilePreview({ mainFilePath: `/repo/${state.mainPath}`, root: '/repo', diagnostics: 'full' });
    }
    if (typeof window.$typst.getCompiler === 'function') {
      const compiler = await window.$typst.getCompiler();
      return compiler.compile({
        mainFilePath: `/repo/${state.mainPath}`,
        root: '/repo',
        diagnostics: 'full',
      });
    }
    // Compatibility fallback for older typst.ts builds.
    const vector = await window.$typst.vector({ mainFilePath: `/repo/${state.mainPath}`, root: '/repo' });
    return { result: vector, diagnostics: [] };
  }

  function hasAccessDeniedDiagnostic(diagnostics) {
    return (diagnostics || []).some(d => String(d?.message || d).toLowerCase().includes('access denied'));
  }

  function isAccessDeniedCompilerError(err) {
    const text = formatCompilerError(err).toLowerCase();
    return text.includes('access denied') || text.includes('cannot read file outside of project root');
  }

  function normalizeCompilerPath(path) {
    if (!path) return '';
    let value = String(path).replace(/\\/g, '/');
    value = value.replace(/^\/repo\//, '').replace(/^repo\//, '').replace(/^\/+/, '');
    return normalizeRepoPath(value);
  }

  function parseDiagnosticRange(range) {
    if (!range) return null;
    if (typeof range === 'object') {
      const start = range.start || range.from;
      const end = range.end || range.to || start;
      if (start && Number.isFinite(start.line)) {
        return {
          startLine: Number(start.line),
          startColumn: Number(start.character ?? start.column ?? 1),
          endLine: Number(end?.line ?? start.line),
          endColumn: Number(end?.character ?? end?.column ?? start.character ?? start.column ?? 1),
        };
      }
    }
    const match = String(range).match(/(\d+):(\d+)(?:-(\d+):(\d+))?/);
    if (!match) return null;
    return {
      startLine: Number(match[1]),
      startColumn: Number(match[2]),
      endLine: Number(match[3] ?? match[1]),
      endColumn: Number(match[4] ?? match[2]),
    };
  }

  function normalizeDiagnostic(input) {
    if (!input) return null;
    if (typeof input === 'string') return parseLegacyDiagnosticString(input);
    const severity = String(input.severity || 'error').toLowerCase();
    let path = normalizeCompilerPath(input.path || input.file || input.filename || '');
    const trace = Array.isArray(input.trace) ? input.trace : [];
    if (!path && trace.length) {
      for (const entry of trace) {
        const text = typeof entry === 'string' ? entry : JSON.stringify(entry);
        const match = text.match(/(?:Include|Import)\(["']([^"']+)["']\)/i);
        if (match) { path = normalizeCompilerPath(match[1]); break; }
      }
    }
    return {
      severity: severity.includes('warn') ? 'warning' : severity.includes('info') ? 'info' : 'error',
      path,
      range: parseDiagnosticRange(input.range),
      message: String(input.message || input.reason || input),
      hints: Array.isArray(input.hints) ? input.hints.map(String) : [],
      trace,
      raw: input,
    };
  }

  function parseLegacyDiagnosticString(text) {
    const value = String(text);
    const severityMatch = value.match(/severity:\s*(Error|Warning|Info)/i);
    const messageMatch = value.match(/message:\s*["']([^"']+)["']/i);
    const pathMatch = value.match(/(?:Include|Import)\(["']([^"']+)["']\)/i)
      || value.match(/(?:^|\s)([^\s:]+\.typ):(\d+):(\d+)/);
    const rangeMatch = value.match(/([^\s:]+\.typ):(\d+):(\d+)(?:-(\d+):(\d+))?/);
    return {
      severity: (severityMatch?.[1] || 'Error').toLowerCase() === 'warning' ? 'warning' : 'error',
      path: normalizeCompilerPath(pathMatch?.[1] || rangeMatch?.[1] || ''),
      range: rangeMatch ? {
        startLine: Math.max(0, Number(rangeMatch[2]) - 1),
        startColumn: Number(rangeMatch[3]),
        endLine: Math.max(0, Number(rangeMatch[4] || rangeMatch[2]) - 1),
        endColumn: Number(rangeMatch[5] || rangeMatch[3]),
      } : null,
      message: messageMatch?.[1] || value.replace(/^SourceDiagnostic\s*\{/, '').slice(0, 500),
      hints: [], trace: [], raw: value,
    };
  }

  function normalizeDiagnostics(items) {
    const raw = Array.isArray(items) ? items : [items];
    return raw.map(normalizeDiagnostic).filter(Boolean);
  }

  function diagnosticLocationLabel(diag) {
    if (!diag.path) return 'Project';
    if (!diag.range) return diag.path;
    return `${diag.path}:${diag.range.startLine + 1}:${diag.range.startColumn}`;
  }

  function collapseDiagnostics(diagnostics) {
    const groups = new Map();
    for (const diag of diagnostics) {
      const key = `${diag.severity}\u0000${diag.path}\u0000${diag.message}`;
      if (!groups.has(key)) groups.set(key, { ...diag, occurrences: [diag] });
      else groups.get(key).occurrences.push(diag);
    }
    return [...groups.values()];
  }

  function renderDiagnostics(diagnostics) {
    const panel = els['preview-error'];
    const list = els['diagnostic-list'];
    list.innerHTML = '';
    if (!diagnostics.length) {
      panel.classList.add('hidden');
      applyDiagnosticMarkersForOpenFile();
      return;
    }
    const grouped = collapseDiagnostics(diagnostics);
    const errorCount = diagnostics.filter(d => d.severity === 'error').length;
    const warningCount = diagnostics.filter(d => d.severity === 'warning').length;
    const bits = [];
    if (errorCount) bits.push(`${errorCount} error${errorCount === 1 ? '' : 's'}`);
    if (warningCount) bits.push(`${warningCount} warning${warningCount === 1 ? '' : 's'}`);
    els['diagnostic-summary'].textContent = bits.join(' • ') || 'Compilation diagnostics';

    for (const diag of grouped) {
      const row = document.createElement('div');
      row.className = `diagnostic-row ${diag.severity}`;
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      const count = diag.occurrences.length;
      const hints = diag.hints?.length ? `\n\nHints:\n${diag.hints.map(h => `• ${h}`).join('\n')}` : '';
      const trace = diag.trace?.length ? `\n\nTrace:\n${diag.trace.map(t => `• ${typeof t === 'string' ? t : JSON.stringify(t)}`).join('\n')}` : '';
      const occurrences = count > 1 ? `\n\nOccurrences:\n${diag.occurrences.map(o => `• ${diagnosticLocationLabel(o)}`).join('\n')}` : '';
      row.innerHTML = `
        <div class="diagnostic-main">
          <span class="diagnostic-severity">${diag.severity === 'warning' ? '!' : '×'}</span>
          <div class="diagnostic-copy">
            <strong>${escapeHtml(diag.message)}</strong>
            <span>${escapeHtml(diagnosticLocationLabel(diag))}${count > 1 ? ` • ×${count}` : ''}</span>
          </div>
          <span class="diagnostic-chevron">›</span>
        </div>
        <pre class="diagnostic-detail">${escapeHtml(`${diag.message}\n${diagnosticLocationLabel(diag)}${hints}${trace}${occurrences}`)}</pre>`;
      const activate = async () => {
        row.classList.toggle('expanded');
        await openDiagnosticLocation(diag).catch(err => toast(err.message, 'error'));
      };
      row.addEventListener('click', activate);
      row.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
      });
      list.appendChild(row);
    }
    panel.classList.remove('hidden');
    applyDiagnosticMarkersForOpenFile();
  }

  function diagnosticMarkerSeverity(severity) {
    const MarkerSeverity = state.monaco?.MarkerSeverity;
    if (!MarkerSeverity) return 8;
    if (severity === 'warning') return MarkerSeverity.Warning;
    if (severity === 'info') return MarkerSeverity.Info;
    return MarkerSeverity.Error;
  }

  function diagnosticRangeForModel(diag, model) {
    if (!diag?.range || !model) return null;
    const lineCount = Math.max(1, model.getLineCount());
    const startLine = Math.max(1, Math.min(lineCount, Number(diag.range.startLine) + 1));
    const endLine = Math.max(startLine, Math.min(lineCount, Number(diag.range.endLine) + 1));
    const startMax = model.getLineMaxColumn(startLine);
    const endMax = model.getLineMaxColumn(endLine);
    const startColumn = Math.max(1, Math.min(startMax, Number(diag.range.startColumn) || 1));
    let endColumn = Math.max(1, Math.min(endMax, Number(diag.range.endColumn) || startColumn));
    if (startLine === endLine && endColumn <= startColumn) endColumn = Math.min(endMax, startColumn + 1);
    return { startLineNumber:startLine, startColumn, endLineNumber:endLine, endColumn };
  }

  function applyDiagnosticMarkersForOpenFile() {
    if (!state.editor || !state.monaco) return;
    const model = state.editor.getModel();
    if (!model) return;
    if (!state.openPath || !isTextPath(state.openPath)) {
      state.monaco.editor.setModelMarkers(model, 'typst', []);
      return;
    }
    const markers = [];
    for (const diag of state.diagnostics || []) {
      let path = diag.path;
      if (path && path !== state.openPath) {
        const candidate = effectivePaths().find(p => basename(p) === basename(path));
        if (candidate !== state.openPath) continue;
      } else if (!path) {
        continue;
      }
      const range = diagnosticRangeForModel(diag, model);
      if (!range) continue;
      markers.push({
        ...range,
        message: [diag.message, ...(diag.hints || []).map(h => `Hint: ${h}`)].join('\n'),
        severity: diagnosticMarkerSeverity(diag.severity),
        source: 'Typst',
      });
    }
    state.monaco.editor.setModelMarkers(model, 'typst', markers);
  }

  function clearDiagnosticMarkers() {
    const model = state.editor?.getModel();
    if (model && state.monaco) state.monaco.editor.setModelMarkers(model, 'typst', []);
  }

  function hideDiagnostics() {
    els['preview-error'].classList.add('hidden');
    els['diagnostic-list'].innerHTML = '';
    els['preview-error-text'].classList.add('hidden');
    clearDiagnosticMarkers();
  }

  async function openDiagnosticLocation(diag) {
    let path = diag.path;
    if (!path || !state.fileIndex.has(path) || state.deletedPaths.has(path)) {
      const candidate = effectivePaths().find(p => basename(p) === basename(path || ''));
      if (candidate) path = candidate;
    }
    if (!path || !state.fileIndex.has(path)) return;
    await openFile(path);
    if (!diag.range || !isTextPath(path)) return;
    const model = state.editor.getModel();
    const startLine = Math.max(1, diag.range.startLine + 1);
    const endLine = Math.max(startLine, diag.range.endLine + 1);
    const startColumn = Math.max(1, diag.range.startColumn || 1);
    const endColumn = Math.max(startColumn, diag.range.endColumn || startColumn);
    const selection = new state.monaco.Range(startLine, startColumn, endLine, endColumn);
    state.editor.setSelection(selection);
    state.editor.revealRangeInCenter(selection, state.monaco.editor.ScrollType.Smooth);
    state.editor.focus();
  }

  function showCompileError(err) {
    if (err?.name === 'AbortError') return;
    console.error(err);
    els['preview-loading'].classList.add('hidden');
    const diagnostics = normalizeDiagnostics(Array.isArray(err) ? err : [err]);
    state.diagnostics = diagnostics;
    renderDiagnostics(diagnostics);
    if (!diagnostics.length) {
      els['preview-error'].classList.remove('hidden');
      els['preview-error-text'].classList.remove('hidden');
      els['preview-error-text'].textContent = formatCompilerError(err);
    }
    setCompileStatus('error', 'Compilation error');
  }

  function formatCompilerError(err) {
    if (!err) return 'Unknown compilation error.';
    if (typeof err === 'string') return err;
    if (Array.isArray(err)) return err.map(formatCompilerError).join('\n');
    if (err.message) return err.message;
    try { return JSON.stringify(err, null, 2); } catch { return String(err); }
  }

  function installPreviewSvg(svg, parts) {
    const output = els['preview-output'];
    const validParts = parts && ['opening', 'prefix', 'suffix', 'closing'].every(key => typeof parts[key] === 'string') &&
      Array.isArray(parts.pages) && parts.pages.length && parts.pages.every(page => typeof page === 'string');
    const completeSvg = () => svg || (validParts ? parts.opening + parts.prefix + parts.pages.join('') + parts.suffix + parts.closing : '');
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const parseNodes = markup => {
      const holder = document.createElementNS(SVG_NS, 'svg');
      holder.innerHTML = markup;
      return Array.from(holder.childNodes);
    };
    const setAttribute = (node, name, value) => {
      const text = String(value);
      if (node.getAttribute(name) !== text) node.setAttribute(name, text);
    };
    const applyAttributes = (node, template) => {
      for (const attribute of Array.from(node.attributes)) {
        if (!template.hasAttribute(attribute.name)) node.removeAttribute(attribute.name);
      }
      for (const attribute of Array.from(template.attributes)) setAttribute(node, attribute.name, attribute.value);
    };
    const patchNodes = (parent, previous, fresh, anchor = null) => {
      const key = (node, index) => node.nodeType === 1 && node.id ? `id:${node.id}` : `${node.nodeType}:${node.localName || ''}:${index}`;
      const byKey = new Map(previous.map((node, index) => [key(node, index), node]));
      const retained = new Set();
      const nodes = fresh.map((node, index) => {
        const old = byKey.get(key(node, index));
        if (!old) return node;
        if (old.isEqualNode(node)) { retained.add(old); return old; }
        if (old.nodeType === 1 && node.nodeType === 1 && old.localName === node.localName &&
          old.namespaceURI === node.namespaceURI && old.localName !== 'script') {
          // Replacing a shared glyph definition invalidates every SVG using it.
          // Preserve unchanged definitions when just one clip/glyph changes.
          applyAttributes(old, node);
          patchNodes(old, Array.from(old.childNodes), Array.from(node.childNodes));
          retained.add(old);
          return old;
        }
        return node;
      });
      previous.forEach(node => { if (!retained.has(node)) node.remove(); });
      let next = anchor;
      for (let index = nodes.length - 1; index >= 0; index--) {
        const node = nodes[index];
        if (node.parentNode !== parent || node.nextSibling !== next) parent.insertBefore(node, next);
        next = node;
      }
      return nodes;
    };
    const installCards = () => {
      let cache = state.previewSvgCache;
      const reusable = cache?.mode === 'cards' && cache.root.parentNode === output &&
        cache.pages.every(page => page.node.parentNode === output);
      const holder = document.createElement('div');
      holder.innerHTML = reusable ? parts.opening + parts.closing : completeSvg();
      const template = holder.firstElementChild;
      if (template?.localName !== 'svg' || holder.children.length !== 1) return false;
      const initialGroups = reusable ? [] : Array.from(template.querySelectorAll(':scope > g.typst-page'));
      if (!reusable && initialGroups.length !== parts.pages.length) return false;
      const changed = new Map();
      for (let index = 0; index < parts.pages.length; index++) {
        if (reusable && cache.pages[index]?.raw === parts.pages[index]) continue;
        const group = reusable ? parseNodes(parts.pages[index]).find(node => node.nodeType === 1) : initialGroups[index];
        const width = parseFloat(group?.getAttribute('data-page-width'));
        const height = parseFloat(group?.getAttribute('data-page-height'));
        if (group?.localName !== 'g' || !group.classList.contains('typst-page') || !(width > 0 && height > 0)) return false;
        changed.set(index, { group, width, height });
      }
      const pageTemplate = template.cloneNode(false);
      pageTemplate.removeAttribute('id');
      pageTemplate.classList.add('typst-doc', 'preview-page-surface');
      Object.assign(pageTemplate.style, {
        display: 'block', background: 'transparent', border: '0', boxShadow: 'none',
        borderRadius: '0', overflow: 'visible', filter: 'none',
      });
      if (!reusable) {
        const children = Array.from(template.childNodes);
        cache = {
          mode: 'cards', root: template, opening: parts.opening, prefix: parts.prefix, suffix: parts.suffix,
          prefixNodes: children.slice(0, children.indexOf(initialGroups[0])),
          suffixNodes: children.slice(children.indexOf(initialGroups[initialGroups.length - 1]) + 1),
          pages: [], previousGap: state.previewSvgCache?.mode === 'cards' ? state.previewSvgCache.previousGap : output.style.gap,
        };
      }
      const root = cache.root;
      if (reusable && cache.opening !== parts.opening) applyAttributes(root, template);
      const rootStyles = {
        position: 'absolute', width: '0px', height: '0px', overflow: 'hidden',
        background: 'transparent', border: '0', boxShadow: 'none', pointerEvents: 'none',
      };
      for (const [name, value] of Object.entries(rootStyles)) if (root.style[name] !== value) root.style[name] = value;
      setAttribute(root, 'width', 0); setAttribute(root, 'height', 0);
      setAttribute(root, 'aria-hidden', 'true');
      for (let index = 0; index < parts.pages.length; index++) {
        const update = changed.get(index);
        let record = cache.pages[index];
        if (!record) {
          const node = document.createElement('div');
          node.className = 'preview-page-card';
          Object.assign(node.style, { contain: 'layout style', flex: '0 0 auto', filter: 'drop-shadow(0 6px 13px rgba(0,0,0,.28))' });
          const pageSvg = pageTemplate.cloneNode(false);
          const background = document.createElementNS(SVG_NS, 'rect');
          background.classList.add('preview-page-background');
          setAttribute(background, 'x', 0); setAttribute(background, 'y', 0);
          setAttribute(background, 'fill', '#ffffff'); setAttribute(background, 'pointer-events', 'none');
          pageSvg.appendChild(background); node.appendChild(pageSvg);
          record = { raw: null, node, svg: pageSvg, background, group: null };
          cache.pages[index] = record;
        }
        if (update) {
          if (update.group.hasAttribute('transform')) update.group.removeAttribute('transform');
          if (record.group) record.group.replaceWith(update.group);
          else record.svg.appendChild(update.group);
          Object.assign(record, update, { raw: parts.pages[index] });
        }
        if (!reusable || cache.opening !== parts.opening) {
          setAttribute(pageTemplate, 'width', record.width); setAttribute(pageTemplate, 'height', record.height);
          setAttribute(pageTemplate, 'viewBox', `0 0 ${record.width} ${record.height}`);
          pageTemplate.style.width = `${record.width}px`; pageTemplate.style.height = `${record.height}px`;
          applyAttributes(record.svg, pageTemplate);
        }
        for (const [name, value] of Object.entries({ width: `${record.width}px`, height: `${record.height}px`, containIntrinsicSize: `${record.width}px ${record.height}px` })) {
          if (record.node.style[name] !== value) record.node.style[name] = value;
        }
        setAttribute(record.node, 'data-page-number', index + 1);
        setAttribute(record.svg, 'width', record.width); setAttribute(record.svg, 'height', record.height);
        setAttribute(record.svg, 'viewBox', `0 0 ${record.width} ${record.height}`);
        setAttribute(record.svg, 'data-page-number', index + 1);
        if (record.svg.style.width !== `${record.width}px`) record.svg.style.width = `${record.width}px`;
        if (record.svg.style.height !== `${record.height}px`) record.svg.style.height = `${record.height}px`;
        setAttribute(record.background, 'width', record.width); setAttribute(record.background, 'height', record.height);
        if (reusable && record.node.parentNode !== output) output.appendChild(record.node);
      }
      for (const record of cache.pages.slice(parts.pages.length)) record.node.remove();
      cache.pages.length = parts.pages.length;
      if (reusable && cache.prefix !== parts.prefix) {
        cache.prefixNodes = patchNodes(root, cache.prefixNodes, parseNodes(parts.prefix), cache.suffixNodes.find(node => node.parentNode === root) || null);
      }
      if (reusable && cache.suffix !== parts.suffix) {
        cache.suffixNodes = patchNodes(root, cache.suffixNodes, parseNodes(parts.suffix));
      }
      if (!reusable) output.replaceChildren(root, ...cache.pages.map(page => page.node));
      if (output.style.gap !== '16px') output.style.gap = '16px';
      cache.opening = parts.opening; cache.prefix = parts.prefix; cache.suffix = parts.suffix;
      cache.width = Math.max(...cache.pages.map(page => page.width));
      cache.height = cache.pages.reduce((sum, page) => sum + page.height, 0) + 16 * (cache.pages.length - 1);
      setAttribute(root, 'data-base-width', cache.width); setAttribute(root, 'data-base-height', cache.height);
      state.previewSvgCache = cache;
      return true;
    };
    if (validParts && parts.pages.length > 8 && installCards()) return;
    const replaceAll = () => {
      if (state.previewSvgCache?.mode === 'cards') output.style.gap = state.previewSvgCache.previousGap;
      output.innerHTML = completeSvg();
      state.previewSvgCache = null;
      if (!validParts || output.children.length !== 1) return;
      const root = output.firstElementChild;
      const groups = Array.from(root.querySelectorAll(':scope > g.typst-page'));
      if (root.localName !== 'svg' || groups.length !== parts.pages.length) return;
      const children = Array.from(root.childNodes);
      state.previewSvgCache = {
        root, opening: parts.opening, prefix: parts.prefix, suffix: parts.suffix,
        prefixNodes: children.slice(0, children.indexOf(groups[0])),
        suffixNodes: children.slice(children.indexOf(groups[groups.length - 1]) + 1),
        pages: groups.map((group, index) => ({ raw: parts.pages[index], group, node: group })),
      };
    };
    let cache = state.previewSvgCache;
    if (!validParts || !cache || cache.root.parentNode !== output || output.children.length !== 1 ||
      cache.pages.some(page => page.node.parentNode !== cache.root)) {
      replaceAll();
      return;
    }

    // Parse only changed pages. Shared glyph definitions can change while
    // unchanged pages continue to reference them through their existing DOM.
    const changed = new Map();
    for (let index = 0; index < parts.pages.length; index++) {
      if (cache.pages[index]?.raw === parts.pages[index]) continue;
      const nodes = parseNodes(parts.pages[index]);
      const group = nodes.find(node => node.nodeType === 1);
      if (!group || group.localName !== 'g' || !group.classList.contains('typst-page') ||
        nodes.some(node => node !== group && (node.nodeType !== 3 || node.textContent.trim()))) {
        replaceAll();
        return;
      }
      changed.set(index, group);
    }

    const root = cache.root;
    if (cache.opening !== parts.opening) {
      const holder = document.createElement('div');
      holder.innerHTML = parts.opening + parts.closing;
      const freshRoot = holder.firstElementChild;
      if (freshRoot?.localName !== 'svg' || holder.children.length !== 1) { replaceAll(); return; }
      const generatedClass = root.classList.contains('typst-paged-document');
      // Keep preview sizing metadata until normalization recomputes page gaps.
      for (const attribute of Array.from(root.attributes)) {
        if (!freshRoot.hasAttribute(attribute.name) && !['data-base-width', 'data-base-height', 'data-page-number'].includes(attribute.name)) {
          root.removeAttribute(attribute.name);
        }
      }
      for (const attribute of Array.from(freshRoot.attributes)) {
        if (root.getAttribute(attribute.name) !== attribute.value) root.setAttribute(attribute.name, attribute.value);
      }
      if (generatedClass) root.classList.add('typst-paged-document');
      cache.opening = parts.opening;
    }

    for (let index = 0; index < parts.pages.length; index++) {
      const group = changed.get(index);
      if (!group) continue;
      const previous = cache.pages[index];
      let node = group;
      if (previous) {
        if (previous.node !== previous.group) {
          node = previous.node;
          if (group.hasAttribute('transform')) node.dataset.originalPageTransform = group.getAttribute('transform');
          else delete node.dataset.originalPageTransform;
          previous.group.replaceWith(group);
        } else previous.node.replaceWith(group);
      } else {
        root.insertBefore(group, cache.suffixNodes.find(node => node.parentNode === root) || null);
      }
      cache.pages[index] = { raw: parts.pages[index], group, node };
    }
    for (const page of cache.pages.slice(parts.pages.length)) page.node.remove();
    cache.pages.length = parts.pages.length;

    if (cache.prefix !== parts.prefix) {
      cache.prefixNodes = patchNodes(root, cache.prefixNodes, parseNodes(parts.prefix), cache.pages[0].node);
      cache.prefix = parts.prefix;
    }
    if (cache.suffix !== parts.suffix) {
      cache.suffixNodes = patchNodes(root, cache.suffixNodes, parseNodes(parts.suffix));
      cache.suffix = parts.suffix;
    }
  }

  function normalizePreviewSvg() {
    const output = els['preview-output'];
    if (state.previewSvgCache?.mode === 'cards' && state.previewSvgCache.root.parentNode === output) {
      const label = `${state.previewSvgCache.pages.length} pages`;
      if (els['preview-page-label'].textContent !== label) els['preview-page-label'].textContent = label;
      return;
    }
    const renderedSvgs = Array.from(output.querySelectorAll(':scope > svg'));
    if (!renderedSvgs.length) return;

    let totalPages = 0;
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const pageGap = 16;
    const setAttribute = (node, name, value) => {
      const text = String(value);
      if (node.getAttribute(name) !== text) node.setAttribute(name, text);
    };
    const setStyle = (node, name, value) => { if (node.style[name] !== value) node.style[name] = value; };

    renderedSvgs.forEach(documentSvg => {
      // typst.ts renders a paged document as one SVG whose direct
      // <g class="typst-page"> children are stacked vertically.
      const typstPages = Array.from(documentSvg.children).flatMap(node => {
        if (node.matches('g.typst-page')) return [{ group: node, viewport: null }];
        if (node.matches('svg.preview-page-surface')) {
          const group = node.querySelector(':scope > g.typst-page');
          if (group) return [{ group, viewport: node }];
        }
        return [];
      });
      const pageInfo = typstPages.map(page => ({
        ...page,
        width: parseFloat(page.group.getAttribute('data-page-width')),
        height: parseFloat(page.group.getAttribute('data-page-height')),
      }));

      if (pageInfo.length > 1 && pageInfo.every(page => page.width > 0 && page.height > 0)) {
          const maxWidth = Math.max(...pageInfo.map(page => page.width));
          const totalHeight = pageInfo.reduce((sum, page) => sum + page.height, 0) + pageGap * (pageInfo.length - 1);
          let y = 0;

          pageInfo.forEach((page, index) => {
            // Keep the renderer's shared defs/styles once on the outer SVG.
            // Each real Typst page gets its own nested SVG viewport so the
            // preview background can show through between pages.
            const pageViewport = page.viewport || document.createElementNS(SVG_NS, 'svg');
            if (!pageViewport.classList.contains('preview-page-surface')) pageViewport.classList.add('preview-page-surface');
            setAttribute(pageViewport, 'data-page-number', index + 1);
            setAttribute(pageViewport, 'x', (maxWidth - page.width) / 2);
            setAttribute(pageViewport, 'y', y);
            setAttribute(pageViewport, 'width', page.width);
            setAttribute(pageViewport, 'height', page.height);
            setAttribute(pageViewport, 'viewBox', `0 0 ${page.width} ${page.height}`);
            setAttribute(pageViewport, 'preserveAspectRatio', 'xMidYMid meet');
            setAttribute(pageViewport, 'overflow', 'visible');

            const background = pageViewport.querySelector(':scope > rect.preview-page-background') || document.createElementNS(SVG_NS, 'rect');
            if (!background.classList.contains('preview-page-background')) background.classList.add('preview-page-background');
            setAttribute(background, 'x', 0);
            setAttribute(background, 'y', 0);
            setAttribute(background, 'width', page.width);
            setAttribute(background, 'height', page.height);
            setAttribute(background, 'fill', '#ffffff');
            setAttribute(background, 'pointer-events', 'none');
            if (background.parentNode !== pageViewport) pageViewport.prepend(background);

            // The original transform is only the cumulative vertical offset
            // used to make Typst's flat SVG continuous. The nested viewport
            // supplies the new position, so the page content becomes local.
            if (!page.viewport) {
              if (page.group.hasAttribute('transform')) pageViewport.dataset.originalPageTransform = page.group.getAttribute('transform');
              page.group.replaceWith(pageViewport);
              pageViewport.appendChild(page.group);
            }
            if (page.group.hasAttribute('transform')) page.group.removeAttribute('transform');
            const record = state.previewSvgCache?.root === documentSvg && state.previewSvgCache.pages[index];
            if (record) record.node = pageViewport;
            y += page.height + pageGap;
          });

          if (!documentSvg.classList.contains('typst-paged-document')) documentSvg.classList.add('typst-paged-document');
          setAttribute(documentSvg, 'width', maxWidth);
          setAttribute(documentSvg, 'height', totalHeight);
          setAttribute(documentSvg, 'viewBox', `0 0 ${maxWidth} ${totalHeight}`);
          setAttribute(documentSvg, 'data-base-width', maxWidth);
          setAttribute(documentSvg, 'data-base-height', totalHeight);
          setStyle(documentSvg, 'width', `${maxWidth}px`);
          setStyle(documentSvg, 'height', `${totalHeight}px`);
          totalPages += pageInfo.length;
          return;
      }

      if (pageInfo.length === 1 && pageInfo[0].viewport) {
        const page = pageInfo[0];
        const originalTransform = page.viewport.dataset.originalPageTransform;
        if (originalTransform !== undefined) setAttribute(page.group, 'transform', originalTransform);
        page.viewport.replaceWith(page.group);
        const record = state.previewSvgCache?.root === documentSvg && state.previewSvgCache.pages[0];
        if (record) record.node = page.group;
        documentSvg.classList.remove('typst-paged-document');
        setAttribute(documentSvg, 'width', page.width);
        setAttribute(documentSvg, 'height', page.height);
        setAttribute(documentSvg, 'viewBox', `0 0 ${page.width} ${page.height}`);
      }

      // Single-page documents and older renderer layouts need no restructuring.
      const w = parseFloat(documentSvg.getAttribute('width'));
      const h = parseFloat(documentSvg.getAttribute('height'));
      if (w && h) {
        setAttribute(documentSvg, 'data-base-width', w);
        setAttribute(documentSvg, 'data-base-height', h);
        setStyle(documentSvg, 'width', `${w}px`);
        setStyle(documentSvg, 'height', `${h}px`);
      }
      setAttribute(documentSvg, 'data-page-number', totalPages + 1);
      totalPages += Math.max(1, typstPages.length);
    });

    const pageLabel = totalPages === 1 ? '1 page' : `${totalPages} pages`;
    if (els['preview-page-label'].textContent !== pageLabel) els['preview-page-label'].textContent = pageLabel;
  }

  async function exportPdf() {
    if (!state.mainPath) return;
    try {
      await flushEditorSync();
      setCompileStatus('busy','Exporting PDF');
      await hydrateCompilerFS();
      const pdf = await window.$typst.pdf({ mainFilePath: `/repo/${state.mainPath}`, root: '/repo' });
      const blob = new Blob([pdf], { type:'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${basename(state.mainPath).replace(/\.typ$/i,'') || 'document'}.pdf`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setCompileStatus('ok','Up to date');
    } catch (err) { showCompileError(err); }
  }

  function setPreviewZoom(value, updateFit = true) {
    state.previewZoom = Math.max(.4, Math.min(2.5, Math.round(value * 10) / 10));
    if (updateFit) state.previewFit = false;
    els['zoom-reset-btn'].textContent = `${Math.round(state.previewZoom * 100)}%`;
    els['preview-output'].style.transform = `scale(${state.previewZoom})`;
    // At normal/reduced zoom this margin is zero. Reading scrollHeight here
    // would still force layout of every page immediately after an SVG update.
    const documents = state.previewZoom > 1 ? Array.from(els['preview-output'].querySelectorAll(':scope > svg')) : [];
    const baseHeight = documents.reduce((sum, svg) => sum + (parseFloat(svg.dataset.baseHeight || svg.getAttribute('height')) || 0), 0) + Math.max(0, documents.length - 1) * 16;
    const extraHeight = (state.previewZoom - 1) * baseHeight;
    els['preview-output'].style.marginBottom = `${extraHeight}px`;
  }
  function fitPreviewWidth() {
    const svg = els['preview-output'].querySelector('svg');
    if (!svg) return;
    const base = parseFloat(svg.dataset.baseWidth || svg.getAttribute('width') || '1');
    const available = Math.max(200, els['preview-scroll'].clientWidth - 64);
    state.previewFit = true;
    setPreviewZoom(Math.min(2.5, available / base), false);
  }

  async function createNewFile() {
    const suggested = state.openPath ? `${dirname(state.openPath) ? dirname(state.openPath) + '/' : ''}new.typ` : 'new.typ';
    const path = await textPrompt({ title:'New file', kicker:'Project', label:'File path', value:suggested, action:'Create' });
    if (!path) return;
    const clean = normalizeRepoPath(path);
    if (!clean || clean.endsWith('/')) return toast('Enter a file name, not only a folder.','error');
    if (state.fileIndex.has(clean) && !state.deletedPaths.has(clean)) return toast('A file already exists at that path.','error');
    const initial = ext(clean) === 'typ' ? '= New document\n\nStart writing here.\n' : '';
    const bytes = encoder.encode(initial);
    state.fileIndex.set(clean, { path:clean, type:'blob', mode:'100644', size:bytes.length, existing:false, bytes });
    invalidatePathCaches();
    state.fileBytes.set(clean, bytes);
    state.sourceTextCache.set(clean, initial);
    state.changes.set(clean, { type:'add', bytes });
    state.deletedPaths.delete(clean);
    expandParents(clean);
    if (window.$typst) await window.$typst.mapShadow(`/repo/${clean}`, bytes);
    if (!state.mainPath && ext(clean) === 'typ') { state.mainPath = clean; els['main-file-label'].textContent = clean; }
    renderFileTree(); updateChangeUI(); await openFile(clean); scheduleCompile(100);
  }

  async function setWorkingFile(path, bytes) {
    const clean = normalizeRepoPath(path);
    const previous = state.fileIndex.get(clean);
    const existing = Boolean(previous?.existing);
    state.fileIndex.set(clean, {
      ...(previous || {}),
      path: clean,
      type: 'blob',
      mode: previous?.mode || '100644',
      size: bytes.length,
      existing,
      bytes,
    });
    invalidatePathCaches();
    state.fileBytes.set(clean, bytes);
    state.sourceTextCache.delete(clean);
    const original = state.originalBytes.get(clean);
    if (existing && original && sameBytes(bytes, original)) state.changes.delete(clean);
    else state.changes.set(clean, { type: existing ? 'modify' : 'add', bytes });
    state.deletedPaths.delete(clean);
    if (window.$typst && shouldHydratePriority(clean)) {
      const mapped = await window.$typst.mapShadow(`/repo/${clean}`, bytes);
      if (mapped === false) throw new Error(`Typst could not map project file: ${clean}`);
    }
    expandParents(clean);
    return clean;
  }

  async function uploadFiles(e) {
    const input = e.target;
    const files = [...(input.files || [])];
    input.value = '';
    if (!files.length) return;
    const isFolderUpload = input === els['upload-folder-input'];
    const baseDir = isFolderUpload ? '' : (state.openPath ? dirname(state.openPath) : '');
    let added = 0;
    let skipped = 0;

    for (const file of files) {
      const suppliedPath = isFolderUpload && file.webkitRelativePath ? file.webkitRelativePath : file.name;
      const path = normalizeRepoPath(baseDir ? `${baseDir}/${suppliedPath}` : suppliedPath);
      if (!path) continue;
      if (state.fileIndex.has(path) && !state.deletedPaths.has(path) && !confirm(`${path} already exists. Replace it?`)) {
        skipped++;
        continue;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      await setWorkingFile(path, bytes);
      added++;
    }
    renderFileTree();
    updateChangeUI();
    state.sourceSearchOrder = buildSourceSearchOrder();
    scheduleCompile(100);
    const folderWord = isFolderUpload ? ' from the folder' : '';
    toast(`${added} file${added === 1 ? '' : 's'}${folderWord} added${skipped ? `, ${skipped} skipped` : ''}.`, 'success');
  }

  function imageExtensionForMime(type) {
    const map = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/webp': 'webp',
      'image/gif': 'gif',
      'image/svg+xml': 'svg',
      'image/avif': 'avif',
      'image/bmp': 'bmp',
    };
    return map[String(type || '').toLowerCase()] || 'png';
  }

  function defaultPastedImageName(file, index = 0) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '').replace('T', '-');
    const extension = imageExtensionForMime(file.type);
    const suffix = index ? `-${index + 1}` : '';
    return `pasted-${stamp}${suffix}.${extension}`;
  }

  function normalizePastedImageFilename(value, file) {
    const extension = imageExtensionForMime(file.type);
    let name = basename(String(value || '').trim()).replace(/[\\/:*?"<>|]/g, '-').replace(/^\.+/, '');
    if (!name) name = defaultPastedImageName(file);
    const dot = name.lastIndexOf('.');
    if (dot > 0) name = name.slice(0, dot);
    name = name.replace(/\s+/g, ' ').trim() || 'pasted-image';
    return `${name}.${extension}`;
  }

  function uniquePastedImagePath(filename) {
    const currentDir = state.openPath ? dirname(state.openPath) : '';
    const assetDir = currentDir ? `${currentDir}/assets` : 'assets';
    const dot = filename.lastIndexOf('.');
    const stem = dot > 0 ? filename.slice(0, dot) : filename;
    const extension = dot > 0 ? filename.slice(dot) : '';
    let candidate = `${assetDir}/${filename}`;
    let n = 2;
    while (state.fileIndex.has(candidate) && !state.deletedPaths.has(candidate)) {
      candidate = `${assetDir}/${stem}-${n++}${extension}`;
    }
    return candidate;
  }

  function escapeTypstString(value) {
    return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  }

  function validTypstWidth(value) {
    const width = String(value || '').trim();
    if (!width) return true;
    return /^(?:auto|\d*\.?\d+\s*(?:%|pt|mm|cm|in|em))$/i.test(width);
  }

  function imagePastePrompt(file, index, total) {
    const filename = defaultPastedImageName(file, index);
    const currentDir = state.openPath ? dirname(state.openPath) : '';
    const assetDir = currentDir ? `${currentDir}/assets` : 'assets';
    state.imagePasteContext = { file, index, total, assetDir };
    els['image-paste-title'].textContent = total > 1 ? `Insert pasted image ${index + 1} of ${total}` : 'Insert pasted image';
    els['image-paste-destination'].textContent = `The file will be created in ${assetDir}/`;
    els['image-paste-filename'].value = filename;
    els['image-paste-width'].value = '';
    els['image-paste-caption'].value = '';
    els['image-paste-kind-image'].checked = true;
    els['image-paste-kind-figure'].checked = false;
    updateImagePasteCaptionState();
    els['image-paste-error'].classList.add('hidden');
    openModal('image-paste-modal');
    setTimeout(() => { els['image-paste-filename'].focus(); els['image-paste-filename'].select(); }, 40);
    return new Promise(resolve => state.imagePasteResolver = resolve);
  }

  function updateImagePasteCaptionState() {
    if (!els['image-paste-caption']) return;
    const isFigure = Boolean(els['image-paste-kind-figure']?.checked);
    els['image-paste-caption'].disabled = !isFigure;
    els['image-paste-caption'].placeholder = isFigure ? 'Figure caption' : 'Available when inserting as a figure';
    if (els['image-paste-confirm']) els['image-paste-confirm'].textContent = isFigure ? 'Insert figure' : 'Insert image';
  }

  function resolveImagePastePrompt() {
    if (!state.imagePasteResolver || !state.imagePasteContext) return;
    const width = els['image-paste-width'].value.trim();
    if (!validTypstWidth(width)) {
      return showInlineError(els['image-paste-error'], 'Use a Typst width such as 80%, 12cm, 220pt, or leave it blank.');
    }
    const context = state.imagePasteContext;
    const filename = normalizePastedImageFilename(els['image-paste-filename'].value, context.file);
    const result = {
      filename,
      width,
      caption: els['image-paste-caption'].value.trim(),
      kind: els['image-paste-kind-figure'].checked ? 'figure' : 'image',
    };
    const resolve = state.imagePasteResolver;
    state.imagePasteResolver = null;
    state.imagePasteContext = null;
    els['modal-backdrop'].classList.add('hidden');
    els['image-paste-modal'].classList.add('hidden');
    state.activeModal = null;
    resolve(result);
  }

  function pastedImageSnippet(relative, options) {
    const path = escapeTypstString(relative);
    const widthArg = options.width ? `, width: ${options.width}` : '';
    const imageCall = `image("${path}"${widthArg})`;
    if (options.kind !== 'figure') return `#${imageCall}`;
    const caption = options.caption ? `,\n  caption: "${escapeTypstString(options.caption)}"` : '';
    return `#figure(\n  ${imageCall}${caption},\n)`;
  }

  async function handleEditorImagePaste(event) {
    if (!state.openPath || ext(state.openPath) !== 'typ' || !event.clipboardData) return;
    const imageItems = [...event.clipboardData.items].filter(item => item.kind === 'file' && item.type.startsWith('image/'));
    if (!imageItems.length) return;

    event.preventDefault();
    event.stopPropagation();
    const files = imageItems.map(item => item.getAsFile()).filter(Boolean);
    if (!files.length) return;
    const snippets = [];
    let created = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const options = await imagePastePrompt(file, i, files.length);
      if (!options) break;
      const bytes = new Uint8Array(await file.arrayBuffer());
      const path = uniquePastedImagePath(options.filename);
      await setWorkingFile(path, bytes);
      const relative = relativeProjectPath(dirname(state.openPath), path);
      snippets.push(pastedImageSnippet(relative, options));
      created++;
    }
    if (!created) return;

    const selection = state.editor.getSelection();
    const text = snippets.join('\n\n');
    state.editor.executeEdits('paste-image', [{
      range: selection,
      text,
      forceMoveMarkers: true,
    }]);
    const model = state.editor.getModel();
    const endOffset = model.getOffsetAt(selection.getStartPosition()) + text.length;
    state.editor.setPosition(model.getPositionAt(endOffset));
    state.editor.focus();
    renderFileTree();
    updateChangeUI();
    state.sourceSearchOrder = buildSourceSearchOrder();
    scheduleCompile(100);
    toast(`${created} pasted image${created === 1 ? '' : 's'} added to assets and inserted.`, 'success');
  }

  function sourceText(path) {
    if (state.editor && state.editorSyncPending && state.editorSyncPath === path && state.openPath === path) {
      return state.editor.getValue();
    }
    if (state.sourceTextCache.has(path)) return state.sourceTextCache.get(path);
    const bytes = state.fileBytes.get(path);
    if (!bytes) return '';
    const text = decoder.decode(bytes);
    state.sourceTextCache.set(path, text);
    return text;
  }

  function buildSourceSearchOrder() {
    const typPaths = effectiveTypPaths();
    const available = new Set(typPaths);
    const visited = new Set();
    const referencedTextAssets = new Set();
    const order = [];

    const visit = path => {
      if (!path || visited.has(path) || !available.has(path)) return;
      visited.add(path);
      order.push(path);
      const text = sourceText(path);

      const moduleRegex = /#(?:include|import)\s*(?:\(\s*)?["']([^"']+)["']/g;
      let match;
      while ((match = moduleRegex.exec(text))) visit(resolveTypstReference(path, match[1]));

      const assetRegex = /#?\s*(?:bibliography|csv|json|yaml|xml|read)\s*\(\s*["']([^"']+)["']/g;
      while ((match = assetRegex.exec(text))) {
        const ref = resolveTypstReference(path, match[1]);
        if (ref && state.fileIndex.has(ref) && isTextPath(ref)) referencedTextAssets.add(ref);
      }
    };

    visit(state.mainPath);
    for (const path of referencedTextAssets) if (!visited.has(path)) order.push(path);
    return order;
  }

  function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function findTextInSource(text) {
    const cleaned = String(text || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    if (!cleaned) return null;
    const paths = state.sourceSearchOrder.length ? state.sourceSearchOrder : buildSourceSearchOrder();
    const words = cleaned.split(/\s+/).filter(Boolean);
    const probes = [cleaned];
    for (const size of [8, 6, 4, 3, 2]) {
      if (words.length < size) continue;
      const starts = [...new Set([0, Math.max(0, Math.floor((words.length - size) / 2)), words.length - size])];
      for (const start of starts) probes.push(words.slice(start, start + size).join(' '));
    }

    let best = null;
    for (let pathIndex = 0; pathIndex < paths.length; pathIndex++) {
      const path = paths[pathIndex];
      const source = sourceText(path);
      if (!source) continue;
      for (let probeIndex = 0; probeIndex < probes.length; probeIndex++) {
        const probe = probes[probeIndex];
        let offset = source.indexOf(probe);
        if (offset < 0 && probe.includes(' ')) {
          const pattern = probe.split(/\s+/).map(escapeRegex).join('\\s+');
          const match = new RegExp(pattern).exec(source);
          if (match) offset = match.index;
        }
        if (offset < 0) continue;
        const score = (probes.length - probeIndex) * 100000 - pathIndex * 1000 - offset;
        if (!best || score > best.score) best = { path, offset, length: probe.length, score };
      }
    }
    return best;
  }

  function findAssetReferenceSource(assetPath) {
    if (!assetPath) return null;
    const paths = state.sourceSearchOrder.length ? state.sourceSearchOrder : buildSourceSearchOrder();
    for (const sourcePath of paths) {
      const source = sourceText(sourcePath);
      if (!source) continue;
      const relative = relativeProjectPath(dirname(sourcePath), assetPath);
      for (const probe of [relative, `/${assetPath}`, assetPath, basename(assetPath)]) {
        const offset = source.indexOf(probe);
        if (offset >= 0) return { path: sourcePath, offset, length: probe.length };
      }
    }
    return null;
  }

  function imagePathFromRenderedElement(image) {
    const href = image?.getAttribute('href') || image?.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
    if (!href) return '';
    if (href.startsWith('data:')) {
      const match = href.match(/^data:[^;,]+;base64,(.+)$/s);
      if (match) {
        try {
          const bytes = base64ToBytes(match[1]);
          for (const path of effectivePaths()) {
            if (!IMAGE_EXTENSIONS.has(ext(path))) continue;
            const candidate = state.fileBytes.get(path);
            if (candidate && sameBytes(candidate, bytes)) return path;
          }
        } catch { /* rendered data URI may be transformed */ }
      }
      return '';
    }
    const decoded = decodeURIComponent(href.split(/[?#]/)[0]).replace(/^file:\/\//, '');
    const normalized = normalizeCompilerPath(decoded);
    if (state.fileIndex.has(normalized)) return normalized;
    return effectivePaths().find(path => path === normalized || basename(path) === basename(normalized)) || '';
  }

  function nearestPreviewAnchor(target) {
    if (!(target instanceof Element)) return null;
    const direct = target.closest('.typst-text, image');
    if (direct) return direct;
    let group = target.closest('.typst-group');
    while (group) {
      const local = group.querySelector('.typst-text, image');
      if (local) return local;
      group = group.parentElement?.closest('.typst-group');
    }
    const svg = target.closest('svg');
    if (!svg) return null;
    const rect = target.getBoundingClientRect?.();
    if (!rect) return null;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let nearest = null;
    let distance = Infinity;
    for (const el of svg.querySelectorAll('.typst-text, image')) {
      const r = el.getBoundingClientRect();
      const dx = (r.left + r.width / 2) - cx;
      const dy = (r.top + r.height / 2) - cy;
      const d = dx * dx + dy * dy;
      if (d < distance) { distance = d; nearest = el; }
    }
    return nearest;
  }

  function renderedAnchorText(element) {
    if (!element) return '';
    const selectable = element.querySelector?.('.tsel');
    return String(selectable?.textContent || element.textContent || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function textSearchProbes(text) {
    const cleaned = String(text || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    if (!cleaned) return [];
    const words = cleaned.split(/\s+/).filter(Boolean);
    const probes = [cleaned];
    for (const size of [10, 8, 6, 4, 3, 2]) {
      if (words.length < size) continue;
      const starts = [...new Set([0, Math.max(0, Math.floor((words.length - size) / 2)), words.length - size])];
      for (const start of starts) probes.push(words.slice(start, start + size).join(' '));
    }
    return [...new Set(probes.filter(p => p.length >= 2))];
  }

  function allProbeMatches(source, probe) {
    if (!source || !probe) return [];
    const exact = [];
    let from = 0;
    while (from <= source.length) {
      const offset = source.indexOf(probe, from);
      if (offset < 0) break;
      exact.push({ offset, length: probe.length });
      from = offset + Math.max(1, probe.length);
    }
    if (exact.length || !/\s/.test(probe)) return exact;

    const results = [];
    const pattern = probe.split(/\s+/).map(escapeRegex).join('\\s+');
    const regex = new RegExp(pattern, 'g');
    let match;
    while ((match = regex.exec(source))) {
      results.push({ offset: match.index, length: match[0].length });
      if (!match[0].length) regex.lastIndex++;
    }
    return results;
  }

  function sourceCandidatesForRenderedText(text) {
    const probes = textSearchProbes(text);
    if (!probes.length) return [];
    const paths = state.sourceSearchOrder.length ? state.sourceSearchOrder : buildSourceSearchOrder();
    for (let probeIndex = 0; probeIndex < probes.length; probeIndex++) {
      const probe = probes[probeIndex];
      const candidates = [];
      for (let pathIndex = 0; pathIndex < paths.length; pathIndex++) {
        const path = paths[pathIndex];
        const source = sourceText(path);
        if (!source) continue;
        for (const match of allProbeMatches(source, probe)) {
          candidates.push({ path, ...match, pathIndex, probe, probeIndex, rank:pathIndex * 1_000_000_000 + match.offset });
        }
      }
      if (candidates.length) return candidates;
    }
    return [];
  }

  function cancelPreviewSourceAnchorIndexing() {
    state.previewIndexGeneration++;
    clearTimeout(state.previewIndexStartTimer);
    state.previewIndexStartTimer = null;
    if (state.previewIndexHandle != null) {
      if (typeof cancelIdleCallback === 'function') cancelIdleCallback(state.previewIndexHandle);
      else clearTimeout(state.previewIndexHandle);
    }
    state.previewIndexHandle = null;
  }

  function schedulePreviewSourceAnchorIndexing() {
    cancelPreviewSourceAnchorIndexing();
    state.previewSourceAnchors = [];
    state.previewAnchorMap = new WeakMap();

    const generation = state.previewIndexGeneration;
    const elements = [...els['preview-output'].querySelectorAll('.typst-text, image')];
    const lastOffsetByPath = new Map();
    const candidateCache = new Map();
    let index = 0;

    const schedule = callback => {
      if (typeof requestIdleCallback === 'function') {
        state.previewIndexHandle = requestIdleCallback(callback, { timeout: 900 });
      } else {
        state.previewIndexHandle = setTimeout(() => callback({ timeRemaining: () => 5, didTimeout: true }), 30);
      }
    };

    const work = deadline => {
      state.previewIndexHandle = null;
      if (generation !== state.previewIndexGeneration) return;

      let processed = 0;
      const started = performance.now();
      while (index < elements.length) {
        const element = elements[index++];
        let mapping = null;

        if (element.tagName?.toLowerCase() === 'image') {
          const assetPath = imagePathFromRenderedElement(element);
          const source = findAssetReferenceSource(assetPath);
          if (source) mapping = { ...source, element, kind:'image', assetPath };
        } else {
          const text = renderedAnchorText(element);
          let candidates = candidateCache.get(text);
          if (!candidates) {
            candidates = sourceCandidatesForRenderedText(text);
            candidateCache.set(text, candidates);
          }
          if (candidates.length) {
            let chosen = candidates.find(c => c.offset >= (lastOffsetByPath.get(c.path) ?? -1));
            if (!chosen) chosen = candidates[0];
            mapping = { ...chosen, element, kind:'text', text };
          }
        }

        if (mapping) {
          if (mapping.kind === 'text') lastOffsetByPath.set(mapping.path, mapping.offset + Math.max(1, mapping.length || 1));
          state.previewSourceAnchors.push(mapping);
          state.previewAnchorMap.set(element, mapping);
        }

        processed++;
        // A timed-out idle callback still needs a wall-clock budget; scanning
        // a long source document forty times can otherwise block the editor.
        if (performance.now() - started >= 4 || deadline.timeRemaining() < 2 || processed >= 8) break;
      }

      if (index < elements.length && generation === state.previewIndexGeneration) schedule(work);
    };

    // Source links have an on-demand fallback. Build the full index only after
    // the preview has settled rather than competing with continuous typing.
    if (elements.length) state.previewIndexStartTimer = setTimeout(() => {
      state.previewIndexStartTimer = null;
      if (generation === state.previewIndexGeneration) schedule(work);
    }, 250);
  }

  function distanceToSourceRange(offset, anchor) {
    const start = Number(anchor.offset) || 0;
    const end = start + Math.max(1, Number(anchor.length) || 1);
    if (offset >= start && offset <= end) return 0;
    return offset < start ? start - offset : offset - end;
  }

  function previewAnchorForSourcePosition(path, offset) {
    const anchors = (state.previewSourceAnchors || []).filter(anchor => anchor.path === path);
    if (!anchors.length) return null;
    let best = null;
    for (const anchor of anchors) {
      const distance = distanceToSourceRange(offset, anchor);
      const score = distance + (anchor.kind === 'image' ? 2 : 0);
      if (!best || score < best.score) best = { anchor, score, distance };
      if (distance === 0) break;
    }
    if (!best) return null;
    // Avoid surprising jumps when the click is clearly unrelated to any rendered content.
    if (best.distance > 320) return null;
    return best.anchor;
  }

  function highlightPreviewAnchor(element) {
    if (!element) return;
    if (state.previewHighlightTimer) clearTimeout(state.previewHighlightTimer);
    els['preview-output'].querySelectorAll('.source-jump-highlight').forEach(el => el.classList.remove('source-jump-highlight'));
    element.classList.add('source-jump-highlight');
    state.previewHighlightTimer = setTimeout(() => element.classList.remove('source-jump-highlight'), 1200);
  }

  function scrollPreviewToAnchor(anchor) {
    if (!anchor?.element?.isConnected) return false;
    anchor.element.scrollIntoView({ behavior:'smooth', block:'center', inline:'nearest' });
    highlightPreviewAnchor(anchor.element);
    return true;
  }

  function handleEditorPreviewClick(event) {
    if (!state.openPath || !isTextPath(state.openPath) || !event?.target?.position) return;
    const browserEvent = event.event?.browserEvent;
    if (browserEvent && Number.isFinite(browserEvent.button) && browserEvent.button !== 0) return;
    const selection = state.editor.getSelection();
    if (selection && !selection.isEmpty()) return;
    const model = state.editor.getModel();
    if (!model) return;
    const offset = model.getOffsetAt(event.target.position);
    const anchor = previewAnchorForSourcePosition(state.openPath, offset);
    if (anchor) scrollPreviewToAnchor(anchor);
  }

  async function openFileAtOffset(path, offset, length = 0) {
    if (!path || !state.fileIndex.has(path)) return false;
    await openFile(path);
    if (!isTextPath(path)) return true;
    const model = state.editor.getModel();
    const max = model.getValueLength();
    const start = Math.max(0, Math.min(max, Number(offset) || 0));
    const end = Math.max(start, Math.min(max, start + Math.max(0, Number(length) || 0)));
    const startPos = model.getPositionAt(start);
    const endPos = model.getPositionAt(end);
    const selection = new state.monaco.Range(startPos.lineNumber, startPos.column, endPos.lineNumber, endPos.column);
    state.editor.setSelection(selection);
    state.editor.revealRangeInCenter(selection, state.monaco.editor.ScrollType.Smooth);
    state.editor.focus();
    state.previewLastJump = { path, offset: start };
    return true;
  }

  async function handlePreviewClick(event) {
    const target = nearestPreviewAnchor(event.target);
    if (!target) return;
    let match = state.previewAnchorMap?.get(target) || null;
    if (!match && target.tagName?.toLowerCase() === 'image') {
      const assetPath = imagePathFromRenderedElement(target);
      match = findAssetReferenceSource(assetPath);
    } else if (!match) {
      const text = renderedAnchorText(target);
      match = findTextInSource(text);
    }
    if (!match) return;
    event.preventDefault();
    highlightPreviewAnchor(target);
    await openFileAtOffset(match.path, match.offset, match.length);
  }

  async function renameSelectedFile() {
    if (!state.openPath) return;
    await flushEditorSync();
    const oldPath = state.openPath;
    const newValue = await textPrompt({ title:'Rename file', kicker:'Project', label:'New path', value:oldPath, action:'Rename' });
    if (!newValue) return;
    const newPath = normalizeRepoPath(newValue);
    if (!newPath || newPath === oldPath) return;
    if (state.fileIndex.has(newPath) && !state.deletedPaths.has(newPath)) return toast('A file already exists at that path.','error');
    const bytes = await getFileBytes(oldPath);
    const oldMeta = state.fileIndex.get(oldPath);
    if (oldMeta?.existing) {
      state.changes.set(oldPath, { type:'delete' }); state.deletedPaths.add(oldPath); state.sourceTextCache.delete(oldPath);
    } else {
      state.changes.delete(oldPath); state.fileIndex.delete(oldPath); state.fileBytes.delete(oldPath); state.sourceTextCache.delete(oldPath);
    }
    state.fileIndex.set(newPath, { path:newPath, type:'blob', mode:oldMeta?.mode || '100644', size:bytes.length, existing:false, bytes });
    invalidatePathCaches();
    state.fileBytes.set(newPath, bytes);
    state.sourceTextCache.delete(newPath);
    state.changes.set(newPath, { type:'add', bytes });
    if (state.mainPath === oldPath) { state.mainPath = newPath; els['main-file-label'].textContent = newPath; }
    if (window.$typst) { await window.$typst.unmapShadow(`/repo/${oldPath}`); await window.$typst.mapShadow(`/repo/${newPath}`, bytes); }
    expandParents(newPath); renderFileTree(); updateChangeUI(); await openFile(newPath); scheduleCompile(100);
  }

  async function deleteSelectedFile() {
    if (!state.openPath) return;
    await flushEditorSync();
    const path = state.openPath;
    if (!confirm(`Delete ${path} from the next commit?`)) return;
    const meta = state.fileIndex.get(path);
    if (meta?.existing) {
      state.changes.set(path, { type:'delete' }); state.deletedPaths.add(path); state.sourceTextCache.delete(path);
    } else {
      state.changes.delete(path); state.fileIndex.delete(path); state.fileBytes.delete(path); state.sourceTextCache.delete(path);
    }
    invalidatePathCaches();
    if (window.$typst) await window.$typst.unmapShadow(`/repo/${path}`);
    if (state.mainPath === path) chooseInitialMainFile();
    const next = state.mainPath || effectivePaths()[0] || null;
    state.openPath = null;
    renderFileTree(); updateChangeUI();
    if (next) await openFile(next); else showNoTypstFiles();
    scheduleCompile(100);
  }

  function downloadCurrentBinary() {
    if (!state.openPath) return;
    const bytes = state.fileBytes.get(state.openPath); if (!bytes) return;
    const blob = new Blob([bytes]); const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = basename(state.openPath); a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
  }

  function openMainFileModal() {
    const files = effectivePaths().filter(p => ext(p) === 'typ');
    els['main-file-list'].innerHTML = '';
    for (const path of files) {
      const b = document.createElement('button'); b.className = `choice-item${path === state.mainPath ? ' active' : ''}`;
      b.innerHTML = `<span class="file-type-icon typ">T</span><span class="truncate">${escapeHtml(path)}</span>`;
      b.addEventListener('click', async () => {
        state.mainPath = path; els['main-file-label'].textContent = path; closeModal(); await openFile(path); scheduleCompile(0);
      });
      els['main-file-list'].appendChild(b);
    }
    openModal('main-file-modal');
  }

  function changeEditorFont(delta) {
    if (!state.editor) return;
    const current = state.editor.getOption(state.monaco.editor.EditorOption.fontSize);
    const next = Math.max(11, Math.min(22, current + delta));
    state.editor.updateOptions({ fontSize: next });
    localStorage.setItem(STORAGE.fontSize, String(next));
    settleEditorLayout();
  }

  function openCommitModal() {
    if (!state.changes.size) return;
    if (!state.token) { openAuthModal(); toast('Connect GitHub before committing changes.','error'); return; }
    els['commit-summary'].innerHTML = '';
    for (const [path, change] of [...state.changes.entries()].sort(([a],[b])=>a.localeCompare(b))) {
      const row = document.createElement('div'); row.className = 'commit-summary-row';
      row.innerHTML = `<span class="truncate">${escapeHtml(path)}</span><span class="change-type ${change.type}">${change.type}</span>`;
      els['commit-summary'].appendChild(row);
    }
    els['commit-message-input'].value = state.changes.size === 1 ? `Update ${basename([...state.changes.keys()][0])}` : 'Update Typst project';
    els['commit-error'].classList.add('hidden');
    openModal('commit-modal');
    setTimeout(() => els['commit-message-input'].focus(), 40);
  }

  async function commitChanges() {
    const message = els['commit-message-input'].value.trim();
    if (!message) return showInlineError(els['commit-error'],'Enter a commit message.');
    const btn = els['confirm-commit-btn'];
    const oldText = btn.textContent; btn.disabled = true; btn.textContent = 'Committing…';
    els['commit-error'].classList.add('hidden');
    try {
      await flushEditorSync();
      const owner = state.repo.owner.login, repo = state.repo.name;
      const latestRef = await github.getRef(owner, repo, state.branch);
      if (latestRef.object.sha !== state.headSha) throw new Error('The branch changed on GitHub after you opened it. Reload the project before committing so you do not overwrite somebody else’s work.');
      const treeEntries = [];
      for (const [path, change] of state.changes) {
        if (change.type === 'delete') {
          treeEntries.push({ path, mode: state.fileIndex.get(path)?.mode || '100644', type:'blob', sha:null });
          continue;
        }
        const blob = await github.createBlob(owner, repo, change.bytes);
        treeEntries.push({ path, mode: state.fileIndex.get(path)?.mode || '100644', type:'blob', sha:blob.sha });
      }
      const newTree = await github.createTree(owner, repo, state.baseTreeSha, treeEntries);
      const commit = await github.createCommit(owner, repo, message, newTree.sha, state.headSha);
      await github.updateRef(owner, repo, state.branch, commit.sha);
      closeModal();
      toast(`Committed ${state.changes.size} change${state.changes.size === 1 ? '' : 's'} to ${state.branch}.`, 'success', 5000);
      await openRepositoryForce(owner, repo, state.branch);
    } catch (err) {
      showInlineError(els['commit-error'], err.message || String(err));
    } finally {
      btn.disabled = false; btn.textContent = oldText;
    }
  }

  async function handleGitHubSearch(e) {
    e.preventDefault();
    const query = els['github-search-input'].value;
    const target = els['github-search-results'];
    target.innerHTML = '<div class="project-card"><span class="owner">Searching GitHub…</span></div>';
    try {
      const results = await github.searchRepos(query);
      renderSearchResults(results);
    } catch (err) {
      target.innerHTML = `<div class="empty-state"><h3>Search failed</h3><p>${escapeHtml(err.message)}</p></div>`;
    }
  }
  function renderSearchResults(repos) {
    const target = els['github-search-results']; target.innerHTML = '';
    if (!repos.length) { target.innerHTML = '<div class="empty-state"><h3>No repositories found</h3><p>Try a different repository name.</p></div>'; return; }
    for (const r of repos) {
      const card = document.createElement('article'); card.className = 'project-card';
      card.innerHTML = `<div><div class="project-card-top"><div class="project-card-icon">T</div>${r.private ? '<span class="private-chip">private</span>' : ''}</div><h3>${escapeHtml(r.name)}</h3><div class="owner">${escapeHtml(r.owner.login)}</div></div><div class="project-card-bottom"><span>${escapeHtml(r.language || 'Repository')}</span><span>${escapeHtml(r.default_branch || 'main')}</span></div>`;
      card.addEventListener('click', () => location.hash = `#/repo/${encodeURIComponent(r.owner.login)}/${encodeURIComponent(r.name)}`);
      target.appendChild(card);
    }
  }

  function getRecents() {
    try { const v = JSON.parse(localStorage.getItem(STORAGE.recents) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
  }
  function addRecentProject() {
    if (!state.repo) return;
    let recents = getRecents().filter(r => r.full_name !== state.repo.full_name);
    recents.unshift({ full_name:state.repo.full_name, owner:state.repo.owner.login, name:state.repo.name, branch:state.branch, private:Boolean(state.repo.private), openedAt:new Date().toISOString() });
    localStorage.setItem(STORAGE.recents, JSON.stringify(recents.slice(0,12)));
    renderRecents();
  }
  function renderRecents() {
    if (!els['recent-projects']) return;
    const query = els['recent-search-input']?.value.trim().toLowerCase() || '';
    const recents = getRecents().filter(r => !query || r.full_name.toLowerCase().includes(query));
    els['recent-projects'].innerHTML = '';
    els['recent-empty'].classList.toggle('hidden', recents.length > 0);
    for (const r of recents) {
      const card = document.createElement('article'); card.className = 'project-card';
      card.innerHTML = `<div><div class="project-card-top"><div class="project-card-icon">T</div><button class="project-remove" title="Remove from recents">×</button></div><h3>${escapeHtml(r.name)}</h3><div class="owner">${escapeHtml(r.owner)}</div></div><div class="project-card-bottom"><span>${escapeHtml(r.branch || 'main')}</span><span>${timeAgo(r.openedAt)}</span></div>`;
      card.addEventListener('click', () => location.hash = `#/repo/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.name)}${r.branch ? `?branch=${encodeURIComponent(r.branch)}` : ''}`);
      card.querySelector('.project-remove').addEventListener('click', e => {
        e.stopPropagation();
        const next = getRecents().filter(x => x.full_name !== r.full_name);
        localStorage.setItem(STORAGE.recents, JSON.stringify(next)); renderRecents();
      });
      els['recent-projects'].appendChild(card);
    }
  }

  function openAuthModal() {
    els['github-token-input'].value = '';
    els['auth-error'].classList.add('hidden');
    els['disconnect-github-btn'].classList.toggle('hidden', !state.token);
    openModal('auth-modal');
    setTimeout(() => els['github-token-input'].focus(), 40);
  }
  async function connectGitHub() {
    const token = els['github-token-input'].value.trim();
    if (!token) return showInlineError(els['auth-error'],'Paste a GitHub personal access token.');
    const oldToken = state.token;
    state.token = token;
    const btn = els['save-github-token-btn']; btn.disabled = true; btn.textContent = 'Checking…';
    try {
      const profile = await github.getProfile();
      saveToken(token, els['remember-token-checkbox'].checked);
      state.profile = profile;
      updateAccountUI(); closeModal(); toast(`Connected as ${profile.login}.`, 'success');
    } catch (err) {
      state.token = oldToken;
      showInlineError(els['auth-error'], `GitHub rejected this token: ${err.message}`);
    } finally { btn.disabled = false; btn.textContent = 'Connect'; }
  }

  function openModal(id) {
    document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
    els[id].classList.remove('hidden'); els['modal-backdrop'].classList.remove('hidden'); state.activeModal = id;
  }
  function closeModal() {
    els['modal-backdrop'].classList.add('hidden');
    document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
    if (state.promptResolver) { const resolve = state.promptResolver; state.promptResolver = null; resolve(null); }
    if (state.imagePasteResolver) { const resolve = state.imagePasteResolver; state.imagePasteResolver = null; state.imagePasteContext = null; resolve(null); }
    state.activeModal = null;
  }
  function textPrompt({ title, kicker='Project', label='Value', value='', action='Save' }) {
    els['text-prompt-title'].textContent = title;
    els['text-prompt-kicker'].textContent = kicker;
    els['text-prompt-label'].textContent = label;
    els['text-prompt-input'].value = value;
    els['text-prompt-confirm'].textContent = action;
    els['text-prompt-error'].classList.add('hidden');
    openModal('text-prompt-modal');
    setTimeout(() => { els['text-prompt-input'].focus(); els['text-prompt-input'].select(); }, 40);
    return new Promise(resolve => state.promptResolver = resolve);
  }
  function resolveTextPrompt() {
    if (!state.promptResolver) return;
    const value = els['text-prompt-input'].value;
    const resolve = state.promptResolver; state.promptResolver = null;
    els['modal-backdrop'].classList.add('hidden'); els['text-prompt-modal'].classList.add('hidden'); state.activeModal = null;
    resolve(value);
  }
  function showInlineError(el, msg) { el.textContent = msg; el.classList.remove('hidden'); }

  function setupResizer(handle, type) {
    let startX = 0, start = 0;
    handle.addEventListener('pointerdown', e => {
      startX = e.clientX;
      start = type === 'sidebar' ? parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width')) : parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--preview-width'));
      handle.setPointerCapture(e.pointerId); handle.classList.add('dragging');
    });
    handle.addEventListener('pointermove', e => {
      if (!handle.hasPointerCapture(e.pointerId)) return;
      const dx = e.clientX - startX;
      if (type === 'sidebar') {
        const value = Math.max(180, Math.min(420, start + dx));
        document.documentElement.style.setProperty('--sidebar-width', `${value}px`);
      } else {
        const px = Math.max(320, Math.min(window.innerWidth * .7, start - dx));
        document.documentElement.style.setProperty('--preview-width', `${px}px`);
      }
      scheduleEditorLayout();
    });
    handle.addEventListener('pointerup', e => {
      if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
      handle.classList.remove('dragging');
      settleEditorLayout();
    });
  }

  function setCompileStatus(kind, text) {
    const el = els['compile-status']; el.className = `status-pill ${kind}`; el.querySelector('span:last-child').textContent = text;
  }
  function setSyncStatus(text) { els['repo-sync-status'].textContent = text; }
  function toast(message, type = '', duration = 3500) {
    const el = document.createElement('div'); el.className = `toast ${type}`; el.textContent = message; els['toast-root'].appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(8px)'; setTimeout(()=>el.remove(),180); }, duration);
  }
  function handleFatalRepoError(err) {
    if (err?.name === 'AbortError') return;
    console.error(err);
    setCompileStatus('error','Could not open repository');
    toast(err.status === 404 ? 'Repository not found or your GitHub token cannot access it.' : err.message, 'error', 6500);
    els['preview-loading'].classList.add('hidden');
    els['preview-error'].classList.remove('hidden');
    els['diagnostic-summary'].textContent = 'Could not open repository';
    els['diagnostic-list'].innerHTML = '';
    els['preview-error-text'].classList.remove('hidden');
    els['preview-error-text'].textContent = err.message || String(err);
  }

  boot().catch(err => {
    console.error(err);
    alert(`Typst Git Editor failed to start: ${err.message}`);
  });
})();
