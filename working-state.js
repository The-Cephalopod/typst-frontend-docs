/* Draft storage and line-based review shared by commit and sync. */
(() => {
  'use strict';

  let database;
  function openDrafts() {
    if (!database) database = new Promise((resolve, reject) => {
      const request = indexedDB.open('typstgit-working-drafts', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('drafts', { keyPath: 'scope' });
        const files = request.result.createObjectStore('files', { keyPath: ['scope', 'path'] });
        files.createIndex('scope', 'scope');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Close other editor windows to enable draft storage.'));
    }).catch(error => { database = null; throw error; });
    return database;
  }

  function transactionDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error || new Error('Local draft write was interrupted.'));
    });
  }

  async function readDraft(scope) {
    const db = await openDrafts();
    const tx = db.transaction(['drafts', 'files']);
    const header = tx.objectStore('drafts').get(scope);
    const files = tx.objectStore('files').index('scope').getAll(scope);
    await transactionDone(tx);
    return header.result && { ...header.result, files: files.result };
  }

  async function writeDraft(header, updates, expectedVersion, source) {
    const db = await openDrafts();
    const tx = db.transaction(['drafts', 'files'], 'readwrite');
    const files = tx.objectStore('files');
    const drafts = tx.objectStore('drafts');
    const existing = drafts.get(header.scope);
    const previous = source && drafts.get(source.scope);
    let collision = false;
    const remove = scope => {
      drafts.delete(scope);
      files.delete(IDBKeyRange.bound([scope], [scope, []]));
    };
    const save = () => {
      if ((existing.result?.version || 0) !== expectedVersion ||
          (source && (previous.result?.version || 0) !== source.version)) {
        collision = true;
        tx.abort();
        return;
      }
      if (header.keep) {
        for (const [path, value] of updates) {
          if (value) files.put({ ...value, scope: header.scope, path });
          else files.delete([header.scope, path]);
        }
        drafts.put({ ...header, version: expectedVersion + 1 });
      } else remove(header.scope);
      if (source) remove(source.scope);
    };
    (previous || existing).onsuccess = save;
    try {
      await transactionDone(tx);
    } catch (error) {
      if (collision) throw new Error('Another editor window saved this draft. Reopen the branch to load that version.');
      throw error;
    }
    return header.keep ? expectedVersion + 1 : 0;
  }

  function changeGroups(changes) {
    const groups = [];
    const paired = new Set();
    for (const [path, change] of changes) {
      const from = change.renameFrom;
      if (change.type !== 'delete' && from && changes.get(from)?.type === 'delete' && !paired.has(from)) {
        groups.push({ path, from, paths: [from, path], type: 'rename' });
        paired.add(from);
        paired.add(path);
      }
    }
    for (const [path, change] of changes) {
      if (!paired.has(path)) groups.push({ path, paths: [path], type: change.type });
    }
    return groups.sort((a, b) => a.path.localeCompare(b.path));
  }

  // Preserve terminators so merges retain CRLF and final-newline edits.
  function splitLines(text) {
    return text.match(/[^\n]*\n|[^\n]+$/g) || [];
  }

  // Bounded Myers search. A very large rewrite is represented as one hunk.
  function lineHunks(before, after) {
    let start = 0, endA = before.length, endB = after.length;
    while (start < endA && start < endB && before[start] === after[start]) start++;
    while (endA > start && endB > start && before[endA - 1] === after[endB - 1]) {
      endA--; endB--;
    }
    if (endA === start && endB === start) return [];
    const fallback = () => [{ start, end: endA, lines: after.slice(start, endB) }];
    const n = endA - start, m = endB - start;
    if (!n || !m || Math.abs(n - m) > 256) return fallback();
    const frontier = new Map([[1, 0]]);
    const trace = [];
    for (let distance = 0; distance <= 256; distance++) {
      trace.push(new Map(frontier));
      for (let k = -distance; k <= distance; k += 2) {
        const down = k === -distance || (k !== distance && frontier.get(k - 1) < frontier.get(k + 1));
        let x = down ? frontier.get(k + 1) : frontier.get(k - 1) + 1;
        let y = x - k;
        while (x < n && y < m && before[start + x] === after[start + y]) { x++; y++; }
        frontier.set(k, x);
        if (x !== n || y !== m) continue;

        const edits = [];
        for (let d = distance; d > 0; d--) {
          const previous = trace[d];
          const diagonal = x - y;
          const insert = diagonal === -d || (diagonal !== d && previous.get(diagonal - 1) < previous.get(diagonal + 1));
          const prevK = diagonal + (insert ? 1 : -1);
          const prevX = previous.get(prevK);
          const prevY = prevX - prevK;
          edits.push(insert
            ? { start: start + prevX, end: start + prevX, lines: [after[start + prevY]] }
            : { start: start + prevX, end: start + prevX + 1, lines: [] });
          x = prevX; y = prevY;
        }
        const hunks = [];
        for (const edit of edits.reverse()) {
          const last = hunks.at(-1);
          if (last?.end === edit.start) {
            last.end = edit.end;
            if (edit.lines.length) last.lines.push(edit.lines[0]);
          } else hunks.push(edit);
        }
        return hunks;
      }
    }
    return fallback();
  }

  function mergeText(base, local, remote) {
    const before = splitLines(base);
    const editsFor = text => lineHunks(before, splitLines(text)).flatMap(hunk => {
      const length = hunk.end - hunk.start;
      if (length < 2 || length > 256 || length !== hunk.lines.length) return [hunk];
      // Independent line replacements can share one contiguous review hunk.
      return hunk.lines.flatMap((line, offset) => {
        const start = hunk.start + offset;
        return line === before[start] ? [] : [{ start, end: start + 1, lines: [line] }];
      });
    });
    const localHunks = editsFor(local);
    const remoteHunks = editsFor(remote);
    const merged = [];
    let i = 0, j = 0;
    while (i < localHunks.length && j < remoteHunks.length) {
      const a = localHunks[i], b = remoteHunks[j];
      if (a.start === b.start && a.end === b.end && a.lines.join('') === b.lines.join('')) {
        merged.push(a); i++; j++;
      } else if (a.start === b.start && a.end === b.end) return null;
      else if (a.end <= b.start) { merged.push(a); i++; }
      else if (b.end <= a.start) { merged.push(b); j++; }
      else return null;
    }
    merged.push(...localHunks.slice(i), ...remoteHunks.slice(j));
    let cursor = 0;
    const parts = [];
    for (const hunk of merged) {
      parts.push(before.slice(cursor, hunk.start).join(''), hunk.lines.join(''));
      cursor = hunk.end;
    }
    parts.push(before.slice(cursor).join(''));
    return parts.join('');
  }

  function remoteMoves(base, remote) {
    // Git trees expose paths and blob IDs. Only infer unambiguous moves.
    const added = new Map();
    const removed = new Map();
    const collect = (from, to, result) => {
      for (const [path, file] of from) {
        if (to.has(path)) continue;
        const key = file.sha + ':' + file.mode;
        result.set(key, result.has(key) ? null : path);
      }
    };
    collect(remote, base, added);
    collect(base, remote, removed);
    const moves = new Map();
    for (const [key, path] of removed) if (path && added.get(key)) moves.set(path, added.get(key));
    return moves;
  }

  window.TypstWorkingState = { readDraft, writeDraft, changeGroups, splitLines, lineHunks, mergeText, remoteMoves };
})();
