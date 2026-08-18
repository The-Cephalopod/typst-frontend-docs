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
    originalBytes: new Map(),
    changes: new Map(),
    openPath: null,
    mainPath: null,
    deletedPaths: new Set(),
    expandedFolders: new Set(),
    compilerHydrated: false,
    compilerHydrating: false,
    compilerReady: false,
    editor: null,
    editorModel: null,
    suppressEditorChange: false,
    monaco: null,
    compileTimer: null,
    compileSerial: 0,
    previewZoom: 1,
    previewFit: false,
    promptResolver: null,
    activeModal: null,
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
      'download-pdf-btn','commit-btn','change-count-badge','editor-account-btn','file-count-label','new-file-btn','upload-file-btn',
      'rename-file-btn','delete-file-btn','file-search-input','file-tree','main-file-btn','main-file-label','upload-file-input',
      'sidebar-resizer','preview-resizer','editor-container','binary-file-view','binary-file-name','binary-file-meta','download-binary-btn',
      'tab-file-icon','tab-file-name','tab-dirty-dot','editor-font-minus','editor-font-plus','preview-page-label','zoom-out-btn','zoom-reset-btn',
      'zoom-in-btn','fit-preview-btn','preview-scroll','preview-stage','preview-loading','preview-error','preview-error-text','preview-output',
      'status-current-file','cursor-position','repo-sync-status','modal-backdrop','auth-modal','github-token-input','remember-token-checkbox',
      'auth-error','disconnect-github-btn','save-github-token-btn','commit-modal','commit-summary','commit-message-input','commit-error',
      'confirm-commit-btn','text-prompt-modal','text-prompt-kicker','text-prompt-title','text-prompt-label','text-prompt-input','text-prompt-error',
      'text-prompt-confirm','main-file-modal','main-file-list','toast-root'
    ].forEach(id => els[id] = $(id));
  }

  async function boot() {
    cacheElements();
    loadTheme();
    loadToken();
    bindEvents();
    renderRecents();
    await initMonaco();
    configureTypstRuntime();
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
    els['file-search-input'].addEventListener('input', renderFileTree);
    els['new-file-btn'].addEventListener('click', createNewFile);
    els['upload-file-btn'].addEventListener('click', () => els['upload-file-input'].click());
    els['upload-file-input'].addEventListener('change', uploadFiles);
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
    document.querySelectorAll('[data-close-modal]').forEach(btn => btn.addEventListener('click', closeModal));
    els['modal-backdrop'].addEventListener('click', e => { if (e.target === els['modal-backdrop']) closeModal(); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && state.activeModal) closeModal();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (!els['editor-view'].classList.contains('hidden')) openCommitModal();
      }
    });
    setupResizer(els['sidebar-resizer'], 'sidebar');
    setupResizer(els['preview-resizer'], 'preview');
  }

  async function initMonaco() {
    if (!window.require) throw new Error('Monaco loader did not load.');
    window.require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.56.0/min/vs' } });
    await new Promise((resolve, reject) => {
      window.require(['vs/editor/editor.main'], resolve, reject);
    });
    state.monaco = window.monaco;
    registerTypstLanguage();
    defineMonacoThemes();
    const fontSize = Math.max(11, Math.min(22, Number(localStorage.getItem(STORAGE.fontSize) || 14)));
    document.documentElement.style.setProperty('--editor-font-size', `${fontSize}px`);
    state.editor = state.monaco.editor.create(els['editor-container'], {
      value: '',
      language: 'typst',
      theme: document.documentElement.dataset.theme === 'dark' ? 'typst-dark' : 'typst-light',
      automaticLayout: true,
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
    state.editor.onDidChangeModelContent(onEditorChanged);
    state.editor.onDidChangeCursorPosition(e => {
      els['cursor-position'].textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
    });
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

  function configureTypstRuntime() {
    const script = $('typst-runtime');
    const configure = () => {
      if (!window.$typst) return;
      try {
        window.$typst.setCompilerInitOptions({
          getModule: () => 'https://cdn.jsdelivr.net/npm/@myriaddreamin/typst-ts-web-compiler@0.8.0-rc3/pkg/typst_ts_web_compiler_bg.wasm',
        });
        window.$typst.setRendererInitOptions({
          getModule: () => 'https://cdn.jsdelivr.net/npm/@myriaddreamin/typst-ts-renderer@0.8.0-rc3/pkg/typst_ts_renderer_bg.wasm',
        });
      } catch (err) {
        // It may already be initialized after returning to the home page.
        console.debug('Typst runtime already initialized', err);
      }
      state.compilerReady = true;
    };
    if (window.$typst) configure();
    else script.addEventListener('load', configure, { once: true });
  }

  function route() {
    const parsed = parseHash();
    if (!parsed || parsed.type === 'home') {
      showHome();
      return;
    }
    if (parsed.type === 'repo') openRepository(parsed.owner, parsed.repo, parsed.branch).catch(handleFatalRepoError);
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

  async function openRepository(owner, repo, requestedBranch) {
    if (!els['editor-view'].classList.contains('hidden') && state.repo?.owner?.login === owner && state.repo?.name === repo && state.branch === requestedBranch) return;
    resetProjectState();
    els['home-view'].classList.add('hidden');
    els['editor-view'].classList.remove('hidden');
    setCompileStatus('busy', 'Loading repository');
    setSyncStatus('Reading GitHub…');

    const meta = await github.getRepo(owner, repo);
    state.repo = meta;
    state.branch = requestedBranch || meta.default_branch;
    updateRepoHeader();

    const [branches, ref] = await Promise.all([
      github.getBranches(owner, repo).catch(() => []),
      github.getRef(owner, repo, state.branch)
    ]);
    state.branches = branches;
    renderBranches();
    await loadTreeAtRef(ref.object.sha);
    chooseInitialMainFile();
    renderFileTree();
    addRecentProject();

    if (state.mainPath) await openFile(state.mainPath);
    else showNoTypstFiles();

    setSyncStatus(`GitHub • ${state.branch}`);
    hydrateCompilerFS().then(() => scheduleCompile(0)).catch(showCompileError);
  }

  async function loadTreeAtRef(commitSha) {
    const { owner, name: repo } = state.repo;
    const commit = await github.getCommit(owner.login, repo, commitSha);
    const tree = await github.getTree(owner.login, repo, commit.tree.sha);
    if (tree.truncated) toast('This repository is very large. GitHub returned a truncated file tree.', 'error', 6000);
    state.headSha = commitSha;
    state.baseTreeSha = commit.tree.sha;
    state.rawTree = tree.tree || [];
    state.fileIndex.clear();
    for (const item of state.rawTree) if (item.type === 'blob') state.fileIndex.set(item.path, { ...item, existing: true });
    els['file-count-label'].textContent = `${state.fileIndex.size} files`;
  }

  function resetProjectState() {
    clearTimeout(state.compileTimer);
    state.repo = null; state.branch = null; state.branches = []; state.headSha = null; state.baseTreeSha = null;
    state.rawTree = []; state.fileIndex = new Map(); state.fileBytes = new Map(); state.originalBytes = new Map(); state.changes = new Map();
    state.openPath = null; state.mainPath = null; state.deletedPaths = new Set(); state.expandedFolders = new Set();
    state.compilerHydrated = false; state.compilerHydrating = false; state.compileSerial++;
    els['preview-output'].innerHTML = '';
    els['preview-error'].classList.add('hidden');
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
    resetProjectState();
    setCompileStatus('busy', 'Reloading repository');
    const meta = await github.getRepo(owner, repo);
    state.repo = meta; state.branch = branch || meta.default_branch;
    updateRepoHeader();
    const ref = await github.getRef(owner, repo, state.branch);
    state.branches = await github.getBranches(owner, repo).catch(() => []);
    renderBranches();
    await loadTreeAtRef(ref.object.sha);
    chooseInitialMainFile();
    renderFileTree();
    addRecentProject();
    if (state.mainPath) await openFile(state.mainPath);
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
    els['preview-error-text'].textContent = 'No .typ file is available to compile. Create a Typst file and choose it as the main file.';
    setCompileStatus('error', 'No Typst file');
  }

  function effectivePaths() {
    return [...state.fileIndex.keys()].filter(p => !state.deletedPaths.has(p)).sort((a,b) => a.localeCompare(b, undefined, { sensitivity:'base' }));
  }

  function renderFileTree() {
    const root = buildTree(effectivePaths());
    const filter = els['file-search-input'].value.trim().toLowerCase();
    const container = els['file-tree'];
    container.innerHTML = '';
    if (filter) {
      for (const path of effectivePaths().filter(p => p.toLowerCase().includes(filter))) container.appendChild(makeFileRow(path, 0, true));
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
    row.style.paddingLeft = `${6 + (flat ? 0 : depth * 14)}px`;
    const icon = fileIcon(path);
    const changed = state.changes.has(path);
    row.innerHTML = `<span class="chevron"></span><span class="file-type-icon ${icon.cls}">${icon.label}</span><span class="file-label">${escapeHtml(flat ? path : basename(path))}</span>${changed ? '<span class="tree-dirty">●</span>' : ''}`;
    row.title = path;
    row.addEventListener('click', () => openFile(path).catch(err => toast(err.message,'error')));
    return row;
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
    const root = buildTree(effectivePaths());
    const filter = els['file-search-input'].value.trim().toLowerCase();
    const container = els['file-tree'];
    container.innerHTML = '';
    if (filter) {
      for (const path of effectivePaths().filter(p => p.toLowerCase().includes(filter))) container.appendChild(makeFileRow(path, 0, true));
      return;
    }
    renderTreeNodesFixed(root.children, container, 0, '');
    for (const file of root.files.sort((a,b)=>a.name.localeCompare(b.name))) container.appendChild(makeFileRow(file.path, 0));
  }
  renderFileTree = renderFileTree2;

  function expandParents(path) {
    const parts = path.split('/'); parts.pop();
    let cur = '';
    for (const part of parts) { cur = cur ? `${cur}/${part}` : part; state.expandedFolders.add(cur); }
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
    const meta = state.fileIndex.get(path);
    if (!meta) throw new Error(`File not found: ${path}`);
    if (!meta.existing && meta.bytes) {
      state.fileBytes.set(path, meta.bytes); return meta.bytes;
    }
    if (meta.size > MAX_SINGLE_BLOB_BYTES) throw new Error(`${path} is too large to load in this editor (${formatBytes(meta.size)}).`);
    const blob = await github.getBlob(state.repo.owner.login, state.repo.name, meta.sha);
    const bytes = base64ToBytes(blob.content);
    state.fileBytes.set(path, bytes);
    if (!state.originalBytes.has(path)) state.originalBytes.set(path, bytes.slice());
    return bytes;
  }

  function isTextPath(path) {
    const e = ext(path);
    return TEXT_EXTENSIONS.has(e) || e === '';
  }

  async function openFile(path) {
    if (state.deletedPaths.has(path)) return;
    const bytes = await getFileBytes(path);
    state.openPath = path;
    expandParents(path);
    renderFileTree();
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
    const text = decoder.decode(bytes);
    state.suppressEditorChange = true;
    state.editor.setValue(text);
    const language = ext(path) === 'typ' ? 'typst' : languageForPath(path);
    state.monaco.editor.setModelLanguage(state.editor.getModel(), language);
    state.editor.setScrollTop(0);
    state.suppressEditorChange = false;
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

  function onEditorChanged() {
    if (state.suppressEditorChange || !state.openPath) return;
    const path = state.openPath;
    const bytes = encoder.encode(state.editor.getValue());
    state.fileBytes.set(path, bytes);
    const original = state.originalBytes.get(path);
    const meta = state.fileIndex.get(path);
    if (meta?.existing && original && sameBytes(bytes, original)) state.changes.delete(path);
    else state.changes.set(path, { type: meta?.existing ? 'modify' : 'add', bytes });
    if (window.$typst) window.$typst.mapShadow(`/repo/${path}`, bytes).catch(console.error);
    updateChangeUI();
    renderFileTree();
    if (ext(path) === 'typ' || path === state.mainPath) scheduleCompile(450);
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

  async function hydrateCompilerFS() {
    if (state.compilerHydrated || state.compilerHydrating || !state.mainPath) return;
    state.compilerHydrating = true;
    try {
      setCompileStatus('busy', 'Loading project files');
      await waitForTypstRuntime();
      await window.$typst.resetShadow();
      const entries = [...state.fileIndex.entries()].filter(([p,m]) => !state.deletedPaths.has(p) && (m.size || 0) <= MAX_SINGLE_BLOB_BYTES);
      const total = entries.reduce((sum,[,m]) => sum + (m.size || 0), 0);
      let selected = entries;
      if (total > MAX_PROJECT_BYTES) {
        selected = entries.filter(([path]) => shouldHydratePriority(path));
        toast(`This repository is ${formatBytes(total)}. Preview loaded only Typst/project assets under the ${formatBytes(MAX_PROJECT_BYTES)} browser limit.`, 'error', 7000);
      }
      let done = 0;
      await pooled(selected, 8, async ([path]) => {
        const bytes = await getFileBytes(path);
        await window.$typst.mapShadow(`/repo/${path}`, bytes);
        done++;
        if (done % 8 === 0) setCompileStatus('busy', `Loading files ${done}/${selected.length}`);
      });
      for (const [path,change] of state.changes) {
        if (change.type === 'delete') await window.$typst.unmapShadow(`/repo/${path}`);
        else await window.$typst.mapShadow(`/repo/${path}`, change.bytes);
      }
      state.compilerHydrated = true;
      setCompileStatus('busy', 'Compiling');
    } finally {
      state.compilerHydrating = false;
    }
  }

  function shouldHydratePriority(path) {
    const e = ext(path);
    return e === 'typ' || IMAGE_EXTENSIONS.has(e) || DATA_EXTENSIONS.has(e) || FONT_EXTENSIONS.has(e) || ['pdf','svg'].includes(e);
  }

  async function pooled(items, concurrency, fn) {
    let index = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (index < items.length) {
        const i = index++;
        await fn(items[i], i);
      }
    });
    await Promise.all(workers);
  }

  function waitForTypstRuntime(timeout = 15000) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (window.$typst && state.compilerReady) return resolve();
        if (Date.now() - start > timeout) return reject(new Error('Typst WebAssembly runtime did not load. Check the browser network connection or content-blocking settings.'));
        setTimeout(tick, 80);
      };
      tick();
    });
  }

  function scheduleCompile(delay = 400) {
    clearTimeout(state.compileTimer);
    state.compileTimer = setTimeout(() => compilePreview().catch(showCompileError), delay);
  }

  async function compilePreview() {
    if (!state.mainPath) return;
    const serial = ++state.compileSerial;
    els['preview-error'].classList.add('hidden');
    els['preview-loading'].classList.remove('hidden');
    setCompileStatus('busy', 'Compiling');
    await hydrateCompilerFS();
    const svg = await window.$typst.svg({ mainFilePath: `/repo/${state.mainPath}`, root: '/repo' });
    if (serial !== state.compileSerial) return;
    els['preview-output'].innerHTML = svg || '';
    els['preview-loading'].classList.add('hidden');
    els['preview-error'].classList.add('hidden');
    normalizePreviewSvg();
    setPreviewZoom(state.previewZoom, false);
    els['download-pdf-btn'].disabled = false;
    setCompileStatus('ok', 'Up to date');
  }

  function normalizePreviewSvg() {
    const svgs = els['preview-output'].querySelectorAll('svg');
    if (!svgs.length) return;
    svgs.forEach(svg => {
      const w = parseFloat(svg.getAttribute('width'));
      const h = parseFloat(svg.getAttribute('height'));
      if (w && h) {
        svg.dataset.baseWidth = w; svg.dataset.baseHeight = h;
        svg.style.width = `${w}px`; svg.style.height = `${h}px`;
      }
    });
    els['preview-page-label'].textContent = svgs.length === 1 ? '1 page' : `${svgs.length} pages`;
  }

  function showCompileError(err) {
    console.error(err);
    els['preview-loading'].classList.add('hidden');
    els['preview-error'].classList.remove('hidden');
    els['preview-error-text'].textContent = formatCompilerError(err);
    setCompileStatus('error', 'Compilation error');
  }
  function formatCompilerError(err) {
    if (!err) return 'Unknown compilation error.';
    if (typeof err === 'string') return err;
    if (Array.isArray(err)) return err.map(formatCompilerError).join('\n');
    if (err.message) return err.message;
    try { return JSON.stringify(err, null, 2); } catch { return String(err); }
  }

  async function exportPdf() {
    if (!state.mainPath) return;
    try {
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
    els['preview-output'].style.marginBottom = `${Math.max(0, (state.previewZoom - 1) * (els['preview-output'].scrollHeight || 0))}px`;
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
    state.fileBytes.set(clean, bytes);
    state.changes.set(clean, { type:'add', bytes });
    state.deletedPaths.delete(clean);
    expandParents(clean);
    if (window.$typst) await window.$typst.mapShadow(`/repo/${clean}`, bytes);
    if (!state.mainPath && ext(clean) === 'typ') { state.mainPath = clean; els['main-file-label'].textContent = clean; }
    renderFileTree(); updateChangeUI(); await openFile(clean); scheduleCompile(100);
  }

  async function uploadFiles(e) {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (!files.length) return;
    const baseDir = state.openPath ? dirname(state.openPath) : '';
    for (const file of files) {
      let path = normalizeRepoPath(baseDir ? `${baseDir}/${file.name}` : file.name);
      if (state.fileIndex.has(path) && !confirm(`${path} already exists. Replace it?`)) continue;
      const bytes = new Uint8Array(await file.arrayBuffer());
      const existing = state.fileIndex.get(path)?.existing;
      state.fileIndex.set(path, { ...(state.fileIndex.get(path)||{}), path, type:'blob', mode:'100644', size:bytes.length, existing:Boolean(existing), bytes });
      state.fileBytes.set(path, bytes);
      state.changes.set(path, { type: existing ? 'modify' : 'add', bytes });
      state.deletedPaths.delete(path);
      if (window.$typst) await window.$typst.mapShadow(`/repo/${path}`, bytes);
      expandParents(path);
    }
    renderFileTree(); updateChangeUI(); scheduleCompile(100);
    toast(`${files.length} file${files.length === 1 ? '' : 's'} added to the working copy.`, 'success');
  }

  async function renameSelectedFile() {
    if (!state.openPath) return;
    const oldPath = state.openPath;
    const newValue = await textPrompt({ title:'Rename file', kicker:'Project', label:'New path', value:oldPath, action:'Rename' });
    if (!newValue) return;
    const newPath = normalizeRepoPath(newValue);
    if (!newPath || newPath === oldPath) return;
    if (state.fileIndex.has(newPath) && !state.deletedPaths.has(newPath)) return toast('A file already exists at that path.','error');
    const bytes = await getFileBytes(oldPath);
    const oldMeta = state.fileIndex.get(oldPath);
    if (oldMeta?.existing) {
      state.changes.set(oldPath, { type:'delete' }); state.deletedPaths.add(oldPath);
    } else {
      state.changes.delete(oldPath); state.fileIndex.delete(oldPath); state.fileBytes.delete(oldPath);
    }
    state.fileIndex.set(newPath, { path:newPath, type:'blob', mode:oldMeta?.mode || '100644', size:bytes.length, existing:false, bytes });
    state.fileBytes.set(newPath, bytes);
    state.changes.set(newPath, { type:'add', bytes });
    if (state.mainPath === oldPath) { state.mainPath = newPath; els['main-file-label'].textContent = newPath; }
    if (window.$typst) { await window.$typst.unmapShadow(`/repo/${oldPath}`); await window.$typst.mapShadow(`/repo/${newPath}`, bytes); }
    expandParents(newPath); renderFileTree(); updateChangeUI(); await openFile(newPath); scheduleCompile(100);
  }

  async function deleteSelectedFile() {
    if (!state.openPath) return;
    const path = state.openPath;
    if (!confirm(`Delete ${path} from the next commit?`)) return;
    const meta = state.fileIndex.get(path);
    if (meta?.existing) {
      state.changes.set(path, { type:'delete' }); state.deletedPaths.add(path);
    } else {
      state.changes.delete(path); state.fileIndex.delete(path); state.fileBytes.delete(path);
    }
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
    });
    handle.addEventListener('pointerup', e => { if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId); handle.classList.remove('dragging'); });
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
    console.error(err);
    setCompileStatus('error','Could not open repository');
    toast(err.status === 404 ? 'Repository not found or your GitHub token cannot access it.' : err.message, 'error', 6500);
    els['preview-loading'].classList.add('hidden'); els['preview-error'].classList.remove('hidden'); els['preview-error-text'].textContent = err.message || String(err);
  }

  boot().catch(err => {
    console.error(err);
    alert(`Typst Git Editor failed to start: ${err.message}`);
  });
})();
