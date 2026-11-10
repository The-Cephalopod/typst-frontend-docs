/* Typst Git Editor
 * Static client-side GitHub and Codeberg editor for Typst.
 * Tokens go directly to the API of the selected provider.
 */

(() => {
  'use strict';

  const API_VERSION = '2026-03-10';
  const STORAGE = {
    recents: 'typstgit.recents.v1',
    token: 'typstgit.githubToken',
    codebergToken: 'typstgit.codebergToken',
    theme: 'typstgit.theme',
    grammar: 'typstgit.grammar',
    fontSize: 'typstgit.editorFontSize',
  };
  const MAX_PROJECT_BYTES = 80 * 1024 * 1024;
  const MAX_SINGLE_BLOB_BYTES = 25 * 1024 * 1024;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const diffDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const MAX_DIFF_BYTES = 2 * 1024 * 1024;

  const TEXT_EXTENSIONS = new Set([
    'typ','txt','md','markdown','json','csv','yaml','yml','toml','xml','html','css','js','mjs','cjs','ts','tsx','jsx',
    'py','rs','go','java','c','h','cpp','hpp','sh','ps1','bat','ini','conf','bib','gitignore','gitattributes','lock','svg'
  ]);
  const IMAGE_EXTENSIONS = new Set(['png','jpg','jpeg','gif','webp','svg','bmp','avif']);
  const FONT_EXTENSIONS = new Set(['ttf','otf','ttc','otc','woff','woff2']);
  const DATA_EXTENSIONS = new Set(['json','csv','yaml','yml','toml','xml','bib']);

  const $ = (id) => document.getElementById(id);
  const els = {};
  let projectTools;
  const working = window.TypstWorkingState;
  const state = {
    provider: 'github',
    token: null,
    profile: null,
    codebergToken: null,
    codebergProfile: null,
    authProvider: 'github',
    authAttempt: 0,
    repo: null,
    branch: null,
    branches: [],
    headSha: null,
    baseTreeSha: null,
    rawTree: [],
    baseFiles: new Map(),
    fileIndex: new Map(),
    fileBytes: new Map(),
    fileRequests: new Map(),
    originalBytes: new Map(),
    sourceTextCache: new Map(),
    changes: new Map(),
    draft: null,
    workingRevision: 0,
    editorDraftRevision: -1,
    syncPlan: null,
    repositoryOperation: null,
    commitReview: null,
    branchReview: null,
    branchWorkflow: null,
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
    openTabs: new Map(),
    workspacePreviewScroll: null,
    mainPath: null,
    deletedPaths: new Set(),
    expandedFolders: new Set(),
    compilerHydrated: false,
    compilerHydrating: false,
    compilerHydrationPromise: null,
    compilerHydrationTail: Promise.resolve(),
    compilerReady: false,
    fontLoadDiagnostics: [],
    editor: null,
    editorInitPromise: null,
    runtimeInitPromise: null,
    repositoryLoadSerial: 0,
    suppressEditorChange: false,
    monaco: null,
    grammarEnabled: false,
    grammarWorker: null,
    grammarTimer: null,
    grammarRequestId: 0,
    grammarInFlight: null,
    grammarResult: null,
    grammarQuickFixes: null,
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
    previewPageObserver: null,
    previewMountTimer: null,
    promptResolver: null,
    activeModal: null,
    diagnostics: [],
    sourceSearchOrder: null,
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

    async request(path, options = {}, token = this.getToken()) {
      const headers = {
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': API_VERSION,
        ...(options.headers || {}),
      };
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

    getProfile(token) { return this.request('/user', {}, token); }
    getRepo(owner, repo) { return this.request(`/repos/${enc(owner)}/${enc(repo)}`); }
    getBranches(owner, repo) { return this.request(`/repos/${enc(owner)}/${enc(repo)}/branches?per_page=100`); }
    getRef(owner, repo, branch) {
      const ref = `heads/${branch.split('/').map(encodeURIComponent).join('/')}`;
      return this.request(`/repos/${enc(owner)}/${enc(repo)}/git/ref/${ref}`, { cache: 'no-store' });
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
    createBranch(owner, repo, branch, sha) {
      return this.request(`/repos/${enc(owner)}/${enc(repo)}/git/refs`, {
        method: 'POST', body: { ref: `refs/heads/${branch}`, sha },
      });
    }
    createPullRequest(owner, repo, head, base, title, body) {
      return this.request(`/repos/${enc(owner)}/${enc(repo)}/pulls`, {
        method: 'POST', body: { head, base, title, body },
      });
    }
    async findOpenPullRequest(owner, repo, head, base) {
      const pulls = await this.request(`/repos/${enc(owner)}/${enc(repo)}/pulls?state=open&head=${enc(owner + ':' + head)}&base=${enc(base)}`, { cache: 'no-store' });
      return pulls[0];
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
  let codebergClient, codebergClientPromise;
  let githubProfileRequest;
  const themeButtons = ['home-theme-btn', 'editor-theme-btn'];

  function repositoryProviderLabel(provider = state.provider) {
    return provider === 'codeberg' ? 'Codeberg' : 'GitHub';
  }

  function repositoryClient(provider = state.provider) {
    return provider === 'codeberg' ? codebergClient : github;
  }

  function ensureCodebergClient() {
    if (!codebergClientPromise) {
      codebergClientPromise = loadScript(new URL('./codeberg.js', document.baseURI).href).then(() => {
        codebergClient = new window.CodebergClient(() => state.codebergToken);
        return codebergClient;
      }).catch(error => {
        codebergClientPromise = null;
        throw error;
      });
    }
    return codebergClientPromise;
  }

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
      'home-view','editor-view','connect-github-btn','github-account-label','connect-codeberg-btn','codeberg-account-label',
      'home-theme-btn','open-repo-form','repo-url-input',
      'recent-projects','recent-empty','recent-search-input','github-search-form','github-search-input','github-search-results','repo-search-provider',
      'repo-owner-label','repo-name-label','repo-private-badge','repo-title-btn','branch-select','compile-status','refresh-repo-btn',
      'download-pdf-btn','commit-btn','change-count-badge','grammar-toggle-btn','editor-account-btn','file-count-label','new-file-btn','upload-file-btn','upload-folder-btn',
      'rename-file-btn','delete-file-btn','file-search-input','file-tree','main-file-btn','main-file-label','upload-file-input','upload-folder-input',
      'sidebar-resizer','preview-resizer','code-pane','editor-container','binary-file-view','binary-file-name','binary-file-meta','download-binary-btn',
      'open-file-tabs','empty-editor','editor-workspace','workspace-switcher','editor-theme-btn','editor-font-minus','editor-font-plus','preview-page-label','zoom-out-btn','zoom-reset-btn',
      'zoom-in-btn','fit-preview-btn','preview-scroll','preview-stage','preview-loading','preview-error','preview-error-text','diagnostic-summary','diagnostic-list','preview-output',
      'status-current-file','cursor-position','repo-sync-status','modal-backdrop','auth-modal','auth-modal-title','auth-token-copy','auth-token-help',
      'github-token-input','remember-token-checkbox','auth-error','disconnect-github-btn','save-github-token-btn',
      'commit-modal','commit-modal-title','commit-summary','commit-message-input','commit-error',
      'draft-status','discard-draft-btn','sync-modal','sync-conflicts','sync-error','apply-sync-btn',
      'publish-branch-btn','branch-modal','branch-name','branch-target','branch-title','branch-body',
      'branch-create-pr','branch-progress','branch-error','branch-run-btn','branch-current',
      'branch-review','branch-files','branch-message','branch-pr-fields','branch-targets','branch-reset-btn',
      'confirm-commit-btn','text-prompt-modal','text-prompt-kicker','text-prompt-title','text-prompt-label','text-prompt-input','text-prompt-error',
      'text-prompt-confirm','main-file-modal','main-file-list','image-paste-modal','image-paste-title','image-paste-destination',
      'image-paste-filename','image-paste-width','image-paste-caption','image-paste-kind-image','image-paste-kind-figure',
      'image-paste-error','image-paste-confirm','toast-root'
    ].forEach(id => els[id] = $(id));
  }

  async function boot() {
    cacheElements();
    loadTheme();
    if (localStorage.getItem(STORAGE.grammar) === 'true') setGrammarEnabled(true);
    loadToken();
    bindEvents();
    validateStoredToken();
    route();
  }

  function loadTheme() {
    applyTheme(localStorage.getItem(STORAGE.theme) === 'light' ? 'light' : 'dark');
  }
  function applyTheme(theme) {
    const light = theme === 'light';
    document.documentElement.dataset.theme = theme;
    for (const id of themeButtons) {
      els[id].textContent = light ? '☀' : '☾';
      els[id].setAttribute('aria-pressed', String(light));
    }
    if (state.editor) state.monaco.editor.setTheme(light ? 'typst-light' : 'typst-dark');
  }
  function toggleTheme() {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    localStorage.setItem(STORAGE.theme, next);
  }
  function toggleGrammar() {
    setGrammarEnabled(!state.grammarEnabled);
    localStorage.setItem(STORAGE.grammar, String(state.grammarEnabled));
  }
  function setGrammarEnabled(enabled) {
    state.grammarEnabled = enabled;
    els['grammar-toggle-btn'].setAttribute('aria-pressed', String(enabled));
    if (enabled) {
      if (state.monaco && !state.grammarQuickFixes) registerGrammarQuickFixes();
      if (state.openPath) scheduleGrammarCheck();
    } else {
      state.grammarQuickFixes?.dispose();
      state.grammarQuickFixes = null;
      stopGrammarCheck();
    }
  }
  function loadToken() {
    state.token = sessionStorage.getItem(STORAGE.token) || localStorage.getItem(STORAGE.token) || null;
    state.codebergToken = sessionStorage.getItem(STORAGE.codebergToken) || localStorage.getItem(STORAGE.codebergToken) || null;
    updateAccountUI();
  }
  async function validateStoredToken() {
    const token = state.token;
    if (!token) return;
    try {
      const profile = await requestGitHubProfile(token);
      if (state.token !== token) return;
      state.profile = profile;
    } catch (error) {
      if (state.token === token && error.status === 401) clearToken('github');
    }
    updateAccountUI();
  }
  function requestGitHubProfile(token) {
    if (githubProfileRequest?.token !== token) {
      githubProfileRequest = { token, promise: github.getProfile(token) };
    }
    return githubProfileRequest.promise;
  }
  function repositoryToken(provider = state.provider) {
    return provider === 'codeberg' ? state.codebergToken : state.token;
  }
  function saveToken(token, remember, provider) {
    const key = provider === 'codeberg' ? STORAGE.codebergToken : STORAGE.token;
    sessionStorage.removeItem(key);
    localStorage.removeItem(key);
    (remember ? localStorage : sessionStorage).setItem(key, token);
    if (provider === 'codeberg') state.codebergToken = token;
    else state.token = token;
  }
  function clearToken(provider) {
    const key = provider === 'codeberg' ? STORAGE.codebergToken : STORAGE.token;
    sessionStorage.removeItem(key);
    localStorage.removeItem(key);
    if (provider === 'codeberg') {
      state.codebergToken = null;
      state.codebergProfile = null;
    } else {
      state.token = null;
      state.profile = null;
    }
    updateAccountUI();
  }
  function updateAccountUI() {
    const connected = Boolean(state.token && state.profile);
    els['connect-github-btn']?.classList.toggle('connected', connected);
    els['connect-codeberg-btn']?.classList.toggle('connected', Boolean(state.codebergToken));
    if (els['github-account-label']) els['github-account-label'].textContent = connected ? state.profile.login : (state.token ? 'Connecting…' : 'Connect GitHub');
    if (els['codeberg-account-label']) els['codeberg-account-label'].textContent = state.codebergToken ?
      (state.codebergProfile?.login || 'Codeberg token saved') : 'Connect Codeberg';
    if (els['editor-account-btn']) {
      const codeberg = state.provider === 'codeberg';
      const profile = codeberg ? state.codebergProfile : state.profile;
      const label = `${repositoryProviderLabel()} account`;
      els['editor-account-btn'].textContent = profile?.login?.slice(0, 2).toUpperCase() || (codeberg ? 'CB' : 'GH');
      els['editor-account-btn'].title = label;
      els['editor-account-btn'].setAttribute('aria-label', label);
    }
    els['disconnect-github-btn']?.classList.toggle('hidden', !repositoryToken(state.authProvider));
  }

  function bindEvents() {
    projectTools = window.createProjectTools?.({
      getScope: () => [state.repositoryLoadSerial, state.fileIndex, state.branch, repositoryToken()],
      getTextFiles: () => effectivePaths().filter(isTextPath).map(path => ({ path, size: state.fileIndex.get(path)?.size || 0 })),
      getEntry: () => state.mainPath,
      readText: readProjectToolText,
      resolveReference: resolveTypstReference,
      jump: ({ path, line, column, length }) => openFileAtOffset(path, 0, length, { line, column }),
      replace: replaceProjectToolMatches,
      afterReplace: () => scheduleCompile(0),
      report: toast,
    });
    window.addEventListener('hashchange', route);
    window.addEventListener('pagehide', () => { void persistDraft(); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void persistDraft();
    });
    for (const id of themeButtons) els[id].addEventListener('click', toggleTheme);
    els['grammar-toggle-btn'].addEventListener('click', toggleGrammar);
    els['connect-github-btn'].addEventListener('click', () => openAuthModal('github'));
    els['connect-codeberg-btn'].addEventListener('click', () => openAuthModal('codeberg'));
    els['editor-account-btn'].addEventListener('click', () => openAuthModal());
    els['open-repo-form'].addEventListener('submit', e => { e.preventDefault(); navigateToRepoInput(els['repo-url-input'].value); });
    els['recent-search-input'].addEventListener('input', renderRecents);
    els['github-search-form'].addEventListener('submit', handleRepoSearch);
    els['repo-search-provider'].addEventListener('change', () => {
      repoSearchRequest++;
      els['github-search-results'].replaceChildren();
    });
    els['repo-title-btn'].addEventListener('click', () => { if (state.repo) window.open(state.repo.html_url, '_blank', 'noopener'); });
    els['branch-select'].addEventListener('change', onBranchChange);
    els['refresh-repo-btn'].addEventListener('click', syncCurrentRepository);
    els['discard-draft-btn']?.addEventListener('click', discardWorkingDraft);
    els['apply-sync-btn']?.addEventListener('click', resolveSyncConflicts);
    els['publish-branch-btn']?.addEventListener('click', openBranchModal);
    els['branch-run-btn']?.addEventListener('click', runBranchWorkflow);
    els['branch-reset-btn']?.addEventListener('click', resetBranchWorkflow);
    els['branch-create-pr']?.addEventListener('change', updateBranchWorkflowUI);
    els['branch-current']?.addEventListener('change', updateBranchWorkflowUI);
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
    els['save-github-token-btn'].addEventListener('click', connectRepositoryAccount);
    els['disconnect-github-btn'].addEventListener('click', async () => {
      const provider = state.authProvider;
      if (state.repositoryOperation || !await persistDraft()) return;
      state.authAttempt++;
      clearToken(provider);
      closeModal();
      toast(`${repositoryProviderLabel(provider)} account disconnected.`);
      await changeDraftAccount(provider, false);
    });
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
    for (const button of els['workspace-switcher'].querySelectorAll('button')) {
      button.addEventListener('click', () => setWorkspacePane(button.dataset.workspacePane));
    }
    setupResizer(els['sidebar-resizer'], 'sidebar');
    setupResizer(els['preview-resizer'], 'preview');
  }

  function setWorkspacePane(pane) {
    const workspace = els['editor-workspace'];
    if (!workspace || workspace.dataset.pane === pane) return;
    const preview = els['preview-scroll'];
    if (workspace.dataset.pane === 'preview' && preview.clientWidth) {
      state.workspacePreviewScroll = { top: preview.scrollTop, left: preview.scrollLeft };
    }
    workspace.dataset.pane = pane;
    for (const button of els['workspace-switcher'].querySelectorAll('button')) {
      button.setAttribute('aria-pressed', String(button.dataset.workspacePane === pane));
    }
    if (pane === 'editor') layoutEditor();
    if (pane === 'preview') {
      if (state.previewFit) fitPreviewWidth();
      if (state.workspacePreviewScroll) {
        preview.scrollTo(state.workspacePreviewScroll);
        state.workspacePreviewScroll = null;
      }
    }
  }

  function revealEditorPane() {
    if (isNarrowWorkspace()) setWorkspacePane('editor');
  }

  function isNarrowWorkspace() {
    return window.matchMedia?.('(max-width: 960px)').matches;
  }

  function layoutEditor() {
    if (!state.editor || els['editor-container'].classList.contains('hidden')) return;
    const rect = els['editor-container'].getBoundingClientRect();
    const width = Math.floor(rect.width);
    const height = Math.floor(rect.height);
    if (width > 0 && height > 0) state.editor.layout({ width, height });
  }

  function scheduleEditorLayout() {
    if (!state.editor) return;
    if (state.editorLayoutFrame) cancelAnimationFrame(state.editorLayoutFrame);
    state.editorLayoutFrame = requestAnimationFrame(() => {
      state.editorLayoutFrame = 0;
      layoutEditor();
    });
  }

  function settleEditorLayout(resetScroll = false) {
    // A later preview/diagnostic jump must win over opening a file. Reset now,
    // before callers select/reveal their target, never in a queued frame.
    if (resetScroll && state.editor) {
      state.editor.setScrollTop(0);
      state.editor.setScrollLeft(0);
    }
    scheduleEditorLayout();
    requestAnimationFrame(() => {
      scheduleEditorLayout();
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
    if (state.grammarEnabled) registerGrammarQuickFixes();
    defineMonacoThemes();
    const fontSize = Math.max(11, Math.min(22, Number(localStorage.getItem(STORAGE.fontSize) || 14)));
    document.documentElement.style.setProperty('--editor-font-size', `${fontSize}px`);
    state.editor = state.monaco.editor.create(els['editor-container'], {
      model: null,
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
    let inserted = '';
    for (const { text } of changeEvent.changes) {
      if (inserted.length + text.length > 4) return;
      inserted += text;
    }
    if (!/[A-Za-z0-9_./-]$/.test(inserted)) return;
    const path = state.openPath;
    const revision = state.editRevision;
    const repositorySerial = state.repositoryLoadSerial;
    setTimeout(() => {
      if (path !== state.openPath || revision !== state.editRevision ||
          repositorySerial !== state.repositoryLoadSerial || !state.editor.hasTextFocus()) return;
      if (getTypstFileArgumentContext(state.editor.getModel(), state.editor.getPosition())) {
        state.editor.trigger('typst-file-path', 'editor.action.triggerSuggest', {});
      }
    }, 0);
  }

  function clearGrammarMarkers() {
    if (!state.grammarResult) return;
    state.monaco.editor.setModelMarkers(state.grammarResult.model, 'grammar', []);
    state.grammarResult = null;
  }

  function stopGrammarCheck() {
    clearTimeout(state.grammarTimer);
    state.grammarTimer = null;
    state.grammarWorker?.terminate();
    state.grammarWorker = null;
    state.grammarInFlight = null;
    clearGrammarMarkers();
  }

  function scheduleGrammarCheck() {
    clearTimeout(state.grammarTimer);
    state.grammarTimer = setTimeout(() => {
      state.grammarTimer = null;
      requestGrammarCheck();
    }, 300);
  }

  function isCurrentGrammarCheck(check) {
    return state.grammarEnabled && check.serial === state.repositoryLoadSerial &&
      check.path === state.openPath && check.model === state.editor?.getModel() &&
      check.version === check.model.getVersionId();
  }

  function requestGrammarCheck() {
    if (!state.grammarEnabled || state.grammarInFlight || ext(state.openPath || '') !== 'typ' ||
        els['editor-view'].classList.contains('hidden') || els['editor-container'].classList.contains('hidden')) return;
    const model = state.editor?.getModel();
    if (!model) return;
    const check = {
      id: ++state.grammarRequestId, serial: state.repositoryLoadSerial,
      path: state.openPath, model, version: model.getVersionId(),
    };
    try {
      if (!state.grammarWorker) {
        const worker = new Worker(new URL('./grammar-worker.js', document.baseURI));
        state.grammarWorker = worker;
        worker.onmessage = ({ data }) => {
          const current = state.grammarInFlight;
          if (state.grammarWorker !== worker || !current || data?.id !== current.id) return;
          state.grammarInFlight = null;
          if (data.error) { grammarCheckFailed(); return; }
          if (isCurrentGrammarCheck(current)) showGrammarSuggestions(current, data.diagnostics);
          else if (state.grammarTimer == null) requestGrammarCheck();
        };
        worker.onerror = event => {
          event.preventDefault();
          if (state.grammarWorker === worker) grammarCheckFailed();
        };
        worker.onmessageerror = () => {
          if (state.grammarWorker === worker) grammarCheckFailed();
        };
      }
      state.grammarInFlight = check;
      state.grammarWorker.postMessage({ id: check.id, path: check.path, text: model.getValue() });
    } catch {
      grammarCheckFailed();
    }
  }

  function grammarCheckFailed() {
    setGrammarEnabled(false);
    localStorage.setItem(STORAGE.grammar, 'false');
    toast('Grammar checker stopped. Turn it on to retry.', 'error');
  }

  function showGrammarSuggestions(check, diagnostics) {
    const fixes = diagnostics.map(({ start, end, message, replacement }) => {
      const from = check.model.getPositionAt(start);
      const to = check.model.getPositionAt(end);
      const marker = {
        startLineNumber: from.lineNumber, startColumn: from.column,
        endLineNumber: to.lineNumber, endColumn: to.column,
        message, source: 'Grammar', severity: state.monaco.MarkerSeverity.Info,
      };
      return { start, end, marker, replacement };
    });
    state.grammarResult = { ...check, fixes };
    state.monaco.editor.setModelMarkers(check.model, 'grammar', fixes.map(fix => fix.marker));
  }

  function registerGrammarQuickFixes() {
    state.grammarQuickFixes = state.monaco.languages.registerCodeActionProvider('typst', {
      provideCodeActions(model, range) {
        const result = state.grammarResult;
        const actions = [];
        if (result?.model === model && isCurrentGrammarCheck(result)) {
          const start = model.getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn });
          const end = model.getOffsetAt({ lineNumber: range.endLineNumber, column: range.endColumn });
          for (const fix of result.fixes) {
            if (fix.end < start || fix.start > end) continue;
            actions.push({
              title: fix.replacement ? `Replace with “${fix.replacement}”` : 'Remove repeated word',
              kind: 'quickfix',
              diagnostics: [fix.marker],
              edit: { edits: [{
                resource: model.uri, versionId: result.version,
                textEdit: { range: fix.marker, text: fix.replacement },
              }] },
            });
          }
        }
        return { actions, dispose() {} };
      },
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
        // Never move WebAssembly onto the input thread after a worker failure.
        window.$typst = null;
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
      isWorkerRuntime: true,
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
        if (typeof Worker !== 'function') throw new Error('Live preview requires Web Workers. Open this site in a current browser over HTTP or HTTPS. Your editor remains available.');
        if (!window.$typst?.isWorkerRuntime) window.$typst = await createWorkerTypstRuntime();
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
    if (parsed?.type === 'repo' && isRepositoryLoaded(parsed.owner, parsed.repo, parsed.branch, parsed.provider)) return;
    void persistDraft();
    const serial = ++state.repositoryLoadSerial;
    if (['text-prompt-modal', 'image-paste-modal', 'commit-modal', 'sync-modal', 'branch-modal'].includes(state.activeModal)) closeModal();
    if (!parsed || parsed.type === 'home') {
      showHome();
      return;
    }
    if (parsed.type === 'repo') openRepository(parsed.owner, parsed.repo, parsed.branch, serial, parsed.provider).catch(err => {
      if (serial === state.repositoryLoadSerial) handleFatalRepoError(err);
    });
  }

  function parseHash() {
    const hash = location.hash || '#/';
    const [pathPart, queryPart] = hash.slice(1).split('?');
    const parts = pathPart.split('/').filter(Boolean);
    if (!parts.length) return { type: 'home' };
    if (parts[0] === 'repo' && parts.length >= 3) {
      const provider = parts.length >= 4 && parts[1] === 'codeberg' ? 'codeberg' : 'github';
      const ownerIndex = provider === 'codeberg' ? 2 : 1;
      try {
        return {
          type: 'repo', provider,
          owner: decodeURIComponent(parts[ownerIndex]),
          repo: decodeURIComponent(parts[ownerIndex + 1]),
          branch: new URLSearchParams(queryPart || '').get('branch'),
        };
      } catch {
        return { type: 'home' };
      }
    }
    return { type: 'home' };
  }

  function showHome() {
    clearTimeout(state.compileTimer);
    state.compileTimer = null;
    state.compileDueAt = 0;
    state.compileSerial++;
    if (state.grammarEnabled) stopGrammarCheck();
    cancelPreviewSourceAnchorIndexing();
    els['editor-view'].classList.add('hidden');
    els['home-view'].classList.remove('hidden');
    renderRecents();
  }

  function repoHash(provider, owner, repo, branch) {
    const prefix = provider === 'codeberg' ? 'codeberg/' : '';
    const query = branch ? `?branch=${enc(branch)}` : '';
    return `#/repo/${prefix}${enc(owner)}/${enc(repo)}${query}`;
  }

  function navigateToRepoInput(value) {
    try {
      const { provider, owner, repo } = parseRepoInput(value);
      location.hash = repoHash(provider, owner, repo);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function parseRepoInput(value) {
    const input = String(value || '').trim();
    if (!input) throw new Error('Enter a GitHub or Codeberg repository URL.');
    let provider = 'github';
    let path = input;
    if (/^https?:\/\//i.test(input) || /^(?:www\.)?(?:github\.com|codeberg\.org)\//i.test(input)) {
      const url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
      if (/^(?:www\.)?codeberg\.org$/i.test(url.hostname)) provider = 'codeberg';
      else if (!/(^|\.)github\.com$/i.test(url.hostname)) throw new Error('Use a github.com or codeberg.org repository URL.');
      path = url.pathname;
    }
    const [ownerPart, repoPart] = path.split('/').filter(Boolean);
    if (!ownerPart || !repoPart) throw new Error('Use owner/repository or a full GitHub or Codeberg URL.');
    const owner = decodeURIComponent(ownerPart);
    const repo = decodeURIComponent(repoPart).replace(/\.git$/i, '');
    if (!repo) throw new Error('Invalid repository name.');
    return { provider, owner, repo };
  }

  function isRepositoryLoaded(owner, repo, requestedBranch, provider = 'github') {
    return !els['editor-view'].classList.contains('hidden') && state.editor && state.headSha &&
      (!state.mainPath || (state.openPath && state.compilerHydrated)) &&
      state.provider === provider && state.repo?.owner?.login === owner && state.repo?.name === repo &&
      state.branch === (requestedBranch || state.repo.default_branch);
  }

  async function openRepository(owner, repo, requestedBranch, serial, provider = 'github', force = false) {
    if (!force && isRepositoryLoaded(owner, repo, requestedBranch, provider)) return;
    if (serial === undefined) serial = ++state.repositoryLoadSerial;
    resetProjectState();
    state.provider = provider;
    if (els['editor-workspace']) els['editor-workspace'].inert = true;
    updateAccountUI();
    els['home-view'].classList.add('hidden');
    els['editor-view'].classList.remove('hidden');
    setCompileStatus('busy', 'Loading repository');
    const providerLabel = repositoryProviderLabel(provider);
    setSyncStatus(`Reading ${providerLabel}…`);

    const editorReady = ensureMonaco();
    // Attach handlers immediately while repository requests run in parallel.
    editorReady.catch(() => {});
    ensureTypstRuntime().catch(err => {
      if (serial === state.repositoryLoadSerial) showCompileError(err);
    });

    const client = provider === 'codeberg' ? await ensureCodebergClient() : repositoryClient(provider);
    if (serial !== state.repositoryLoadSerial) return;
    const draftAccount = working && typeof indexedDB !== 'undefined' ? identifyDraftAccount() : null;
    draftAccount?.catch(() => {});
    const meta = await client.getRepo(owner, repo);
    if (serial !== state.repositoryLoadSerial) return;
    state.repo = meta;
    state.branch = requestedBranch || meta.default_branch;
    updateRepoHeader();

    renderBranches();
    client.getBranches(owner, repo).then(branches => {
      if (serial !== state.repositoryLoadSerial) return;
      state.branches = branches;
      renderBranches();
    }).catch(() => {});
    const ref = await client.getRef(owner, repo, state.branch);
    if (serial !== state.repositoryLoadSerial) return;
    if (!await loadTreeAtRef(ref.object.sha, serial, client)) return;
    await restoreWorkingDraft(serial, draftAccount);
    if (serial !== state.repositoryLoadSerial) return;
    if (els['editor-workspace']) els['editor-workspace'].inert = false;
    updateChangeUI();
    chooseInitialMainFile();
    renderFileTree();
    addRecentProject();

    const openingFile = state.mainPath ? openFile(state.mainPath, { reveal: false, focus: true }) : editorReady;
    const hydratingFiles = hydrateCompilerFS();
    // Share the main file request and discover dependencies while Monaco loads.
    hydratingFiles.catch(() => {});
    await openingFile;
    if (serial !== state.repositoryLoadSerial) return;
    if (!state.mainPath) showNoTypstFiles();

    setSyncStatus(state.syncPlan ? 'Resolve sync conflicts' : `${providerLabel} • ${state.branch}`);
    hydratingFiles.then(() => {
      if (serial === state.repositoryLoadSerial) scheduleCompile(0);
    }).catch(showCompileError);
  }

  async function loadTreeAtRef(commitSha, serial = state.repositoryLoadSerial, client = repositoryClient()) {
    const { owner, name: repo } = state.repo;
    const commit = await client.getCommit(owner.login, repo, commitSha);
    if (serial !== state.repositoryLoadSerial) return false;
    const tree = await client.getTree(owner.login, repo, commit.tree.sha);
    if (serial !== state.repositoryLoadSerial) return false;
    if (tree.truncated) toast(`This repository is very large. ${repositoryProviderLabel()} returned a truncated file tree.`, 'error', 6000);
    state.headSha = commitSha;
    state.baseTreeSha = commit.tree.sha;
    state.rawTree = tree.tree || [];
    state.baseFiles = indexRevision(state.rawTree);
    state.fileIndex = new Map(state.baseFiles);
    invalidatePathCaches();
    els['file-count-label'].textContent = `${state.fileIndex.size} files`;
    return true;
  }

  function resetProjectState() {
    projectTools?.reset();
    void persistDraft();
    state.draft = null;
    state.workingRevision++;
    state.editorDraftRevision = -1;
    state.syncPlan = null;
    state.repositoryOperation = null;
    state.commitReview = null;
    state.branchReview = null;
    state.branchWorkflow = null;
    clearTimeout(state.compileTimer);
    state.compileTimer = null;
    state.compileDueAt = 0;
    clearTimeout(state.fileTreeRenderTimer);
    clearTimeout(state.editorSyncTimer);
    if (state.grammarEnabled) stopGrammarCheck();
    resetOpenTabs();
    state.workspacePreviewScroll = null;
    cancelPreviewSourceAnchorIndexing();
    disposePreviewPages();
    state.repo = null; state.branch = null; state.branches = []; state.headSha = null; state.baseTreeSha = null;
    state.rawTree = []; state.baseFiles = new Map(); state.fileIndex = new Map(); state.fileBytes = new Map(); state.fileRequests = new Map(); state.originalBytes = new Map(); state.sourceTextCache = new Map(); state.changes = new Map();
    state.pathsCache = null; state.typPathsCache = null; state.treeCache = null; state.fileTreeRows = new Map(); state.fileTreeRenderTimer = null;
    state.editorSyncTimer = null; state.editorSyncPending = false; state.editorSyncPath = null; state.shadowSyncPromise = null;
    state.openPath = null; state.mainPath = null; state.deletedPaths = new Set(); state.expandedFolders = new Set();
    state.compilerHydrated = false; state.compilerHydrating = false; state.compilerHydrationPromise = null; state.compilerNeedsReset = true;
    state.fontLoadDiagnostics = [];
    state.compileInFlight = false; state.compileQueued = false; state.compilePromise = null; state.compileSerial++;
    state.diagnostics = []; state.sourceSearchOrder = null; state.previewLastJump = null; state.previewSourceAnchors = []; state.previewAnchorMap = new WeakMap();
    if (state.previewSvgCache?.mode === 'cards') els['preview-output'].style.gap = state.previewSvgCache.previousGap;
    state.previewSvgCache = null;
    els['preview-output'].innerHTML = '';
    els['preview-error'].classList.add('hidden');
    els['diagnostic-list'].innerHTML = '';
    els['preview-error-text'].classList.add('hidden');
    els['preview-loading'].classList.remove('hidden');
    updateChangeUI();
    showDraftStatus();
  }

  function updateRepoHeader() {
    const r = state.repo;
    els['repo-owner-label'].textContent = r.owner.login;
    els['repo-name-label'].textContent = r.name;
    els['repo-private-badge'].classList.toggle('hidden', !r.private);
    const providerLabel = repositoryProviderLabel();
    els['repo-title-btn'].title = `Open ${r.full_name} on ${providerLabel}`;
    els['refresh-repo-btn'].title = `Sync with ${providerLabel}`;
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
    if (state.repositoryOperation || !await persistDraft()) { els['branch-select'].value = state.branch; return; }
    location.hash = repoHash(state.provider, state.repo.owner.login, state.repo.name, next);
  }

  let draftWrites = Promise.resolve();

  function indexRevision(tree) {
    return new Map(tree.filter(item => item.type === 'blob').map(item => [item.path, { ...item, existing: true }]));
  }

  function draftScope(account, branch = state.branch) {
    return JSON.stringify([state.provider, state.repo.owner.login.toLowerCase(), state.repo.name.toLowerCase(), branch, account]);
  }

  async function identifyDraftAccount() {
    const { provider, repositoryLoadSerial } = state;
    const token = repositoryToken(provider);
    if (!token) return 'anonymous';
    let profile = provider === 'github' ? state.profile : state.codebergProfile;
    if (!profile) profile = await (provider === 'github' ? requestGitHubProfile(token) : repositoryClient().getProfile(token)).catch(() => null);
    if (repositoryLoadSerial !== state.repositoryLoadSerial || token !== repositoryToken(provider)) {
      throw new Error('The connected project or account changed while opening the draft.');
    }
    if (profile) {
      if (provider === 'codeberg') state.codebergProfile = profile;
      else state.profile = profile;
      updateAccountUI();
      return 'user:' + (profile.id ?? profile.login.toLowerCase());
    }
    // Repository-scoped tokens may lack permission to read their account.
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(token));
    return 'connection:' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function queueDraftSave(path) {
    const draft = state.draft;
    if (!draft) return;
    if (path !== undefined) draft.paths.add(path);
    if (!draft.timer) draft.timer = setTimeout(() => { void persistDraft(); }, 220);
  }

  function setWorkingChange(path, change) {
    if (change) state.changes.set(path, change);
    else state.changes.delete(path);
    state.workingRevision++;
    queueDraftSave(path);
  }

  function changeForBytes(path, bytes, renameFrom = state.changes.get(path)?.renameFrom) {
    const meta = state.fileIndex.get(path);
    if (meta?.existing && !renameFrom && sameBytes(state.originalBytes.get(path), bytes)) return null;
    return { type: meta?.existing ? 'modify' : 'add', bytes, renameFrom };
  }

  function captureEditorDraft(path) {
    if (state.draft && state.editorDraftRevision === state.editRevision && state.fileBytes.has(path) &&
        !state.changes.get(path)?.pending) return state.fileBytes.get(path);
    const text = state.editor.getValue();
    const bytes = encoder.encode(text);
    state.editorDraftRevision = state.editRevision;
    state.fileBytes.set(path, bytes);
    state.sourceTextCache.set(path, text);
    setWorkingChange(path, changeForBytes(path, bytes));
    updateChangeUI(path);
    updateFileTreeDirtyIndicator(path);
    return bytes;
  }

  function baseFile(path) {
    return state.baseFiles.get(path) || (state.fileIndex.get(path)?.existing ? state.fileIndex.get(path) : null);
  }

  function snapshotWorkingChanges() {
    return new Map([...state.changes].map(([path, change]) => {
      const meta = state.fileIndex.get(path);
      const base = baseFile(path);
      return [path, {
        type: change.type, bytes: change.bytes,
        sha: base?.sha, mode: meta?.mode || '100644',
        renameFrom: change.renameFrom || meta?.renameFrom,
        base: base && { path, sha: base.sha, mode: base.mode, size: base.size, type: 'blob', existing: true },
        baseBytes: state.originalBytes.get(path),
      }];
    }));
  }

  function showDraftStatus(draft = state.draft) {
    const el = els['draft-status'];
    if (!el) return;
    el.textContent = draft?.error ? 'Draft save unavailable' :
      draft?.savedAt && state.changes.size ? `Draft saved ${new Date(draft.savedAt).toLocaleTimeString()}` : '';
    el.title = draft?.error || (draft?.savedAt ? new Date(draft.savedAt).toLocaleString() : '');
  }

  function persistDraft() {
    const draft = state.draft;
    if (!draft) return Promise.resolve(true);
    if (state.editorSyncPending && state.editorSyncPath === state.openPath) captureEditorDraft(state.openPath);
    clearTimeout(draft.timer);
    draft.timer = null;
    if (!draft.paths.size && !draft.headerDirty) return draft.write || Promise.resolve(true);
    const changes = state.changes;
    const paths = draft.paths;
    draft.paths = new Set();
    draft.headerDirty = false;
    const updates = [...paths].map(path => {
      const change = changes.get(path);
      if (!change) return [path, null];
      const base = baseFile(path);
      return [path, {
        type: change.type, bytes: change.bytes, mode: state.fileIndex.get(path)?.mode,
        renameFrom: change.renameFrom,
        base: base && { path, type: 'blob', sha: base.sha, size: base.size, mode: base.mode, existing: true },
        baseBytes: state.originalBytes.get(path),
      }];
    });
    const header = {
      scope: draft.scope, headSha: state.headSha, treeSha: state.baseTreeSha, savedAt: Date.now(),
      workflow: state.branchWorkflow && { ...state.branchWorkflow }, keep: Boolean(changes.size || state.branchWorkflow),
    };
    draft.write = draftWrites = draftWrites.then(() => working.writeDraft(header, updates, draft.version || 0, draft.source)).then(version => {
      draft.version = version;
      draft.source = null;
      draft.savedAt = header.keep ? header.savedAt : null;
      draft.error = '';
      if (draft === state.draft) showDraftStatus();
      return true;
    }, error => {
      for (const path of paths) draft.paths.add(path);
      draft.headerDirty = true;
      draft.error = error.message;
      if (draft === state.draft) showDraftStatus();
      return false;
    });
    return draft.write;
  }

  function applyDraftChanges(changes) {
    state.changes = new Map();
    state.deletedPaths = new Set();
    for (const [path, change] of changes) {
      const base = state.baseFiles.get(path);
      state.changes.set(path, { type: change.type, bytes: change.bytes, renameFrom: change.renameFrom });
      if (change.baseBytes) state.originalBytes.set(path, change.baseBytes);
      if (change.type === 'delete') {
        state.deletedPaths.add(path);
        state.fileBytes.delete(path);
      } else {
        state.fileIndex.set(path, { ...base, path, type: 'blob', mode: change.mode || base?.mode || '100644',
          existing: Boolean(base), size: change.bytes.length, bytes: change.bytes, renameFrom: change.renameFrom });
        state.fileBytes.set(path, change.bytes);
      }
      state.sourceTextCache.delete(path);
    }
    invalidatePathCaches();
    state.workingRevision++;
    updateChangeUI();
  }

  async function restoreWorkingDraft(serial, accountRequest) {
    if (!working || typeof indexedDB === 'undefined') return;
    let draft;
    try {
      const account = await (accountRequest || identifyDraftAccount());
      if (serial !== state.repositoryLoadSerial) return;
      draft = { account, scope: draftScope(account), paths: new Set() };
      state.draft = draft;
      await draftWrites;
      const saved = await working.readDraft(draft.scope);
      if (state.draft !== draft || serial !== state.repositoryLoadSerial || !saved) return;
      state.branchWorkflow = saved.workflow;
      draft.savedAt = saved.savedAt;
      draft.version = saved.version;
      if (!saved.files.length) return;
      const latest = { sha: state.headSha, treeSha: state.baseTreeSha, tree: state.rawTree, files: state.baseFiles };
      if (saved.headSha !== latest.sha) {
        // Retain the original base while the user resolves conflicts. The
        // saved blob IDs still allow a merge if the old tree is unavailable.
        const previous = await repositoryClient().getTree(state.repo.owner.login, state.repo.name, saved.treeSha).catch(() => null);
        if (state.draft !== draft || serial !== state.repositoryLoadSerial) return;
        const oldTree = Array.isArray(previous?.tree) && !previous.truncated ? previous.tree : latest.tree;
        state.baseFiles = indexRevision(oldTree);
        for (const file of saved.files) {
          if (file.base) state.baseFiles.set(file.path, file.base);
          else state.baseFiles.delete(file.path);
        }
        state.fileIndex = new Map(state.baseFiles);
        state.rawTree = [...state.baseFiles.values()];
        state.headSha = saved.headSha;
        state.baseTreeSha = saved.treeSha;
      }
      applyDraftChanges(new Map(saved.files.map(file => [file.path, file])));
      if (saved.headSha !== latest.sha) await syncToRevision(latest, serial, true);
      if (state.draft !== draft || serial !== state.repositoryLoadSerial) return;
      showDraftStatus();
      toast('Restored your local draft.', 'success');
    } catch (error) {
      if (serial !== state.repositoryLoadSerial) return;
      if (draft) { draft.error = error.message; showDraftStatus(); }
      toast(`Draft recovery needs attention. ${error.message}`, 'error', 6000);
    }
  }

  async function changeDraftAccount(provider, carryAnonymous) {
    if (state.provider !== provider || !state.headSha || els['editor-view'].classList.contains('hidden')) return;
    const serial = state.repositoryLoadSerial;
    const { repo, branch, draft } = state;
    const operation = {};
    state.repositoryOperation = operation;
    updateChangeUI();
    try {
      if (draft) {
        const account = await identifyDraftAccount();
        if (serial !== state.repositoryLoadSerial || state.draft !== draft) return;
        if (account === draft.account) return;
        const scope = draftScope(account);
        if (carryAnonymous && draft.account === 'anonymous' && state.changes.size) {
          const existing = await working.readDraft(scope);
          if (serial !== state.repositoryLoadSerial || state.draft !== draft) return;
          if (!existing) {
            if (!await persistDraft() || serial !== state.repositoryLoadSerial || state.draft !== draft) return;
            state.draft = { account, scope, paths: new Set(state.changes.keys()),
              source: { scope: draft.scope, version: draft.version || 0 }, headerDirty: true };
            await persistDraft();
            return;
          }
        }
      }
      await openRepository(repo.owner.login, repo.name, branch, undefined, provider, true);
    } catch (error) {
      if (serial === state.repositoryLoadSerial) toast(error.message, 'error', 6000);
    } finally {
      finishRepositoryOperation(operation);
    }
  }

  function currentRepositoryContext() {
    const { provider, repo, branch, repositoryLoadSerial, fileIndex } = state;
    const token = repositoryToken(provider);
    return {
      provider, owner: repo.owner.login, name: repo.name, branch, client: repositoryClient(provider),
      isCurrent: () => state.repositoryLoadSerial === repositoryLoadSerial && state.fileIndex === fileIndex &&
        state.branch === branch && repositoryToken(provider) === token,
    };
  }

  async function fetchRevision(context, sha) {
    const commit = await context.client.getCommit(context.owner, context.name, sha);
    const result = await context.client.getTree(context.owner, context.name, commit.tree.sha);
    if (result.truncated) throw new Error('The remote file tree is incomplete. Sync needs a complete tree to preserve your changes.');
    const tree = result.tree || [];
    return { sha, treeSha: commit.tree.sha, tree, files: indexRevision(tree) };
  }

  async function fetchBaseBytes(context, meta) {
    if (!meta) return undefined;
    if (meta.size > MAX_SINGLE_BLOB_BYTES) throw new Error(`${meta.path} is too large for a line-by-line comparison.`);
    const blob = await context.client.getBlob(context.owner, context.name, meta.sha);
    return base64ToBytes(blob.content);
  }

  function sameBlob(a, b) {
    return a === b || Boolean(a && b && a.sha === b.sha);
  }

  function comparableText(path, ...values) {
    return isTextPath(path) && values.every(bytes => !bytes || !looksBinary(bytes));
  }

  function obstructedFiles(tree, changes) {
    const additions = new Set();
    for (const [path, change] of changes) if (change.type !== 'delete') additions.add(path);
    const files = new Set(tree.filter(item => item.type !== 'tree' && changes.get(item.path)?.type !== 'delete').map(item => item.path));
    const obstructed = new Set();
    for (const item of tree) if (item.type === 'commit' && additions.has(item.path)) obstructed.add(item.path);
    for (const path of additions) files.add(path);
    for (const path of files) {
      for (let folder = dirname(path); folder; folder = dirname(folder)) {
        if (additions.has(folder)) obstructed.add(folder);
        if (additions.has(path) && files.has(folder)) obstructed.add(path);
      }
    }
    return obstructed;
  }

  async function buildSyncPlan(latest, snapshot, context) {
    const base = state.baseFiles;
    const remote = latest.files;
    const moves = working.remoteMoves(base, remote);
    const groups = working.changeGroups(snapshot);
    const obstructed = obstructedFiles(latest.tree, snapshot);
    const entries = new Map();
    await pooled(groups, 4, async group => {
      const { path, from } = group;
      const local = snapshot.get(path);
      const movedTo = moves.get(from || path);
      const previous = base.get(path), next = remote.get(path);
      const keep = new Map(group.paths.map(key => [key, snapshot.get(key)]));
      if (movedTo && movedTo !== path && !snapshot.has(movedTo)) {
        keep.set(movedTo, { type: 'delete' });
        if (local.type !== 'delete') keep.set(path, { ...local, renameFrom: movedTo });
      }
      const entry = { group, keep };
      entries.set(path, entry);
      if (obstructed.has(path)) {
        entry.conflict = 'Remote files occupy this path. Use remote, or resolve later and rename the local file before syncing.';
        entry.remoteOnly = true;
        return;
      }
      if (from && movedTo === path) {
        keep.delete(from);
        entry.remoteBytes = snapshot.get(from).baseBytes;
        keep.set(path, { ...local, renameFrom: undefined, baseBytes: entry.remoteBytes });
        return;
      }
      if (!movedTo && sameBlob(previous, next) && (!from || sameBlob(base.get(from), remote.get(from)))) return;
      if (!from && local.type === 'delete' && !next && !movedTo) { keep.clear(); return; }

      const conflict = from || movedTo ? 'Rename conflict' :
        !next || local.type === 'delete' ? 'Delete conflict' : 'Both sides changed this file';
      entry.conflict = movedTo ? `${conflict} · Remote moved to ${movedTo}` : conflict;
      if (from && !remote.has(from) && next && next.size === local.bytes?.length && next.size <= MAX_DIFF_BYTES) {
        const theirs = await fetchBaseBytes(context, next).catch(() => null);
        if (sameBytes(local.bytes, theirs)) { keep.clear(); entry.conflict = null; return; }
        entry.remoteBytes = theirs;
      }
      if (!from && next && local.bytes) {
        if (!comparableText(path, local.bytes, local.baseBytes)) entry.conflict = 'Binary conflict';
        // Large or non-text rewrites can use whole-file choices.
        if (Math.max(previous?.size || 0, local.bytes.length, next.size || 0) > MAX_DIFF_BYTES) return;
        try {
          const [before, theirs] = await Promise.all([
            local.baseBytes || fetchBaseBytes(context, previous), fetchBaseBytes(context, next),
          ]);
          if (sameBytes(local.bytes, theirs)) { keep.clear(); entry.conflict = null; return; }
          entry.remoteBytes = theirs;
          keep.set(path, { ...local, baseBytes: theirs });
          if (!comparableText(path, before, local.bytes, theirs)) {
            entry.conflict = 'Binary conflict';
            return;
          }
          let baseText, localText, remoteText;
          try {
            baseText = before ? diffDecoder.decode(before) : '';
            localText = diffDecoder.decode(local.bytes);
            remoteText = diffDecoder.decode(theirs);
          } catch {
            entry.conflict = 'Binary or non-UTF-8 conflict';
            return;
          }
          const merged = before ? working.mergeText(baseText, localText, remoteText) : null;
          if (merged !== null) {
            if (merged === remoteText) keep.clear();
            else keep.set(path, { ...local, bytes: encoder.encode(merged), baseBytes: theirs });
            entry.conflict = null;
          } else entry.text = { base: baseText, local: localText, remote: remoteText };
        } catch (error) {
          entry.conflict += ` · ${error.message}`;
        }
      }
    });
    return { latest, entries: groups.map(group => entries.get(group.path)), moves };
  }

  async function syncToRevision(latest, serial, initial = false) {
    const context = currentRepositoryContext();
    const revision = state.workingRevision;
    const edit = state.editRevision;
    const plan = await buildSyncPlan(latest, snapshotWorkingChanges(), context);
    if (!context.isCurrent() || serial !== state.repositoryLoadSerial) return;
    if (revision !== state.workingRevision || edit !== state.editRevision) {
      throw new Error('The draft changed while syncing. Sync again to include those edits.');
    }
    Object.assign(plan, { revision, edit });
    if (plan.entries.some(entry => entry.conflict)) {
      state.syncPlan = plan;
      updateChangeUI();
      openSyncResolution(plan);
    } else {
      await installSyncPlan(plan, new Map(), initial);
      if (!initial && serial === state.repositoryLoadSerial) toast('Synced the branch and kept your working changes.', 'success');
    }
  }

  async function syncCurrentRepository() {
    if (!state.repo || !state.headSha || state.repositoryOperation || els['editor-workspace']?.inert) return;
    const context = currentRepositoryContext();
    const operation = {};
    state.repositoryOperation = operation;
    updateChangeUI();
    setSyncStatus(`Checking ${repositoryProviderLabel()}…`);
    try {
      await flushEditorSync();
      const ref = await context.client.getRef(context.owner, context.name, context.branch);
      if (!context.isCurrent()) return;
      if (ref.object.sha === state.headSha) {
        state.syncPlan = null;
        toast('This branch is up to date.');
        return;
      }
      const latest = await fetchRevision(context, ref.object.sha);
      if (!context.isCurrent()) return;
      await syncToRevision(latest, state.repositoryLoadSerial);
    } catch (error) {
      if (context.isCurrent()) toast(error.message, 'error', 6000);
    } finally {
      finishRepositoryOperation(operation);
    }
  }

  function finishRepositoryOperation(operation) {
    if (state.repositoryOperation !== operation) return;
    state.repositoryOperation = null;
    updateChangeUI();
    setSyncStatus(state.syncPlan ? 'Resolve sync conflicts' : `${repositoryProviderLabel()} • ${state.branch}`);
  }

  function openSyncResolution(plan) {
    const list = els['sync-conflicts'];
    list.replaceChildren();
    for (const entry of plan.entries.filter(item => item.conflict)) {
      const block = document.createElement('section');
      block.className = 'sync-conflict';
      const title = document.createElement('strong');
      title.textContent = entry.group.from ? `${entry.group.from} → ${entry.group.path}` : entry.group.path;
      const explanation = document.createElement('p');
      explanation.textContent = entry.conflict;
      const choice = document.createElement('select');
      choice.className = 'text-input';
      choice.setAttribute('aria-label', `Resolve ${entry.group.path}`);
      choice.append(new Option('Choose a resolution', ''));
      if (!entry.remoteOnly) choice.append(new Option('Keep local changes', 'local'));
      choice.append(new Option('Use remote version', 'remote'));
      entry.choice = choice;
      block.append(title, explanation, choice);
      if (entry.text) {
        choice.append(new Option('Edit merged text', 'manual'));
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = 'Compare original, local, and remote text';
        details.append(summary);
        details.addEventListener('toggle', () => {
          if (!details.open || details.children.length > 1) return;
          for (const [label, text] of Object.entries(entry.text)) {
            const caption = document.createElement('strong');
            caption.textContent = label;
            const pre = document.createElement('pre');
            pre.textContent = text;
            details.append(caption, pre);
          }
        });
        const input = document.createElement('textarea');
        input.className = 'text-input hidden';
        input.setAttribute('aria-label', `Merged text for ${entry.group.path}`);
        input.rows = 8;
        entry.input = input;
        choice.addEventListener('change', () => {
          input.classList.toggle('hidden', choice.value !== 'manual');
          if (choice.value === 'manual' && !entry.manualStarted) {
            entry.manualStarted = true;
            input.value = entry.text.local;
          }
        });
        block.append(details, input);
      }
      list.append(block);
    }
    els['sync-error'].classList.add('hidden');
    openModal('sync-modal');
    setSyncStatus('Resolve sync conflicts');
  }

  async function resolveSyncConflicts() {
    const plan = state.syncPlan;
    if (!plan || state.repositoryOperation) return;
    if (plan.revision !== state.workingRevision || plan.edit !== state.editRevision) {
      return showInlineError(els['sync-error'], 'The draft changed. Run Sync again before applying these choices.');
    }
    const choices = new Map();
    for (const entry of plan.entries) {
      if (!entry.conflict) continue;
      const choice = entry.choice.value;
      if (!choice) return showInlineError(els['sync-error'], 'Choose a resolution for each conflict.');
      choices.set(entry.group.path, { choice, text: entry.input?.value });
    }
    const operation = {};
    state.repositoryOperation = operation;
    updateChangeUI();
    try {
      await installSyncPlan(plan, choices);
      if (state.repositoryOperation === operation) {
        if (state.activeModal === 'sync-modal') closeModal();
        toast('Applied sync resolutions.', 'success');
      }
    } catch (error) {
      if (state.repositoryOperation === operation) showInlineError(els['sync-error'], error.message);
    } finally {
      finishRepositoryOperation(operation);
    }
  }

  async function installSyncPlan(plan, choices, initial = false) {
    const { latest, entries, moves } = plan;
    const nextChanges = new Map();
    for (const entry of entries) {
      const decision = choices.get(entry.group.path);
      if (decision?.choice === 'remote') continue;
      for (const [path, change] of entry.keep) {
        const base = latest.files.get(path);
        const manual = decision?.choice === 'manual' && path === entry.group.path;
        const bytes = manual ? encoder.encode(decision.text) : change.bytes;
        const original = sameBlob(base, state.baseFiles.get(path)) ? change.baseBytes :
          (path === entry.group.path ? entry.remoteBytes : undefined);
        if (change.type === 'delete' ? !base : !change.renameFrom && sameBytes(bytes, original)) continue;
        nextChanges.set(path, { ...change, bytes, baseBytes: original, mode: base?.mode || change.mode,
          type: change.type === 'delete' ? 'delete' : base ? 'modify' : 'add',
          renameFrom: latest.files.has(change.renameFrom) ? change.renameFrom : undefined });
      }
    }
    const changedPaths = new Set();
    const [obstruction] = obstructedFiles(latest.tree, nextChanges);
    if (obstruction) throw new Error(`The chosen resolutions conflict at ${obstruction}. Rename the local file or choose the remote version.`);
    for (const path of new Set([...state.baseFiles.keys(), ...latest.files.keys(), ...state.changes.keys(), ...nextChanges.keys()])) {
      const wasDeleted = state.deletedPaths.has(path);
      const now = nextChanges.get(path);
      const nextBase = latest.files.get(path);
      const isDeleted = now?.type === 'delete' || (!now && !nextBase);
      const working = state.changes.get(path);
      const unchanged = wasDeleted === isDeleted && (isDeleted ||
        (now ? sameBytes(now.bytes, working?.bytes) : !working && sameBlob(state.baseFiles.get(path), nextBase)));
      if (!unchanged) changedPaths.add(path);
      if (!sameBlob(state.baseFiles.get(path), nextBase)) state.originalBytes.delete(path);
    }
    const dirtyPaths = new Set([...state.changes.keys(), ...nextChanges.keys()]);
    for (const path of changedPaths) {
      state.fileBytes.delete(path);
      state.sourceTextCache.delete(path);
    }
    // New map identity cancels in-flight blob loads and preview hydration.
    state.headSha = latest.sha;
    state.baseTreeSha = latest.treeSha;
    state.rawTree = latest.tree;
    state.baseFiles = latest.files;
    state.fileIndex = new Map(latest.files);
    state.fileRequests = new Map();
    state.syncPlan = null;
    state.editRevision++;
    state.compilerNeedsReset = true;
    state.compilerHydrated = false;
    state.compilerHydrationPromise = null;
    state.compileSerial++;
    applyDraftChanges(nextChanges);
    if (state.draft) {
      state.draft.headerDirty = true;
      for (const path of dirtyPaths) state.draft.paths.add(path);
      void persistDraft();
    }
    if (initial) return;
    const serial = state.repositoryLoadSerial;
    const index = state.fileIndex;
    if (!state.mainPath || !index.has(state.mainPath) || state.deletedPaths.has(state.mainPath)) {
      const moved = moves.get(state.mainPath);
      if (moved && index.has(moved) && !state.deletedPaths.has(moved)) state.mainPath = moved;
      else chooseInitialMainFile();
    }
    els['main-file-label'].textContent = state.mainPath || 'Choose file';
    renderFileTree();
    if (state.editor) state.editor.updateOptions({ readOnly: true });
    try {
      for (const [from, to] of moves) if (!index.has(from) && index.has(to) && !state.deletedPaths.has(to)) renameOpenTab(from, to);
      await reconcileOpenTabs(changedPaths);
      if (serial !== state.repositoryLoadSerial || index !== state.fileIndex) return;
      if (!state.openPath && state.mainPath) await openFile(state.mainPath);
    } finally {
      if (serial === state.repositoryLoadSerial && index === state.fileIndex) state.editor?.updateOptions({ readOnly: false });
    }
    if (serial !== state.repositoryLoadSerial || index !== state.fileIndex) return;
    if (!state.mainPath) showNoTypstFiles();
    else scheduleCompile(0);
  }

  async function discardWorkingDraft() {
    if (!state.changes.size || state.repositoryOperation || !confirm('Discard all uncommitted changes in this branch’s local draft?')) return;
    const operation = {};
    state.repositoryOperation = operation;
    updateChangeUI();
    try {
      await flushEditorSync();
      if (state.repositoryOperation !== operation) return;
      const latest = state.syncPlan?.latest || { sha: state.headSha, treeSha: state.baseTreeSha, tree: state.rawTree, files: state.baseFiles };
      await installSyncPlan({ latest, entries: [], moves: new Map() }, new Map());
      if (state.repositoryOperation === operation) {
        if (!await persistDraft()) throw new Error('The working copy was reset, but the browser could not remove the saved draft.');
        toast('Discarded the local draft.', 'success');
      }
    } catch (error) {
      if (state.repositoryOperation === operation) toast(error.message, 'error');
    } finally {
      finishRepositoryOperation(operation);
    }
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
    projectTools?.scheduleOutline();
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
    row.addEventListener('click', () => openFile(path).catch(reportFileError));
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
    const requests = state.fileRequests;
    const fileIndex = state.fileIndex;
    const request = (async () => {
      const blob = await requestRepositoryBlob(path, meta);
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

  function requestRepositoryBlob(path, meta) {
    if (meta.size > MAX_SINGLE_BLOB_BYTES) {
      throw new Error(`${path} is too large to load in this editor (${formatBytes(meta.size)}).`);
    }
    const { owner, name } = state.repo;
    return repositoryClient().getBlob(owner.login, name, meta.sha);
  }

  function projectToolText(path, bytes, meta) {
    if (looksBinary(bytes)) return null;
    const editing = state.editorSyncPending && state.editorSyncPath === path && state.openPath === path;
    const text = editing ? state.editor.getValue() : (state.sourceTextCache.get(path) ?? decoder.decode(bytes));
    if (!editing && text.includes('\uFFFD')) {
      // A lossy decode would corrupt unrelated bytes during a replacement.
      try { diffDecoder.decode(bytes); }
      catch { return null; }
    }
    return { text, revision: editing ? text : (state.changes.has(path) ? bytes : (meta.sha ?? meta)) };
  }

  async function readProjectToolText(path) {
    const meta = state.fileIndex.get(path);
    if (!meta || state.deletedPaths.has(path) || !isTextPath(path)) return null;
    const { repositoryLoadSerial: serial, fileIndex } = state;
    // Reuse cached/opening files without retaining every project-wide read.
    let bytes = state.fileBytes.get(path);
    if (!bytes) {
      if (state.fileRequests.has(path)) bytes = await getFileBytes(path);
      else {
        const blob = await requestRepositoryBlob(path, meta);
        assertCurrentRepository(serial, fileIndex);
        bytes = state.fileBytes.get(path) || base64ToBytes(blob.content);
      }
    }
    assertCurrentRepository(serial, fileIndex);
    if (state.deletedPaths.has(path) || fileIndex.get(path) !== meta) return null;
    return projectToolText(path, state.fileBytes.get(path) || bytes, meta);
  }

  async function replaceProjectToolMatches(path, revision, matches, replacement, isCurrent) {
    const meta = state.fileIndex.get(path);
    if (!meta || state.deletedPaths.has(path)) return 0;
    const bytes = await getFileBytes(path);
    if (!isCurrent() || state.deletedPaths.has(path) || state.fileIndex.get(path) !== meta) return 0;
    const workingBytes = state.fileBytes.get(path) || bytes;
    const snapshot = projectToolText(path, workingBytes, meta);
    if (!snapshot || (snapshot.revision !== revision && snapshot.text !== revision)) return 0;
    const current = matches.filter(({ offset, value }) => snapshot.text.startsWith(value, offset) && value !== replacement);
    if (!current.length) return 0;

    if (state.openPath === path && state.editor?.getModel() && !els['editor-container'].classList.contains('hidden')) {
      const model = state.editor.getModel();
      const edits = [];
      for (const { line, column, value } of current) {
        const range = new state.monaco.Range(line, column, line, column + value.length);
        if (model.getValueInRange(range) === value) edits.push({ range, text: replacement });
      }
      if (!edits.length) return 0;
      state.editor.pushUndoStop();
      const applied = state.editor.executeEdits('project-replace', edits);
      state.editor.pushUndoStop();
      return applied ? edits.length : 0;
    }

    const chunks = [];
    if (workingBytes[0] === 0xef && workingBytes[1] === 0xbb && workingBytes[2] === 0xbf) chunks.push('\uFEFF');
    let previousEnd = 0;
    for (const { offset, value } of current) {
      chunks.push(snapshot.text.slice(previousEnd, offset), replacement);
      previousEnd = offset + value.length;
    }
    chunks.push(snapshot.text.slice(previousEnd));
    const writing = setWorkingFile(path, encoder.encode(chunks.join('')));
    // Working state is installed before the worker's asynchronous shadow write.
    updateChangeUI();
    updateFileTreeDirtyIndicator(path);
    state.sourceSearchOrder = null;
    await writing;
    return current.length;
  }

  let fileOpenRequest = 0;

  async function openFile(path, { reveal = true, focus = reveal } = {}) {
    const serial = state.repositoryLoadSerial;
    const fileIndex = state.fileIndex;
    if (state.deletedPaths.has(path)) return;
    const request = ++fileOpenRequest;
    const isCurrent = () => request === fileOpenRequest && serial === state.repositoryLoadSerial &&
      fileIndex === state.fileIndex && !state.deletedPaths.has(path);
    const [bytes] = await Promise.all([getFileBytes(path), ensureMonaco()]);
    if (!isCurrent()) return;
    // Save edits made while the next file was downloading before replacing the model.
    while (state.editorSyncPending) {
      await syncOpenFileFromEditor();
      if (!isCurrent()) return;
    }
    if (reveal) revealEditorPane();
    const visible = !isNarrowWorkspace() || els['editor-workspace'].dataset.pane === 'editor';
    activateFileTab(path, state.fileBytes.get(path) || bytes, focus && visible);
  }

  function addFileTab(path) {
    const element = document.createElement('div');
    element.className = 'file-tab';
    element.innerHTML = `
      <button type="button" class="file-tab-open">
        <span class="file-type-icon" aria-hidden="true"></span>
        <span class="file-tab-name"></span>
        <span class="dirty-dot hidden" aria-hidden="true">●</span>
      </button>
      <button type="button" class="file-tab-close">×</button>`;
    const [open, close] = element.children;
    const [icon, name, dot] = open.children;
    const tab = { path, element, open, close, icon, name, dot, model: null, viewState: null, dirty: null };
    tab.open.addEventListener('click', () => openFile(tab.path).catch(reportFileError));
    tab.close.addEventListener('click', () => closeFileTab(tab.path).catch(reportFileError));
    setTabPath(tab, path);
    els['open-file-tabs'].appendChild(element);
    state.openTabs.set(path, tab);
    return tab;
  }

  function reportFileError(err) {
    if (err?.name !== 'AbortError') toast(err.message, 'error');
  }

  function setTabPath(tab, path) {
    const icon = fileIcon(path);
    tab.path = path;
    tab.dirty = null;
    tab.open.title = path;
    tab.icon.className = `file-type-icon ${icon.cls}`;
    tab.icon.textContent = icon.label;
    tab.name.textContent = basename(path);
    tab.close.setAttribute('aria-label', `Close ${path}`);
    tab.close.title = `Close ${path}`;
  }

  function setTabSelected(tab, selected) {
    if (!tab) return;
    tab.element.classList.toggle('active', selected);
    tab.open.setAttribute('aria-pressed', String(selected));
  }

  function activateFileTab(path, bytes, focus = true) {
    const previous = state.openTabs.get(state.openPath);
    const tab = state.openTabs.get(path) || addFileTab(path);
    const switching = previous !== tab || state.editor.getModel() !== tab.model;
    if (switching && previous?.model && previous.model === state.editor.getModel()) {
      previous.viewState = state.editor.saveViewState();
    }
    if (switching) setTabSelected(previous, false);
    state.openPath = path;
    setTabSelected(tab, true);
    if (focus) tab.element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const expanded = expandParents(path);
    if (expanded) renderFileTree();
    else updateFileTreeSelection(path);
    els['status-current-file'].textContent = path;
    els['empty-editor'].classList.add('hidden');
    updateDirtyTab(path);

    const binary = !isTextPath(path) || looksBinary(bytes);
    const oldModel = tab.model;
    if (binary) {
      tab.model = null;
      tab.viewState = null;
      els['binary-file-name'].textContent = basename(path);
      els['binary-file-meta'].textContent = `${formatBytes(bytes.length)} • ${ext(path).toUpperCase() || 'binary'} file`;
      els['cursor-position'].textContent = '';
    } else if (!tab.model) {
      tab.model = state.monaco.editor.createModel(sourceText(path), editorLanguage(path));
    }
    els['binary-file-view'].classList.toggle('hidden', !binary);
    els['editor-container'].classList.toggle('hidden', binary);
    if (state.editor.getModel() !== tab.model) state.editor.setModel(tab.model);
    if (oldModel && !tab.model) oldModel.dispose();
    if (state.grammarEnabled) {
      clearGrammarMarkers();
      scheduleGrammarCheck();
    }
    if (binary) return;
    applyDiagnosticMarkersForOpenFile();
    if (switching && tab.viewState) state.editor.restoreViewState(tab.viewState);
    const position = state.editor.getPosition();
    els['cursor-position'].textContent = `Ln ${position.lineNumber}, Col ${position.column}`;
    settleEditorLayout(switching && !tab.viewState);
    if (focus) state.editor.focus();
  }

  function editorLanguage(path) {
    return ext(path) === 'typ' ? 'typst' : languageForPath(path);
  }

  function showEmptyEditor() {
    state.openPath = null;
    if (els['status-current-file']) els['status-current-file'].textContent = 'No file open';
    if (els['cursor-position']) els['cursor-position'].textContent = '';
    els['editor-container']?.classList.add('hidden');
    els['binary-file-view']?.classList.add('hidden');
    els['empty-editor']?.classList.remove('hidden');
  }

  function resetOpenTabs() {
    state.editor?.setModel?.(null);
    state.editor?.updateOptions?.({ readOnly: false });
    for (const tab of state.openTabs.values()) tab.model?.dispose();
    state.openTabs.clear();
    els['open-file-tabs']?.replaceChildren();
    showEmptyEditor();
  }

  function removeOpenTab(path) {
    const tab = state.openTabs.get(path);
    if (!tab) return;
    if (path === state.openPath) {
      if (state.grammarEnabled) stopGrammarCheck();
      state.editor.setModel(null);
      showEmptyEditor();
      updateFileTreeSelection(null);
    }
    state.openTabs.delete(path);
    tab.element.remove();
    tab.model?.dispose();
  }

  async function closeFileTab(path) {
    const tab = state.openTabs.get(path);
    const serial = state.repositoryLoadSerial;
    if (!tab) return;
    const paths = [...state.openTabs.keys()];
    const index = paths.indexOf(path);
    if (state.openPath === path) await flushEditorSync();
    if (serial !== state.repositoryLoadSerial || tab !== state.openTabs.get(path)) return;
    const active = state.openPath === path;
    if (active) ++fileOpenRequest;
    removeOpenTab(path);
    const next = paths[index + 1] || paths[index - 1];
    if (active && next && state.openTabs.has(next)) await openFile(next);
  }

  function renameOpenTab(from, to) {
    const tab = state.openTabs.get(from);
    if (!tab || from === to) return;
    if (state.openTabs.has(to)) {
      if (state.openPath !== from) {
        removeOpenTab(from);
        return;
      }
      removeOpenTab(to);
    }
    setTabPath(tab, to);
    // Retain insertion order so the keyboard order and close fallback agree.
    state.openTabs = new Map([...state.openTabs].map(([path, entry]) => [path === from ? to : path, entry]));
    if (state.openPath === from) state.openPath = to;
    if (tab.model) state.monaco.editor.setModelLanguage(tab.model, editorLanguage(to));
    updateDirtyTab(to);
  }

  function updateTabContents(path, bytes) {
    const tab = state.openTabs.get(path);
    if (!tab) return;
    const active = state.openPath === path;
    const model = tab.model;
    if (model && isTextPath(path) && !looksBinary(bytes)) {
      // Monaco normalizes to one EOL per model. Preserve history when a
      // repository update changes only the physical line separators.
      const text = decoder.decode(bytes).replace(/\r\n|\r|\n/g, model.getEOL());
      if (text === model.getValue()) return;
      const viewState = active ? state.editor.saveViewState() : null;
      state.suppressEditorChange = true;
      try {
        model.pushStackElement();
        model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
        model.pushStackElement();
      } finally {
        state.suppressEditorChange = false;
      }
      if (viewState) state.editor.restoreViewState(viewState);
      if (active && state.grammarEnabled) scheduleGrammarCheck();
    } else if (active) {
      activateFileTab(path, bytes, false);
    } else if (model) {
      tab.model = null;
      tab.viewState = null;
      model.dispose();
    }
  }

  async function reconcileOpenTabs(changedPaths) {
    const { repositoryLoadSerial: serial, fileIndex, openPath } = state;
    const refresh = [];
    for (const [path, tab] of state.openTabs) {
      if (!fileIndex.has(path) || state.deletedPaths.has(path)) removeOpenTab(path);
      else if (changedPaths.has(path)) refresh.push([path, tab]);
    }
    await pooled(refresh, 4, async ([path, tab]) => {
      const current = () => serial === state.repositoryLoadSerial && fileIndex === state.fileIndex && state.openTabs.get(path) === tab;
      try {
        const bytes = await getFileBytes(path);
        if (current()) updateTabContents(path, bytes);
      } catch (error) {
        if (!current() || error.name === 'AbortError') return;
        // The draft is still in the working state. Close the stale model so
        // the user can reopen this file to retry fetching the new revision.
        removeOpenTab(path);
        reportFileError(error);
      }
    });
    if (serial !== state.repositoryLoadSerial || fileIndex !== state.fileIndex) return;
    const next = state.openTabs.keys().next().value;
    if (openPath && !state.openPath && next) await openFile(next, { reveal: false });
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
      // Dirty-state DOM only changes on the first edit, not on every keystroke.
      updateChangeUI(path);
      updateFileTreeDirtyIndicator(path, true);
    }

    clearTimeout(state.editorSyncTimer);
    state.editorSyncTimer = setTimeout(() => {
      state.editorSyncTimer = null;
      // The queued preview takes the newest snapshot when the active compile
      // finishes. Intermediate shadow writes only delay that snapshot.
      if (state.compileInFlight && state.mainPath) return;
      syncOpenFileFromEditor().catch(err => console.error('Editor sync failed', err));
    }, 90);

    // Publish completed snapshots while typing, then compile the newest edit.
    // Cancelling every in-flight result would starve a long document's preview.
    state.editRevision++;
    queueDraftSave(path);
    releasePreviewNavigationPage(true);
    cancelPreviewSourceAnchorIndexing();
    if (state.previewSourceAnchors.length) {
      state.previewSourceAnchors = [];
      state.previewAnchorMap = new WeakMap();
    }
    if (state.mainPath) scheduleCompile();
    if (state.grammarEnabled) scheduleGrammarCheck();
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

    const bytes = captureEditorDraft(path);

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

  function updateChangeUI(path = null) {
    const count = state.changes.size;
    const blocked = Boolean(state.repositoryOperation || els['editor-workspace']?.inert);
    els['commit-btn'].disabled = count === 0 || Boolean(state.syncPlan) || blocked;
    els['change-count-badge'].classList.toggle('hidden', count === 0);
    els['change-count-badge'].textContent = count;
    updateDirtyTab(path);
    if (els['refresh-repo-btn']) els['refresh-repo-btn'].disabled = !state.headSha || blocked;
    if (els['publish-branch-btn']) els['publish-branch-btn'].disabled = !state.headSha || Boolean(state.syncPlan) || blocked;
    if (els['discard-draft-btn']) {
      els['discard-draft-btn'].classList.toggle('hidden', count === 0);
      els['discard-draft-btn'].disabled = blocked;
    }
  }
  function updateDirtyTab(path = null) {
    const setDirty = (tab, tabPath) => {
      if (!tab) return;
      const dirty = state.changes.has(tabPath);
      if (dirty === tab.dirty) return;
      tab.dirty = dirty;
      tab.dot.classList.toggle('hidden', !dirty);
      tab.open.setAttribute('aria-label', dirty ? `${tabPath}, uncommitted changes` : tabPath);
    };
    if (path) setDirty(state.openTabs.get(path), path);
    else state.openTabs.forEach(setDirty);
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
        const fontLoadDiagnostics = [];
        const entries = [...fileIndex.entries()].filter(([path, meta]) => {
          if (state.deletedPaths.has(path)) return false;
          if ((meta.size || 0) <= MAX_SINGLE_BLOB_BYTES) return true;
          if (FONT_EXTENSIONS.has(ext(path))) fontLoadDiagnostics.push({
            path, severity: 'warning', message: 'Could not load repository font. Use a font file under 25 MB.',
          });
          return false;
        });
        const allTotal = entries.reduce((sum, [, meta]) => sum + (meta.size || 0), 0);
        // Repository reads can run before WASM is ready. Await resets separately so
        // a failed dependency read never releases the shadow-FS write queue.
        const selection = force ? Promise.resolve(entries) : collectCompilerDependencyEntries(entries);
        selection.catch(() => {});
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

        // Normal startup follows literal include/import/file references from
        // the selected main document instead of downloading every repository
        // blob. Dynamic file access falls back to the force-hydration retry.
        let selected = await selection;
        checkCurrent();
        let selectedTotal = selected.reduce((sum, [, meta]) => sum + (meta.size || 0), 0);
        if (selectedTotal > MAX_PROJECT_BYTES || (force && allTotal > MAX_PROJECT_BYTES)) {
          selected = entries.filter(([path]) => shouldHydratePriority(path));
          selectedTotal = selected.reduce((sum, [, meta]) => sum + (meta.size || 0), 0);
          toast(`This repository is ${formatBytes(allTotal)}. Preview loaded Typst/project assets under the ${formatBytes(MAX_PROJECT_BYTES)} browser limit.`, 'error', 7000);
        }

        let done = 0;
        const mappedPaths = new Map();
        await pooled(selected, 8, async ([path]) => {
          checkCurrent();
          let bytes;
          try { bytes = await getFileBytes(path); }
          catch (error) {
            checkCurrent();
            if (!FONT_EXTENSIONS.has(ext(path))) throw error;
            if (error?.name !== 'AbortError') fontLoadDiagnostics.push({
              path, severity: 'warning', message: `Could not download repository font. ${error?.message || ''} Check the file and reopen the project to retry.`,
            });
          }
          checkCurrent();
          if (bytes) {
            const mapped = await window.$typst.mapShadow(`/repo/${path}`, bytes);
            checkCurrent();
            if (mapped === false) throw new Error(`Typst could not map project file: ${path}`);
            mappedPaths.set(path, bytes);
          }
          done++;
          if (done % 8 === 0 || done === selected.length) {
            setCompileStatus('busy', `Loading files ${done}/${selected.length}`);
          }
        });
        checkCurrent();

        for (const [path, change] of state.changes) {
          checkCurrent();
          if (change.type === 'delete') await window.$typst.unmapShadow(`/repo/${path}`);
          else if (change.bytes && mappedPaths.get(path) !== change.bytes) {
            const mapped = await window.$typst.mapShadow(`/repo/${path}`, change.bytes);
            checkCurrent();
            if (mapped === false) throw new Error(`Typst could not map changed file: ${path}`);
          }
          checkCurrent();
        }

        state.fontLoadDiagnostics = fontLoadDiagnostics;
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

    // Font family selection happens in Typst and need not reference a path.
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

  function scheduleCompile(delay = 16) {
    projectTools?.scheduleOutline();
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
    for (const diagnostic of state.fontLoadDiagnostics) {
      if (!state.deletedPaths.has(diagnostic.path) && !state.changes.has(diagnostic.path)) {
        diagnostics.push(normalizeDiagnostic(diagnostic));
      }
    }
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
    if (revision === state.editRevision) {
      state.diagnostics = diagnostics;
      renderDiagnostics(diagnostics);
    }
    installPreviewSvg(svg, result.svgParts);
    els['preview-loading'].classList.add('hidden');
    normalizePreviewSvg();
    state.sourceSearchOrder = null;
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
        await openDiagnosticLocation(diag).catch(err => {
          if (err?.name !== 'AbortError') toast(err.message, 'error');
        });
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
    if (!path || !state.fileIndex.has(path) || state.deletedPaths.has(path)) return;
    const serial = state.repositoryLoadSerial;
    if (state.openPath !== path || !state.editor?.getModel() || els['editor-container'].classList.contains('hidden')) {
      await openFile(path);
    }
    if (serial !== state.repositoryLoadSerial || state.openPath !== path ||
        !isTextPath(path) || els['editor-container'].classList.contains('hidden')) return;
    revealEditorPane();
    const range = diagnosticRangeForModel(diag, state.editor.getModel());
    if (range) {
      state.editor.setSelection(range);
      state.editor.revealRangeInCenter(range, state.monaco.editor.ScrollType.Smooth);
    }
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

  function disposePreviewPages() {
    state.previewPageObserver?.disconnect();
    state.previewPageObserver = null;
    state.previewMountTimer?.cancel();
    state.previewMountTimer = null;
  }

  function releasePreviewNavigationPage(deferUnmount = false) {
    const cache = state.previewSvgCache;
    const page = cache?.pinnedPage;
    if (!page) return;
    page.navigationPinned = false;
    cache.pinnedPage = null;
    const unmount = () => {
      if (cache !== state.previewSvgCache || page.visible || page.navigationPinned || !page.group) return;
      page.svg.replaceChildren();
      page.group = null;
      page.mountedRaw = null;
    };
    if (!page.visible && page.group) {
      // Releasing the pin during typing must not remove SVG glyphs in the
      // Monaco change event. Recheck visibility in case scrolling caught up.
      if (deferUnmount) setTimeout(unmount, 0);
      else unmount();
    }
  }

  function observePreviewPages(cache) {
    if (!state.previewPageObserver) {
      state.previewPageObserver = new IntersectionObserver(entries => {
        if (cache !== state.previewSvgCache) return;
        for (const entry of entries) {
          const page = cache.pages[Number(entry.target.dataset.pageNumber) - 1];
          if (!page || page.node !== entry.target) continue;
          page.visible = entry.isIntersecting;
          if (page.visible && page.navigationPinned) {
            page.navigationPinned = false;
            cache.pinnedPage = null;
          }
          if (!page.visible && page.group && !page.navigationPinned) {
            page.svg.replaceChildren();
            page.group = null;
            page.mountedRaw = null;
          }
        }
        schedulePreviewPageMounts();
      }, { root: els['preview-scroll'], rootMargin: '160px 0px' });
    }
    for (const page of cache.pages) {
      if (page.observed) continue;
      state.previewPageObserver.observe(page.node);
      page.observed = true;
    }
  }

  function mountPreviewPage(page) {
    if (page.mountedRaw === page.raw) return;
    const holder = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    holder.innerHTML = page.raw;
    const group = holder.firstElementChild;
    if (!group?.classList.contains('typst-page')) return;
    group.removeAttribute('transform');
    page.svg.replaceChildren(group);
    page.group = group;
    page.mountedRaw = page.raw;
  }

  function schedulePreviewPageMounts() {
    if (state.previewMountTimer != null) return;
    // Mount one visible page at a time so the browser can paint the editor
    // first. A short deadline keeps previews moving during continuous input.
    const mountNext = () => {
      state.previewMountTimer = null;
      const cache = state.previewSvgCache;
      if (cache?.mode !== 'cards') return;
      const page = cache.pages.find(page => page.visible && page.raw !== page.mountedRaw);
      if (!page) return;
      mountPreviewPage(page);
      if (cache.pages.some(page => page.visible && page.raw !== page.mountedRaw)) schedulePreviewPageMounts();
      else schedulePreviewSourceAnchorIndexing();
    };
    if (state.previewSvgCache?.pages.length > 1 && typeof window.requestIdleCallback === 'function') {
      const handle = window.requestIdleCallback(mountNext, { timeout: 24 });
      state.previewMountTimer = { cancel: () => window.cancelIdleCallback(handle) };
    } else {
      const handle = setTimeout(mountNext, 0);
      state.previewMountTimer = { cancel: () => clearTimeout(handle) };
    }
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
      const reusable = cache?.mode === 'cards' && cache.root.parentNode === output;
      const holder = document.createElement('div');
      // Read only the root and page headers here. Parsing every glyph on every
      // page creates hundreds of thousands of DOM nodes before the first paint.
      holder.innerHTML = parts.opening + parts.closing;
      const template = holder.firstElementChild;
      if (template?.localName !== 'svg' || holder.children.length !== 1) return false;
      const dimensions = [];
      for (let index = 0; index < parts.pages.length; index++) {
        const previous = reusable && cache.pages[index];
        if (previous && parts.pages[index].startsWith(previous.header)) {
          dimensions.push(previous);
          continue;
        }
        const header = /^<g\b(?:[^>"']|"[^"]*"|'[^']*')*>/.exec(parts.pages[index]);
        const group = header && parseNodes(header[0] + (header[0].endsWith('/>') ? '' : '</g>'))[0];
        const width = parseFloat(group?.getAttribute('data-page-width'));
        const height = parseFloat(group?.getAttribute('data-page-height'));
        if (!group?.classList.contains('typst-page') || !(width > 0 && height > 0)) return false;
        dimensions.push({ width, height, header: header[0] });
      }
      const pageTemplate = template.cloneNode(false);
      pageTemplate.removeAttribute('id');
      pageTemplate.classList.add('typst-doc', 'preview-page-surface');
      Object.assign(pageTemplate.style, {
        display: 'block', background: 'transparent', border: '0', boxShadow: 'none',
        borderRadius: '0', overflow: 'hidden', filter: 'none',
      });
      if (!reusable) {
        disposePreviewPages();
        cache = {
          mode: 'cards', root: template, pages: [], prefixNodes: [], suffixNodes: [],
          previousGap: state.previewSvgCache?.mode === 'cards' ? state.previewSvgCache.previousGap : output.style.gap,
        };
      }
      const root = cache.root;
      if (reusable && cache.opening !== parts.opening) applyAttributes(root, template);
      Object.assign(root.style, {
        position: 'absolute', width: '0px', height: '0px', overflow: 'hidden',
        background: 'transparent', border: '0', boxShadow: 'none', pointerEvents: 'none',
      });
      setAttribute(root, 'width', 0); setAttribute(root, 'height', 0);
      setAttribute(root, 'aria-hidden', 'true');
      for (let index = 0; index < parts.pages.length; index++) {
        let record = cache.pages[index];
        if (!record) {
          const node = document.createElement('div');
          node.className = 'preview-page-card';
          const pageSvg = pageTemplate.cloneNode(false);
          node.appendChild(pageSvg);
          record = { node, svg: pageSvg, group: null, mountedRaw: null, visible: false };
          cache.pages[index] = record;
          if (reusable) output.appendChild(node);
        }
        const geometryChanged = record !== dimensions[index];
        Object.assign(record, dimensions[index], { raw: parts.pages[index] });
        const rootChanged = !reusable || cache.opening !== parts.opening;
        if (rootChanged) applyAttributes(record.svg, pageTemplate);
        if (!geometryChanged && !rootChanged) continue;
        for (const [name, value] of Object.entries({ width: record.width + 'px', height: record.height + 'px' })) {
          if (record.node.style[name] !== value) record.node.style[name] = value;
        }
        setAttribute(record.node, 'data-page-number', index + 1);
        setAttribute(record.svg, 'width', record.width); setAttribute(record.svg, 'height', record.height);
        setAttribute(record.svg, 'viewBox', '0 0 ' + record.width + ' ' + record.height);
        setAttribute(record.svg, 'data-page-number', index + 1);
      }
      for (const record of cache.pages.slice(parts.pages.length)) {
        state.previewPageObserver?.unobserve(record.node);
        record.node.remove();
      }
      cache.pages.length = parts.pages.length;
      if (cache.prefix !== parts.prefix) {
        cache.prefixNodes = patchNodes(root, cache.prefixNodes, parseNodes(parts.prefix), cache.suffixNodes[0] || null);
      }
      if (cache.suffix !== parts.suffix) cache.suffixNodes = patchNodes(root, cache.suffixNodes, parseNodes(parts.suffix));
      if (!reusable) output.replaceChildren(root, ...cache.pages.map(page => page.node));
      if (output.style.gap !== '16px') output.style.gap = '16px';
      cache.opening = parts.opening; cache.prefix = parts.prefix; cache.suffix = parts.suffix;
      cache.width = Math.max(...cache.pages.map(page => page.width));
      cache.height = cache.pages.reduce((sum, page) => sum + page.height, 0) + 16 * (cache.pages.length - 1);
      setAttribute(root, 'data-base-width', cache.width); setAttribute(root, 'data-base-height', cache.height);
      state.previewSvgCache = cache;
      observePreviewPages(cache);
      schedulePreviewPageMounts();
      return true;
    };
    if (validParts && typeof IntersectionObserver === 'function' && installCards()) return;
    const replaceAll = () => {
      disposePreviewPages();
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
      const count = state.previewSvgCache.pages.length;
      const label = count === 1 ? '1 page' : `${count} pages`;
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
    const { mainPath, repositoryLoadSerial } = state;
    if (!mainPath) return;
    const isCurrent = () => repositoryLoadSerial === state.repositoryLoadSerial && mainPath === state.mainPath;
    try {
      await flushEditorSync();
      if (!isCurrent()) return;
      setCompileStatus('busy','Exporting PDF');
      await hydrateCompilerFS();
      if (!isCurrent()) return;
      const pdf = await window.$typst.pdf({ mainFilePath: `/repo/${mainPath}`, root: '/repo' });
      if (!isCurrent()) return;
      const blob = new Blob([pdf], { type:'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${basename(mainPath).replace(/\.typ$/i,'') || 'document'}.pdf`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setCompileStatus('ok','Up to date');
    } catch (err) { if (isCurrent()) showCompileError(err); }
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
    const serial = state.repositoryLoadSerial;
    const suggested = state.openPath ? `${dirname(state.openPath) ? dirname(state.openPath) + '/' : ''}new.typ` : 'new.typ';
    const path = await textPrompt({ title:'New file', kicker:'Project', label:'File path', value:suggested, action:'Create' });
    if (!path || serial !== state.repositoryLoadSerial) return;
    const clean = normalizeRepoPath(path);
    if (!clean || clean.endsWith('/')) return toast('Enter a file name, not only a folder.','error');
    const previous = state.fileIndex.get(clean);
    if (previous && !state.deletedPaths.has(clean)) return toast('A file already exists at that path.','error');
    const initial = ext(clean) === 'typ' ? '= New document\n\nStart writing here.\n' : '';
    const bytes = encoder.encode(initial);
    await setWorkingFile(clean, bytes);
    if (serial !== state.repositoryLoadSerial) return;
    if (!state.mainPath && ext(clean) === 'typ') { state.mainPath = clean; els['main-file-label'].textContent = clean; }
    renderFileTree(); updateChangeUI(); await openFile(clean);
    if (serial === state.repositoryLoadSerial) scheduleCompile(100);
  }

  async function setWorkingFile(path, bytes) {
    const serial = state.repositoryLoadSerial;
    const clean = state.fileIndex.has(path) ? path : normalizeRepoPath(path);
    if (state.editorSyncPath === clean && (state.editorSyncPending || state.shadowSyncPromise)) {
      await flushEditorSync();
      if (serial !== state.repositoryLoadSerial) return;
    }
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
    setWorkingChange(clean, changeForBytes(clean, bytes));
    state.deletedPaths.delete(clean);
    updateTabContents(clean, bytes);
    if (window.$typst && shouldHydratePriority(clean)) {
      const mapped = await window.$typst.mapShadow(`/repo/${clean}`, bytes);
      if (serial !== state.repositoryLoadSerial) return;
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
    const serial = state.repositoryLoadSerial;
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
      if (serial !== state.repositoryLoadSerial) return;
      await setWorkingFile(path, bytes);
      if (serial !== state.repositoryLoadSerial) return;
      added++;
    }
    renderFileTree();
    updateChangeUI();
    state.sourceSearchOrder = null;
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
    const serial = state.repositoryLoadSerial;
    const sourcePath = state.openPath;
    const sourceModel = state.editor.getModel();
    const sourceIsActive = () => serial === state.repositoryLoadSerial && state.openPath === sourcePath &&
      state.editor.getModel() === sourceModel;
    const snippets = [];
    let created = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const options = await imagePastePrompt(file, i, files.length);
      if (!sourceIsActive()) return;
      if (!options) break;
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!sourceIsActive()) return;
      const path = uniquePastedImagePath(options.filename);
      await setWorkingFile(path, bytes);
      if (serial !== state.repositoryLoadSerial) return;
      if (!sourceIsActive()) {
        renderFileTree();
        updateChangeUI();
        toast(`Saved ${path}. Reopen ${sourcePath} to insert it.`);
        return;
      }
      const relative = relativeProjectPath(dirname(sourcePath), path);
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
    state.sourceSearchOrder = null;
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

  function getSourceSearchOrder() {
    return state.sourceSearchOrder ??= buildSourceSearchOrder();
  }

  function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function findTextInSource(text) {
    const cleaned = String(text || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    if (!cleaned) return null;
    const paths = getSourceSearchOrder();
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
    const paths = getSourceSearchOrder();
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
    const paths = getSourceSearchOrder();
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
    let elements;
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
      elements ??= els['preview-output'].querySelectorAll('.typst-text, image');

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
    state.previewIndexStartTimer = setTimeout(() => {
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
    const target = event?.target;
    if (!state.openPath || !isTextPath(state.openPath) || !target?.position || isNarrowWorkspace()) return;
    const { CONTENT_TEXT, CONTENT_EMPTY } = state.monaco.editor.MouseTargetType;
    // Monaco snaps clicks past the last character to the end of the line.
    const afterLineText = target.type === CONTENT_EMPTY && target.detail?.isAfterLines === false && target.position.column > 1;
    if (target.type !== CONTENT_TEXT && !afterLineText) return;
    const browserEvent = event.event?.browserEvent;
    if (browserEvent && Number.isFinite(browserEvent.button) && browserEvent.button !== 0) return;
    const selection = state.editor.getSelection();
    if (selection && !selection.isEmpty()) return;
    const model = state.editor.getModel();
    if (!model) return;
    const offset = model.getOffsetAt(target.position);
    if (state.previewSvgCache?.mode === 'cards') {
      revealVirtualPreviewSource(state.openPath, offset).catch(console.error);
      return;
    }
    const anchor = previewAnchorForSourcePosition(state.openPath, offset);
    if (anchor) scrollPreviewToAnchor(anchor);
  }

  async function revealVirtualPreviewSource(path, offset) {
    const cache = state.previewSvgCache;
    releasePreviewNavigationPage();
    const revision = state.editRevision;
    const request = (cache.navigationRequest || 0) + 1;
    cache.navigationRequest = request;
    const current = () => cache === state.previewSvgCache && revision === state.editRevision && cache.navigationRequest === request;
    const source = sourceText(path);
    const probesByText = new Map();
    let lastOffset = 0;
    let best = null;
    // Source-to-preview navigation may target an unmounted page. Scan detached
    // pages only when requested, yield between small batches, and stop as soon
    // as typing resumes. Nothing here runs on the keystroke/compile path.
    for (let pageIndex = 0; pageIndex < cache.pages.length && current(); pageIndex++) {
      await new Promise(resolve => setTimeout(resolve, 0));
      if (!current()) return;
      const page = cache.pages[pageIndex];
      const holder = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      holder.innerHTML = page.raw;
      const elements = holder.querySelectorAll('.typst-text, image');
      let started = performance.now();
      for (let index = 0; index < elements.length; index++) {
        const element = elements[index];
        let mapping;
        if (element.localName === 'image') mapping = findAssetReferenceSource(imagePathFromRenderedElement(element));
        else {
          const text = renderedAnchorText(element);
          let probes = probesByText.get(text);
          if (!probes) {
            probes = textSearchProbes(text);
            probesByText.set(text, probes);
          }
          // Search forward in the requested file instead of constructing all
          // matches across every file for every rendered line.
          for (const probe of probes) {
            let found = source.indexOf(probe, lastOffset);
            if (found < 0) found = source.indexOf(probe);
            if (found < 0) continue;
            mapping = { path, offset: found, length: probe.length };
            lastOffset = found + probe.length;
            break;
          }
        }
        if (mapping?.path === path) {
          const distance = distanceToSourceRange(offset, mapping);
          if (!best || distance < best.distance) best = { page, index, distance };
          if (distance === 0) break;
        }
        if (performance.now() - started >= 4) {
          await new Promise(resolve => setTimeout(resolve, 0));
          if (!current()) return;
          started = performance.now();
        }
      }
      if (best?.distance === 0) break;
    }
    if (!current() || !best || best.distance > 320) return;
    // Mount before scrolling so the normal highlighting and click path works.
    best.page.navigationPinned = true;
    cache.pinnedPage = best.page;
    mountPreviewPage(best.page);
    const element = best.page.svg.querySelectorAll('.typst-text, image')[best.index];
    scrollPreviewToAnchor({ element });
  }

  async function openFileAtOffset(path, offset, length = 0, location = null) {
    if (!path || !state.fileIndex.has(path) || state.deletedPaths.has(path)) return false;
    const repositorySerial = state.repositoryLoadSerial;
    if (state.openPath !== path || !state.editor?.getModel() || els['editor-container'].classList.contains('hidden')) {
      await openFile(path);
    }
    if (repositorySerial !== state.repositoryLoadSerial || state.openPath !== path) return false;
    revealEditorPane();
    const model = state.editor.getModel();
    if (!model) return true;
    const max = model.getValueLength();
    const start = location ? model.getOffsetAt({ lineNumber: location.line, column: location.column }) :
      Math.max(0, Math.min(max, Number(offset) || 0));
    const end = Math.max(start, Math.min(max, start + Math.max(0, Number(length) || 0)));
    const startPos = model.getPositionAt(start);
    const endPos = model.getPositionAt(end);
    const selection = new state.monaco.Range(startPos.lineNumber, startPos.column, endPos.lineNumber, endPos.column);
    state.editor.setSelection(selection);
    state.editor.revealRangeInCenter(selection, state.monaco.editor.ScrollType.Immediate);
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
    const { openPath: oldPath, repositoryLoadSerial: serial } = state;
    if (!oldPath) return;
    await flushEditorSync();
    if (serial !== state.repositoryLoadSerial || state.openPath !== oldPath) return;
    const newValue = await textPrompt({ title:'Rename file', kicker:'Project', label:'New path', value:oldPath, action:'Rename' });
    if (!newValue || serial !== state.repositoryLoadSerial) return;
    const newPath = normalizeRepoPath(newValue);
    if (!newPath || newPath === oldPath) return;
    const bytes = await getFileBytes(oldPath);
    if (serial !== state.repositoryLoadSerial) return;
    const destination = state.fileIndex.get(newPath);
    if (destination && !state.deletedPaths.has(newPath)) return toast('A file already exists at that path.','error');
    const oldMeta = state.fileIndex.get(oldPath);
    const previousMove = state.changes.get(oldPath)?.renameFrom;
    if (oldMeta?.existing) {
      setWorkingChange(oldPath, { type:'delete' }); state.deletedPaths.add(oldPath); state.sourceTextCache.delete(oldPath);
    } else {
      setWorkingChange(oldPath, null); state.fileIndex.delete(oldPath); state.fileBytes.delete(oldPath); state.sourceTextCache.delete(oldPath);
    }
    const existing = Boolean(destination?.existing);
    const source = previousMove || (oldMeta?.existing ? oldPath : undefined);
    const renameFrom = source === newPath ? undefined : source;
    state.fileIndex.set(newPath, {
      ...destination, path:newPath, type:'blob', mode:destination?.mode || oldMeta?.mode || '100644',
      size:bytes.length, existing, bytes, renameFrom: existing ? undefined : renameFrom,
    });
    invalidatePathCaches();
    state.fileBytes.set(newPath, bytes);
    state.sourceTextCache.delete(newPath);
    setWorkingChange(newPath, changeForBytes(newPath, bytes, renameFrom || null));
    state.deletedPaths.delete(newPath);
    renameOpenTab(oldPath, newPath);
    if (state.openPath === newPath) activateFileTab(newPath, bytes);
    if (state.mainPath === oldPath) { state.mainPath = newPath; els['main-file-label'].textContent = newPath; }
    expandParents(newPath);
    renderFileTree();
    updateChangeUI();
    const runtime = window.$typst;
    if (runtime) {
      const fileIndex = state.fileIndex;
      // Edits to the renamed tab may arrive while the old path is unmapping.
      // Queue the whole move before any newer snapshot for the destination.
      const sync = state.shadowSyncTail.then(async () => {
        assertCurrentRepository(serial, fileIndex);
        await runtime.unmapShadow(`/repo/${oldPath}`);
        assertCurrentRepository(serial, fileIndex);
        const mapped = await runtime.mapShadow(`/repo/${newPath}`, bytes);
        if (mapped === false) throw new Error(`Typst could not map project file: ${newPath}`);
      });
      state.shadowSyncTail = sync.catch(() => {});
      state.shadowSyncPromise = sync;
      try {
        await sync;
      } catch (error) {
        reportFileError(error);
      } finally {
        if (state.shadowSyncPromise === sync) state.shadowSyncPromise = null;
      }
    }
    if (serial !== state.repositoryLoadSerial) return;
    if (state.openPath === oldPath) await openFile(newPath);
    if (serial === state.repositoryLoadSerial) scheduleCompile(100);
  }

  async function deleteSelectedFile() {
    const { openPath: path, repositoryLoadSerial: serial } = state;
    if (!path) return;
    await flushEditorSync();
    if (serial !== state.repositoryLoadSerial || state.openPath !== path) return;
    if (!confirm(`Delete ${path} from the next commit?`)) return;
    const meta = state.fileIndex.get(path);
    if (meta?.existing) {
      setWorkingChange(path, { type:'delete' }); state.deletedPaths.add(path); state.sourceTextCache.delete(path);
    } else {
      setWorkingChange(path, null); state.fileIndex.delete(path); state.fileBytes.delete(path); state.sourceTextCache.delete(path);
    }
    removeOpenTab(path);
    if (state.openPath === path) showEmptyEditor();
    const opening = fileOpenRequest;
    invalidatePathCaches();
    if (window.$typst) await window.$typst.unmapShadow(`/repo/${path}`);
    if (serial !== state.repositoryLoadSerial) return;
    if (state.mainPath === path) chooseInitialMainFile();
    const next = state.openTabs.keys().next().value || state.mainPath || effectivePaths()[0] || null;
    renderFileTree(); updateChangeUI();
    if (next && !state.openPath && opening === fileOpenRequest) await openFile(next);
    if (!state.mainPath) showNoTypstFiles();
    if (serial === state.repositoryLoadSerial) scheduleCompile(100);
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

  async function openCommitModal() {
    if (!state.changes.size || state.repositoryOperation || state.syncPlan) return;
    const label = repositoryProviderLabel();
    if (!repositoryToken()) { openAuthModal(); toast(`Connect ${label} before committing changes.`, 'error'); return; }
    const context = currentRepositoryContext();
    try {
      await flushEditorSync();
      if (!context.isCurrent() || state.repositoryOperation || !state.changes.size) return;
      els['commit-modal-title'].textContent = `Commit to ${label}`;
      const review = renderCommitReview(els['commit-summary'], context);
      state.commitReview = review;
      els['commit-message-input'].value = review.groups.length === 1 ? `Update ${basename(review.groups[0].path)}` : 'Update Typst project';
      els['commit-error'].classList.add('hidden');
      openModal('commit-modal');
      setTimeout(() => { if (state.activeModal === 'commit-modal') els['commit-message-input'].focus(); }, 40);
    } catch (error) {
      if (context.isCurrent()) toast(error.message, 'error');
    }
  }

  function renderCommitReview(container, context, checked) {
    const snapshot = snapshotWorkingChanges();
    const groups = working.changeGroups(snapshot);
    container.replaceChildren();
    for (const group of groups) {
      const row = document.createElement('section');
      row.className = 'commit-file';
      const label = document.createElement('label');
      label.className = 'commit-summary-row';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = checked ? checked.has(group.path) : true;
      group.checkbox = box;
      const name = document.createElement('span');
      name.textContent = group.from ? `${group.from} → ${group.path}` : group.path;
      const badge = document.createElement('span');
      badge.className = `change-type ${group.type}`;
      const item = snapshot.get(group.path);
      const binary = !comparableText(group.path, item.bytes) || (group.from && !isTextPath(group.from));
      badge.textContent = binary ? `${group.type} · binary` : group.type;
      label.append(box, name, badge);
      row.append(label);
      const diff = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = binary ? 'File details' : 'View diff';
      const output = document.createElement('div');
      output.className = 'commit-diff';
      diff.append(summary, output);
      diff.addEventListener('toggle', async () => {
        if (!diff.open || diff.dataset.loaded) return;
        diff.dataset.loaded = 'true';
        output.textContent = 'Loading base file…';
        try {
          await renderFileDiff(output, group, snapshot, context);
        } catch (error) {
          output.textContent = error.message;
          delete diff.dataset.loaded;
        }
      });
      row.append(diff);
      container.append(row);
    }
    return { snapshot, groups, revision: state.workingRevision, edit: state.editRevision };
  }

  async function renderFileDiff(output, { path, from, type }, snapshot, context) {
    const change = snapshot.get(path);
    const original = snapshot.get(from || path);
    const after = change.bytes;
    if (!comparableText(path, after, original.baseBytes) || (from && !isTextPath(from))) {
      const beforeSize = original.base?.size ?? original.baseBytes?.length;
      output.textContent = `${beforeSize === undefined ? 'No original file' : formatBytes(beforeSize)} → ${after ? formatBytes(after.length) : 'deleted'}`;
      return;
    }
    if (Math.max(original.base?.size || 0, after?.length || 0) > MAX_DIFF_BYTES) {
      output.textContent = 'File exceeds the 2 MB line diff limit.';
      return;
    }
    const before = original.baseBytes || await fetchBaseBytes(context, original.base);
    if (!context.isCurrent() || !output.isConnected) return;
    let beforeText, afterText;
    try {
      if (comparableText(path, before, after)) {
        beforeText = before ? diffDecoder.decode(before) : '';
        afterText = after ? diffDecoder.decode(after) : '';
      }
    } catch { /* Non-UTF-8 files receive a byte summary. */ }
    if (afterText === undefined) {
      output.textContent = `Binary file · ${before ? formatBytes(before.length) : 'new'} → ${after ? formatBytes(after.length) : 'deleted'}`;
      return;
    }
    const oldLines = working.splitLines(beforeText);
    const newLines = working.splitLines(afterText);
    const hunks = working.lineHunks(oldLines, newLines);
    output.replaceChildren();
    if (!hunks.length) { output.textContent = type === 'rename' ? 'Contents unchanged.' : 'No content differences.'; return; }
    let index = 0, offset = 0, delta = 0, stage = 0;
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'tab-icon-btn';
    more.textContent = 'Show more lines';
    const renderPage = () => {
      const pre = document.createElement('pre');
      let remaining = 400;
      const line = (content, style) => {
        const span = document.createElement('span');
        span.className = style;
        span.textContent = content.endsWith('\n') ? content : content + '\n';
        pre.append(span);
        remaining--;
      };
      while (index < hunks.length && remaining > 0) {
        const hunk = hunks[index];
        if (stage === 0) {
          line(`@@ -${hunk.start + 1},${hunk.end - hunk.start} +${hunk.start + 1 + delta},${hunk.lines.length} @@`, 'diff-location');
          stage = 1;
        }
        const removed = hunk.end - hunk.start;
        while (offset < removed && remaining > 0) line('- ' + oldLines[hunk.start + offset++], 'diff-removed');
        while (offset < removed + hunk.lines.length && remaining > 0) line('+ ' + hunk.lines[offset++ - removed], 'diff-added');
        if (offset === removed + hunk.lines.length) {
          delta += hunk.lines.length - removed;
          index++; offset = 0; stage = 0;
        }
      }
      output.insertBefore(pre, more);
      more.hidden = index >= hunks.length;
    };
    more.addEventListener('click', renderPage);
    output.append(more);
    renderPage();
  }

  function selectedCommitFiles(review) {
    if (!review) return snapshotWorkingChanges();
    if (review.revision !== state.workingRevision || review.edit !== state.editRevision) {
      throw new Error('The draft changed after review. Reopen the dialog to review the latest changes.');
    }
    return new Map(review.groups.filter(group => group.checkbox.checked).flatMap(group =>
      group.paths.map(path => [path, review.snapshot.get(path)])));
  }

  async function publishCommit(context, message, snapshot, workflow) {
    const { provider, owner, name: repo, branch, isCurrent } = context;
    const { headSha, baseTreeSha } = state;
    const [obstruction] = obstructedFiles(state.rawTree, snapshot);
    if (obstruction) throw new Error(`${obstruction} overlaps a tracked file or folder. Review the selected deletions or rename this file.`);
    const result = provider === 'codeberg'
      ? await context.client.commitFiles(owner, repo, branch, message, headSha, snapshot, isCurrent)
      : await commitGitHubFiles({ owner, repo, branch, headSha, baseTreeSha }, message, snapshot, isCurrent);
    if (!isCurrent() || !result) return null;
    const branchAdvanced = result.parentSha && result.parentSha !== headSha;
    if (!branchAdvanced) {
      state.headSha = result.sha;
      state.baseTreeSha = result.treeSha;
    }
    acceptCommittedFiles(result.treeEntries, snapshot);
    if (workflow) workflow.committed = result.sha;
    if (state.draft) {
      state.draft.headerDirty = true;
      void persistDraft();
    }
    const success = `Committed ${snapshot.size} change${snapshot.size === 1 ? '' : 's'} to ${branch}.`;
    toast(branchAdvanced ? `${success} Sync to pick up other changes to this branch.` : success, 'success', 5000);
    return result;
  }

  async function commitChanges() {
    const message = els['commit-message-input'].value.trim();
    if (!message) return showInlineError(els['commit-error'], 'Enter a commit message.');
    const btn = els['confirm-commit-btn'];
    if (btn.disabled || !state.repo || state.repositoryOperation || state.syncPlan) return;
    const context = currentRepositoryContext();
    const operation = {};
    state.repositoryOperation = operation;
    updateChangeUI();
    const oldText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Committing…';
    els['commit-error'].classList.add('hidden');
    try {
      await flushEditorSync();
      if (!context.isCurrent()) return;
      const snapshot = selectedCommitFiles(state.commitReview);
      if (!snapshot.size) throw new Error('Select at least one file to commit.');
      const result = await publishCommit(context, message, snapshot);
      if (result && state.activeModal === 'commit-modal') closeModal();
    } catch (error) {
      if (!context.isCurrent()) return;
      if (state.activeModal === 'commit-modal') showInlineError(els['commit-error'], error.message);
      else toast(error.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = oldText;
      finishRepositoryOperation(operation);
    }
  }

  async function openBranchModal() {
    if (!state.headSha || state.syncPlan || state.repositoryOperation) return;
    if (!repositoryToken()) { openAuthModal(); return; }
    const context = currentRepositoryContext();
    try {
      await flushEditorSync();
      if (!context.isCurrent() || state.repositoryOperation) return;
      const job = state.branchWorkflow;
      const names = new Set([state.repo.default_branch, state.branch, ...state.branches.map(item => item.name)]);
      els['branch-targets'].replaceChildren(...[...names].map(name => new Option(name, name)));
      els['branch-name'].value = job?.name || '';
      els['branch-current'].checked = job?.useCurrent || false;
      els['branch-target'].value = job?.target || state.repo.default_branch;
      els['branch-title'].value = job?.title || 'Update Typst project';
      els['branch-body'].value = job?.body || '';
      els['branch-message'].value = job?.message || 'Update Typst project';
      els['branch-create-pr'].checked = job?.wantsPr ?? true;
      els['branch-error'].classList.add('hidden');
      state.branchReview = renderCommitReview(els['branch-files'], context, job && new Set(job.selection));
      updateBranchWorkflowUI();
      openModal('branch-modal');
    } catch (error) {
      if (context.isCurrent()) toast(error.message, 'error');
    }
  }

  function updateBranchWorkflowUI() {
    const job = state.branchWorkflow;
    const progress = els['branch-progress'];
    progress.replaceChildren();
    if (job?.created && !job.useCurrent) progress.append(document.createTextNode(`Created branch ${job.name}. `));
    if (job?.committed) progress.append(document.createTextNode(`Pushed commit ${job.committed.slice(0, 8)}. `));
    if (job?.prUrl) {
      const link = document.createElement('a');
      link.href = job.prUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Open pull request';
      progress.append(link);
    }
    els['branch-name'].disabled = Boolean(job?.attempted || els['branch-current'].checked);
    els['branch-current'].disabled = Boolean(job?.attempted);
    els['branch-review'].classList.toggle('hidden', Boolean(job?.committed || job?.done || !state.branchReview?.groups.length));
    els['branch-pr-fields'].classList.toggle('hidden', !els['branch-create-pr'].checked || Boolean(job?.done));
    els['branch-run-btn'].classList.toggle('hidden', Boolean(job?.done));
    els['branch-reset-btn'].classList.toggle('hidden', !job);
    els['branch-reset-btn'].disabled = Boolean(state.repositoryOperation);
    els['branch-run-btn'].disabled = Boolean(state.repositoryOperation);
    els['branch-run-btn'].textContent = state.repositoryOperation ? 'Working…' : job ? 'Retry / Continue' : 'Continue';
  }

  function resetBranchWorkflow() {
    if (state.repositoryOperation) return;
    state.branchWorkflow = null;
    if (state.draft) { state.draft.headerDirty = true; queueDraftSave(); }
    void openBranchModal();
  }

  async function saveBranchProgress() {
    if (!state.draft) return;
    state.draft.headerDirty = true;
    if (!await persistDraft()) throw new Error('Could not save workflow progress on this device. Your draft remains open. Retry to save and continue.');
  }

  async function moveDraftToBranch(job, context) {
    const draft = state.draft;
    const previous = draft?.scope;
    if (draft && previous !== job.destination) {
      await saveBranchProgress();
      if (!context.isCurrent()) return false;
      state.draft = { account: draft.account, scope: job.destination, paths: new Set(state.changes.keys()),
        source: { scope: previous, version: draft.version || 0 }, headerDirty: true };
    }
    state.branch = job.name;
    if (!state.branches.some(item => item.name === job.name)) state.branches.unshift({ name: job.name });
    renderBranches();
    history.replaceState(null, '', repoHash(context.provider, context.owner, context.name, job.name));
    addRecentProject();
    await saveBranchProgress();
    return true;
  }

  async function createWorkflowBranch(job, context) {
    const { client, owner, name: repo } = context;
    const ref = await client.getRef(owner, repo, job.name).catch(error => {
      if (error.status !== 404) throw error;
      return null;
    });
    if (!context.isCurrent()) return;
    if (ref && (!job.attempted || ref.object.sha !== job.baseSha)) {
      throw new Error(`Branch ${job.name} already exists. Choose a new name.`);
    }
    job.attempted = true;
    await saveBranchProgress();
    if (!context.isCurrent()) return;
    if (!ref) {
      try {
        await client.createBranch(owner, repo, job.name, job.baseSha);
      } catch (error) {
        if (!context.isCurrent()) return;
        const created = await client.getRef(owner, repo, job.name).catch(() => null);
        if (created?.object?.sha !== job.baseSha) throw error;
      }
    }
    job.created = true;
  }

  async function runBranchWorkflow() {
    if (state.repositoryOperation || state.syncPlan || state.branchWorkflow?.done || !state.repo) return;
    let context = currentRepositoryContext();
    const operation = {};
    state.repositoryOperation = operation;
    updateChangeUI();
    updateBranchWorkflowUI();
    els['branch-error'].classList.add('hidden');
    try {
      await flushEditorSync();
      if (!context.isCurrent()) return;
      const previous = state.branchWorkflow;
      const useCurrent = previous?.attempted ? previous.useCurrent : els['branch-current'].checked;
      const name = previous?.attempted ? previous.name : useCurrent ? state.branch : els['branch-name'].value.trim();
      const wantsPr = els['branch-create-pr'].checked;
      const target = els['branch-target'].value.trim();
      const title = els['branch-title'].value.trim();
      const body = els['branch-body'].value;
      const message = els['branch-message'].value.trim();
      if (!name || (!useCurrent && name === state.branch && !previous?.created)) {
        throw new Error('Enter a new branch name, or choose Use current branch.');
      }
      if (wantsPr && (!target || target === name || !title)) throw new Error('Choose a different target branch and enter a pull request title.');
      const snapshot = previous?.committed ? new Map() : selectedCommitFiles(state.branchReview);
      if (snapshot.size && !message) throw new Error('Enter a commit message for the selected files.');
      const job = state.branchWorkflow = {
        ...previous, useCurrent, name, target, title, body, message, wantsPr,
        baseSha: previous?.baseSha || state.headSha,
        selection: state.branchReview.groups.filter(group => group.checkbox.checked).map(group => group.path),
        destination: state.draft && draftScope(state.draft.account, name),
      };
      if (useCurrent) job.created = true;
      if (!job.created) {
        if (job.destination && await working.readDraft(job.destination)) {
          throw new Error(`A local draft already exists for ${name}. Open that branch to review it first.`);
        }
        if (!context.isCurrent()) return;
        await createWorkflowBranch(job, context);
        if (!context.isCurrent()) return;
      }
      updateBranchWorkflowUI();
      if (state.branch !== name) {
        if (!await moveDraftToBranch(job, context) || state.repositoryOperation !== operation) return;
        context = currentRepositoryContext();
      } else if (state.draft?.source) await saveBranchProgress();
      if (snapshot.size && !job.committed) {
        const result = await publishCommit(context, message, snapshot, job);
        if (!result || !context.isCurrent()) return;
        updateBranchWorkflowUI();
        await saveBranchProgress();
        if (!context.isCurrent()) return;
      }
      if (job.wantsPr && !job.prUrl) {
        const { client, owner, name: repo } = context;
        let pull;
        try {
          pull = await client.createPullRequest(owner, repo, name, target, title, body);
        } catch (error) {
          if (!context.isCurrent()) return;
          pull = await client.findOpenPullRequest(owner, repo, name, target).catch(() => null);
          if (!pull) throw error;
        }
        if (!context.isCurrent()) return;
        const url = new URL(pull.html_url);
        const host = context.provider === 'codeberg' ? 'codeberg.org' : 'github.com';
        if (url.protocol !== 'https:' || url.hostname !== host) throw new Error('The provider returned an invalid pull request link.');
        job.prUrl = url.href;
      }
      job.done = true;
      try { await saveBranchProgress(); } catch (error) { job.done = false; throw error; }
      if (context.isCurrent()) toast(job.prUrl ? 'Pull request is ready.' : `Branch ${name} is ready.`, 'success');
    } catch (error) {
      if (state.repositoryOperation === operation) {
        if (state.activeModal === 'branch-modal') showInlineError(els['branch-error'], error.message);
        else toast(error.message, 'error', 6000);
      }
    } finally {
      if (state.repositoryOperation === operation) {
        finishRepositoryOperation(operation);
        updateBranchWorkflowUI();
      }
    }
  }

  async function commitGitHubFiles({ owner, repo, branch, headSha, baseTreeSha }, message, snapshot, isCurrent) {
    const latestRef = await github.getRef(owner, repo, branch);
    if (!isCurrent()) return;
    if (latestRef.object.sha !== headSha) throw new Error('The branch changed on GitHub. Sync remote changes before committing.');
    const treeEntries = [];
    for (const [path, { type, mode, bytes }] of snapshot) {
      const sha = type === 'delete' ? null : (await github.createBlob(owner, repo, bytes)).sha;
      if (!isCurrent()) return;
      treeEntries.push({ path, mode, type: 'blob', sha });
    }
    const tree = await github.createTree(owner, repo, baseTreeSha, treeEntries);
    if (!isCurrent()) return;
    const commit = await github.createCommit(owner, repo, message, tree.sha, headSha);
    if (!isCurrent()) return;
    try {
      await github.updateRef(owner, repo, branch, commit.sha);
    } catch (error) {
      if (!isCurrent()) return;
      const ref = await github.getRef(owner, repo, branch).catch(() => null);
      if (ref?.object?.sha !== commit.sha) throw error;
    }
    return { sha: commit.sha, treeSha: tree.sha, treeEntries };
  }

  function acceptCommittedFiles(treeEntries, snapshot) {
    // Rebase the working files on the pushed snapshot. Edits made during the
    // requests stay local, including any still pending in the Monaco model.
    for (const { path, mode, sha } of treeEntries) {
      const meta = state.fileIndex.get(path);
      const present = meta && !state.deletedPaths.has(path);
      const pending = present && state.editorSyncPending && state.editorSyncPath === path;
      const bytes = snapshot.get(path).bytes;
      if (sha === null) {
        state.baseFiles.delete(path);
        state.originalBytes.delete(path);
        state.deletedPaths.delete(path);
        if (present) state.fileIndex.set(path, { path, mode, type: 'blob', size: meta.size, existing: false });
        else {
          state.fileIndex.delete(path);
          state.fileBytes.delete(path);
          state.sourceTextCache.delete(path);
        }
      } else {
        const base = { path, mode, type: 'blob', sha, size: bytes.length, existing: true };
        state.baseFiles.set(path, base);
        state.fileIndex.set(path, base);
        state.originalBytes.set(path, bytes);
        if (!present) state.deletedPaths.add(path);
      }

      const workingBytes = state.fileBytes.get(path);
      if (present && (pending || !sameBytes(workingBytes, bytes))) {
        const type = sha === null ? 'add' : 'modify';
        setWorkingChange(path, pending ? { type, pending: true } : { type, bytes: workingBytes });
      } else if (!present && sha !== null) setWorkingChange(path, { type: 'delete' });
      else setWorkingChange(path, null);
      updateFileTreeDirtyIndicator(path);
    }
    // A renamed destination can itself be renamed while the push runs.
    const movedSources = new Map();
    for (const [destination, change] of snapshot) {
      if (change.renameFrom && state.changes.get(destination)?.type === 'delete') movedSources.set(change.renameFrom, destination);
    }
    for (const [path, change] of state.changes) {
      if (!change.renameFrom || state.changes.get(change.renameFrom)?.type === 'delete') continue;
      setWorkingChange(path, { ...change, renameFrom: movedSources.get(change.renameFrom) });
    }
    state.rawTree = [...state.baseFiles.values(), ...state.rawTree.filter(item => item.type !== 'blob' && item.type !== 'tree')];
    els['file-count-label'].textContent = `${effectivePaths().length} files`;
    updateChangeUI();
  }

  let repoSearchRequest = 0;

  async function handleRepoSearch(e) {
    e.preventDefault();
    const request = ++repoSearchRequest;
    const provider = els['repo-search-provider'].value;
    const query = els['github-search-input'].value;
    const target = els['github-search-results'];
    const label = repositoryProviderLabel(provider);
    target.innerHTML = `<div class="project-card"><span class="owner">Searching ${label}…</span></div>`;
    try {
      const client = provider === 'codeberg' ? await ensureCodebergClient() : repositoryClient(provider);
      if (request !== repoSearchRequest) return;
      const results = await client.searchRepos(query);
      if (request === repoSearchRequest) renderSearchResults(results, provider);
    } catch (err) {
      if (request !== repoSearchRequest) return;
      target.innerHTML = `<div class="empty-state"><h3>Search failed</h3><p>${escapeHtml(err.message)}</p></div>`;
    }
  }
  function renderSearchResults(repos, provider) {
    const target = els['github-search-results']; target.innerHTML = '';
    if (!repos.length) { target.innerHTML = '<div class="empty-state"><h3>No repositories found</h3><p>Try a different repository name.</p></div>'; return; }
    for (const r of repos) {
      const card = document.createElement('a'); card.className = 'project-card';
      card.href = repoHash(provider, r.owner.login, r.name);
      card.innerHTML = `<div><div class="project-card-top"><div class="project-card-icon">T</div>${r.private ? '<span class="private-chip">private</span>' : ''}</div><h3>${escapeHtml(r.name)}</h3><div class="owner">${escapeHtml(r.owner.login)}</div></div><div class="project-card-bottom"><span>${escapeHtml(r.language || 'Repository')}</span><span>${escapeHtml(r.default_branch || 'main')}</span></div>`;
      target.appendChild(card);
    }
  }

  function getRecents() {
    try { const v = JSON.parse(localStorage.getItem(STORAGE.recents) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
  }
  function addRecentProject() {
    if (!state.repo) return;
    const provider = state.provider;
    const recents = getRecents().filter(r => r.full_name !== state.repo.full_name || (r.provider || 'github') !== provider);
    recents.unshift({ provider, full_name:state.repo.full_name, owner:state.repo.owner.login, name:state.repo.name, branch:state.branch, private:Boolean(state.repo.private), openedAt:new Date().toISOString() });
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
      const provider = r.provider || 'github';
      const providerLabel = repositoryProviderLabel(provider);
      const card = document.createElement('article'); card.className = 'project-card';
      card.innerHTML = `<div><div class="project-card-top"><div class="project-card-icon">T</div><button class="project-remove" title="Remove from recents">×</button></div><h3>${escapeHtml(r.name)}</h3><div class="owner">${escapeHtml(r.owner)} · ${providerLabel}</div></div><div class="project-card-bottom"><span>${escapeHtml(r.branch || 'main')}</span><span>${timeAgo(r.openedAt)}</span></div>`;
      card.addEventListener('click', () => location.hash = repoHash(provider, r.owner, r.name, r.branch));
      card.querySelector('.project-remove').addEventListener('click', e => {
        e.stopPropagation();
        const next = getRecents().filter(x => x.full_name !== r.full_name || (x.provider || 'github') !== provider);
        localStorage.setItem(STORAGE.recents, JSON.stringify(next)); renderRecents();
      });
      els['recent-projects'].appendChild(card);
    }
  }

  function openAuthModal(provider = state.provider) {
    state.authProvider = provider;
    state.authAttempt++;
    const codeberg = provider === 'codeberg';
    const input = els['github-token-input'];
    input.value = '';
    input.placeholder = codeberg ? 'Codeberg access token' : 'github_pat_…';
    els['auth-modal-title'].textContent = `Connect ${repositoryProviderLabel(provider)}`;
    els['auth-token-copy'].textContent = codeberg
      ? 'Use a personal access token with write:repository to edit projects. The token goes directly to the Codeberg API.'
      : 'Give your fine-grained token read and write access to Contents for the repositories you edit. To open pull requests, also give it write access to Pull requests. The token goes directly to the GitHub API.';
    els['auth-token-help'].textContent = codeberg
      ? 'Open Codeberg → Settings → Applications → Manage Access Tokens. To use a token limited to specific repositories, open its repository URL in the editor first. Account lookup and listing your repositories use read:user.'
      : 'GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens. Give it access only to the repos your group edits.';
    els['auth-error'].classList.add('hidden');
    els['disconnect-github-btn'].classList.toggle('hidden', !repositoryToken(provider));
    const btn = els['save-github-token-btn'];
    btn.disabled = false;
    btn.textContent = 'Connect';
    openModal('auth-modal');
    setTimeout(() => { if (state.activeModal === 'auth-modal') input.focus(); }, 40);
  }
  async function connectRepositoryAccount() {
    const provider = state.authProvider;
    const label = repositoryProviderLabel(provider);
    const token = els['github-token-input'].value.trim();
    if (!token) return showInlineError(els['auth-error'], `Paste a ${label} personal access token.`);
    const btn = els['save-github-token-btn'];
    if (btn.disabled || state.repositoryOperation) return;
    const remember = els['remember-token-checkbox'].checked;
    const attempt = ++state.authAttempt;
    const isCurrent = () => attempt === state.authAttempt && state.activeModal === 'auth-modal';
    const locationAtStart = location.hash;
    btn.disabled = true;
    btn.textContent = 'Checking…';
    els['auth-error'].classList.add('hidden');
    try {
      const client = provider === 'codeberg' ? await ensureCodebergClient() : repositoryClient(provider);
      if (!isCurrent()) return;
      let profile;
      try {
        profile = await client.getProfile(token);
      } catch (error) {
        if (!isCurrent()) return;
        if (provider !== 'codeberg' || error.status !== 403) throw error;
        const project = parseHash();
        if (location.hash !== locationAtStart || project.provider !== provider) {
          throw new Error('Open the Codeberg repository before connecting a repository-scoped token.');
        }
        await client.getRepo(project.owner, project.repo, token);
      }
      if (!isCurrent()) return;
      if (!await persistDraft()) throw new Error('Save the local draft before changing accounts.');
      if (!isCurrent()) return;
      saveToken(token, remember, provider);
      if (provider === 'codeberg') state.codebergProfile = profile || null;
      else state.profile = profile;
      updateAccountUI();
      closeModal();
      toast(profile?.login ? `Connected to ${label} as ${profile.login}.` : `Connected to ${label} for this repository.`, 'success');
      if (location.hash === locationAtStart && parseHash().provider === provider) {
        if (!state.headSha) route();
        else await changeDraftAccount(provider, true);
      }
    } catch (err) {
      if (isCurrent()) showInlineError(els['auth-error'], `Could not connect to ${label}. ${err.message}`);
    } finally {
      if (attempt === state.authAttempt) { btn.disabled = false; btn.textContent = 'Connect'; }
    }
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
  function setSyncStatus(text) { if (els['repo-sync-status']) els['repo-sync-status'].textContent = text; }
  function toast(message, type = '', duration = 3500) {
    const el = document.createElement('div'); el.className = `toast ${type}`; el.textContent = message; els['toast-root'].appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(8px)'; setTimeout(()=>el.remove(),180); }, duration);
  }
  function handleFatalRepoError(err) {
    if (err?.name === 'AbortError') return;
    console.error(err);
    setCompileStatus('error','Could not open repository');
    toast(err.status === 404 ? `Repository not found or your ${repositoryProviderLabel()} token cannot access it.` : err.message, 'error', 6500);
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
