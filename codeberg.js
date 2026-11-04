(() => {
  'use strict';

  const API = 'https://codeberg.org/api/v1';
  const BRANCH_PAGE_SIZE = 50;
  const TREE_PAGE_SIZE = 1000;

  function repoPath(owner, repo) {
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }

  function normalizeRepo(repo) {
    return { ...repo, stargazers_count: repo.stars_count ?? repo.stargazers_count ?? 0 };
  }

  function encodeBytes(bytes) {
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
  }

  function apiError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
  }

  class CodebergClient {
    constructor(getToken) {
      this.getToken = getToken;
    }

    async request(path, { method = 'GET', body, cache, token = this.getToken() } = {}) {
      const headers = { Accept: 'application/json' };
      if (token) headers.Authorization = `token ${token}`;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(API + path, {
        method, headers, credentials: 'omit', redirect: 'error', cache,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        throw apiError(response.status, result?.message || `Codeberg returned HTTP ${response.status}.`);
      }
      if (result === null) throw new Error('Codeberg returned an invalid API response.');
      return result;
    }

    getProfile(token) {
      return this.request('/user', { token });
    }

    async getRepo(owner, repo, token) {
      return normalizeRepo(await this.request(repoPath(owner, repo), { token }));
    }

    async getBranches(owner, repo) {
      const branches = [];
      const token = this.getToken() || '';
      for (let page = 1; ; page++) {
        const items = await this.request(`${repoPath(owner, repo)}/branches?limit=${BRANCH_PAGE_SIZE}&page=${page}`, { token });
        branches.push(...items);
        if (items.length < BRANCH_PAGE_SIZE) return branches;
      }
    }

    async getRef(owner, repo, branch, token) {
      const encodedBranch = branch.split('/').map(encodeURIComponent).join('/');
      const refs = await this.request(`${repoPath(owner, repo)}/git/refs/heads/${encodedBranch}`, { token, cache: 'no-store' });
      const ref = refs.find(item => item.ref === `refs/heads/${branch}`);
      if (!ref?.object?.sha) throw apiError(404, `Branch ${branch} was not found on Codeberg.`);
      return ref;
    }

    async getCommit(owner, repo, sha) {
      const result = await this.request(`${repoPath(owner, repo)}/git/commits/${encodeURIComponent(sha)}?stat=false&verification=false&files=false`);
      return { ...result, tree: result.commit.tree };
    }

    async getTree(owner, repo, sha) {
      const tree = [];
      const token = this.getToken() || '';
      for (let page = 1; ; page++) {
        const result = await this.request(`${repoPath(owner, repo)}/git/trees/${encodeURIComponent(sha)}?recursive=true&per_page=${TREE_PAGE_SIZE}&page=${page}`, { token });
        const entries = result.tree || [];
        tree.push(...entries);
        if (!result.truncated || !entries.length) return { ...result, tree };
      }
    }

    getBlob(owner, repo, sha) {
      return this.request(`${repoPath(owner, repo)}/git/blobs/${encodeURIComponent(sha)}`);
    }

    async searchRepos(query) {
      const q = query.trim();
      if (!q && !this.getToken()) return [];
      const repos = q
        ? (await this.request(`/repos/search?q=${encodeURIComponent(q)}&includeDesc=true&sort=updated&order=desc&limit=18`)).data
        : await this.request('/user/repos?order_by=recentupdate&limit=18');
      return (repos || []).map(normalizeRepo);
    }

    async commitFiles(owner, repo, branch, message, headSha, changes, isCurrent = () => true) {
      const token = this.getToken();
      if (!token) throw new Error('Connect Codeberg before committing changes.');
      const moves = new Map();
      const moveSources = new Set();
      for (const [path, { type, renameFrom }] of changes) {
        if (type !== 'add' || !renameFrom || moveSources.has(renameFrom)) continue;
        const original = changes.get(renameFrom);
        if (original?.type !== 'delete' || !original.sha) continue;
        moves.set(path, { path: renameFrom, sha: original.sha, mode: original.mode });
        moveSources.add(renameFrom);
      }
      const files = [];
      for (const [path, { type, bytes, sha }] of changes) {
        if (moveSources.has(path)) continue;
        const move = moves.get(path);
        if (move) {
          files.push({ operation: 'update', path, from_path: move.path, sha: move.sha, content: encodeBytes(bytes) });
          continue;
        }
        if (type === 'add') {
          files.push({ operation: 'create', path, content: encodeBytes(bytes) });
          continue;
        }
        if (!sha) throw new Error(`The original Codeberg blob for ${path} is missing. Reload the project before committing.`);
        if (type === 'delete') files.push({ operation: 'delete', path, sha });
        else files.push({ operation: 'update', path, sha, content: encodeBytes(bytes) });
      }
      const latest = await this.getRef(owner, repo, branch, token);
      if (!isCurrent() || token !== this.getToken()) {
        const error = new Error('The active Codeberg project or account changed.');
        error.name = 'AbortError';
        throw error;
      }
      if (latest.object.sha !== headSha) {
        throw apiError(409, 'The branch changed on Codeberg after you opened it. Reload the project before committing.');
      }

      // Forgejo creates one commit and pushes without force. The API checks
      // existing blob SHAs but does not accept an expected branch head.
      const result = await this.request(`${repoPath(owner, repo)}/contents`, {
        method: 'POST', token, body: { branch, message, files },
      });
      const commit = result.commit;
      const returnedFiles = new Map((result.files || []).filter(Boolean).map(file => [file.path, file.sha]));
      const treeEntries = Array.from(changes, ([path, change]) => {
        const sha = change.type === 'delete' ? null : returnedFiles.get(path);
        if (sha === undefined) throw new Error('Codeberg did not return the committed file metadata. Reload the project to verify the commit.');
        // Forgejo preserves existing modes on both updates and moves.
        const mode = moves.get(path)?.mode ?? (change.type === 'add' ? '100644' : change.mode);
        return { path, mode, type: 'blob', sha };
      });
      if (!commit?.sha || !commit.tree?.sha) throw new Error('Codeberg did not return the commit metadata. Reload the project to verify the commit.');
      return { sha: commit.sha, treeSha: commit.tree.sha, parentSha: commit.parents?.[0]?.sha, treeEntries };
    }
  }

  window.CodebergClient = CodebergClient;
})();
