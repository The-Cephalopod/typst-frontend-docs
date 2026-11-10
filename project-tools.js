/* On-demand project tools. These scans do not run in the preview pipeline. */
(() => {
  'use strict';

  const MAX_MATCHES = 500;
  const MAX_OUTLINE_FILES = 256;
  const MAX_SEARCH_BATCH_BYTES = 8 * 1024 * 1024;
  const SCAN_BLOCK = 64 * 1024;
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  async function scanMatches(text, query, matchCase, limit, current) {
    const literal = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tokens = new RegExp(literal + '|\\r\\n|[\\r\\n]', matchCase ? 'gu' : 'giu');
    const matches = [];
    let line = 1;
    let lineStart = 0;
    let started = performance.now();
    for (let start = 0; start < text.length && matches.length < limit;) {
      const end = Math.min(start + SCAN_BLOCK, text.length);
      // Carry enough overlap for a match or CRLF across a chunk boundary.
      const chunk = text.slice(start, end + Math.max(1, query.length - 1));
      tokens.lastIndex = 0;
      let next = end;
      let token;
      while (matches.length < limit && (token = tokens.exec(chunk)) && start + token.index < end) {
        const value = token[0];
        const offset = start + token.index;
        next = Math.max(next, offset + value.length);
        if (value[0] === '\r' || value[0] === '\n') {
          line++;
          lineStart = offset + value.length;
          continue;
        }
        const prefixStart = Math.max(lineStart, offset - 42);
        const tail = text.slice(offset + value.length, offset + value.length + 64);
        const suffix = tail.split(/[\r\n]/, 1)[0];
        matches.push({
          line, column: offset - lineStart + 1, offset, value,
          prefix: (prefixStart > lineStart ? '…' : '') + text.slice(prefixStart, offset),
          suffix: suffix + (suffix.length === 64 ? '…' : ''),
        });
      }
      start = next;
      if (performance.now() - started >= 5) {
        await tick();
        if (!current()) return [];
        started = performance.now();
      }
    }
    return matches;
  }

  function cleanHeading(text) {
    return text.replace(/[ \t]+(?:\/\/|\/\*).*$/, '').replace(/\s+<[\w:.-]+>\s*$/, '').trim();
  }

  function readCallPrefix(text, offset) {
    // Capture labels from common literal calls without evaluating Typst.
    // The bound keeps an unfinished call from scanning the rest of the file.
    const sample = text.slice(offset, offset + 2048);
    const start = /^\s*(\(|\[)/.exec(sample);
    if (!start) return '';
    const first = start[1];
    const closes = { '(': ')', '[': ']', '{': '}' };
    const stack = [closes[first]];
    const tokens = /[()[\]{}]|"(?:\\.|[^"\\])*"|\/(?:\/[^\r\n]*|\*[\s\S]*?\*\/)/g;
    tokens.lastIndex = start[0].length;
    let token;
    while ((token = tokens.exec(sample))) {
      const value = token[0];
      if (closes[value]) stack.push(closes[value]);
      else if (value === stack.at(-1)) {
        stack.pop();
        if (!stack.length) {
          const suffix = first === '(' ? (/^[ \t]*\[[^\]\r\n]*\]/.exec(sample.slice(tokens.lastIndex))?.[0] || '') : '';
          return sample.slice(0, tokens.lastIndex) + suffix;
        }
      }
    }
    return sample;
  }

  async function scanOutline(text, current) {
    const markup = /^[ \t]*(=+)[ \t]+|\/\/|\/\*|`+|"(?:\\[^\r\n]|[^"\\\r\n])*"|\\[^\r\n]|#(?:include|heading|figure|table)(?![\w-])|\r\n|[\r\n]/gm;
    const comments = /\/\*|\*\/|\r\n|[\r\n]/g;
    const raw = /`+|\r\n|[\r\n]/g;
    const nextLine = /[\r\n]/g;
    const entries = [];
    let started = performance.now();
    let position = 0;
    let line = 1;
    let lineStart = 0;
    let commentDepth = 0;
    let rawFence = 0;
    let wrappedTable = -1;
    let iterations = 0;
    while (entries.length <= MAX_MATCHES) {
      if (++iterations % 256 === 0 && performance.now() - started >= 5) {
        await tick();
        if (!current()) return [];
        started = performance.now();
      }
      const scanner = commentDepth ? comments : rawFence ? raw : markup;
      scanner.lastIndex = position;
      const token = scanner.exec(text);
      if (!token) break;
      position = scanner.lastIndex;
      const value = token[0];
      if (value[0] === '\r' || value[0] === '\n') {
        line++;
        lineStart = position;
      } else if (commentDepth) {
        commentDepth += value === '/*' ? 1 : -1;
      } else if (rawFence) {
        if (value.length === rawFence) rawFence = 0;
      } else if (value === '/*') {
        commentDepth = 1;
      } else if (value === '//' && text[token.index - 1] !== ':') {
        nextLine.lastIndex = position;
        position = nextLine.exec(text)?.index ?? text.length;
      } else if (value[0] === '`') {
        rawFence = value.length;
      } else if (token[1]) {
        nextLine.lastIndex = position;
        const end = nextLine.exec(text)?.index ?? text.length;
        const title = cleanHeading(text.slice(position, Math.min(end, position + 240)));
        if (title) entries.push({ kind: 'heading', level: token[1].length, title, line, column: position - lineStart + 1, length: title.length });
      } else if (value === '#include') {
        const include = /^\s*(\(\s*)?("(?:\\["\\]|[^"\\\r\n])+")(?![ \t]*[+*/])/.exec(text.slice(position, position + 2048));
        if (include) {
          if (!include[1] || /^\s*\)/.test(text.slice(position + include[0].length, position + 2048))) {
            const reference = include[2].slice(1, -1).replace(/\\(["\\])/g, '$1');
            entries.push({ kind: 'include', reference });
          }
          position += include[0].length;
        }
      } else if (value[0] === '#' && token.index !== wrappedTable) {
        const call = readCallPrefix(text, position);
        if (!call) continue;
        const name = value.slice(1);
        const label = name === 'heading' ? /\[([^\]\r\n]*)\]/.exec(call) : /\bcaption\s*:\s*\[([^\]\r\n]*)\]/.exec(call);
        const kind = name === 'figure' && /^\s*\(\s*(?:\[\s*#)?table\s*\(/.test(call) ? 'table' : name;
        if (kind === 'table' && name === 'figure' && /^\s*\(\s*\[\s*#table/.test(call)) {
          wrappedTable = position + call.indexOf('#table');
        }
        const title = label?.[1]?.trim().slice(0, 240) || '';
        const level = name === 'heading' ? Number(/\blevel\s*:\s*([1-9]\d*)\b/.exec(call)?.[1] || 1) : 0;
        entries.push({ kind, level, title, line, column: token.index - lineStart + 1, length: value.length });
      }
    }
    return entries;
  }

  function createProjectTools({ getScope, getTextFiles, getEntry, readText, resolveReference, jump, replace, afterReplace, report }) {
    const byId = id => document.getElementById(id);
    const sidebar = byId('file-sidebar');
    const buttons = sidebar.querySelectorAll('[data-project-tool]');
    const fileView = [byId('file-path-filter'), byId('file-tree')];
    const searchPanel = byId('project-search-panel');
    const outlinePanel = byId('project-outline-panel');
    const query = byId('project-search-query');
    const matchCase = byId('project-search-case');
    const replacement = byId('project-search-replacement');
    const previewButton = byId('project-search-preview');
    const applyButton = byId('project-search-apply');
    const selectButton = byId('project-search-select');
    const searchStatus = byId('project-search-status');
    const searchResults = byId('project-search-results');
    const outlineStatus = byId('project-outline-status');
    const outlineResults = byId('project-outline-results');

    let mode = 'files';
    let searchId = 0;
    let searchQueue = Promise.resolve();
    let result = null;
    let replacementPreview = null;
    let applying = false;
    let outlineId = 0;
    let outlineTimer;
    let outlineQueue = Promise.resolve();
    let outlineCache = new Map();

    const sameScope = (left, right) => left.every((value, index) => value === right[index]);
    const jumpTo = (path, item, length = item.length) => {
      void jump({ path, line: item.line, column: item.column, length }).catch(error => report(error.message, 'error'));
    };

    function setMode(next) {
      mode = next;
      sidebar.dataset.projectTool = next;
      for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.projectTool === next));
      for (const node of fileView) node.classList.toggle('hidden', next !== 'files');
      searchPanel.classList.toggle('hidden', next !== 'search');
      outlinePanel.classList.toggle('hidden', next !== 'outline');
      if (next === 'search') query.focus();
      if (next === 'outline') scheduleOutline(0);
      else {
        ++outlineId;
        clearTimeout(outlineTimer);
        outlineCache = new Map();
      }
    }

    function updateSelection() {
      const selected = result?.groups.reduce((count, group) => count + group.matches.filter(match => match.selected).length, 0) || 0;
      applyButton.disabled = applying || !selected;
      applyButton.textContent = selected ? `Apply selected (${selected})` : 'Apply selected';
      selectButton.textContent = selected ? 'Clear selection' : 'Select all';
    }

    function renderSearch() {
      const fragment = document.createDocumentFragment();
      const previewing = replacementPreview !== null;
      previewButton.disabled = applying || !result?.count;
      applyButton.classList.toggle('hidden', !previewing);
      selectButton.classList.toggle('hidden', !previewing);
      for (const group of result?.groups || []) {
        const heading = element('h3', 'project-search-group', group.path);
        fragment.appendChild(heading);
        const list = element('ul');
        for (const match of group.matches) {
          const row = element('li', 'project-search-match');
          if (previewing) {
            const checkbox = element('input');
            checkbox.type = 'checkbox';
            checkbox.checked = match.selected;
            checkbox.disabled = applying || match.value === replacementPreview;
            checkbox.setAttribute('aria-label', `Replace in ${group.path}, line ${match.line}, column ${match.column}`);
            checkbox.addEventListener('change', () => { match.selected = checkbox.checked; updateSelection(); });
            row.appendChild(checkbox);
          }
          const location = element('button', 'project-tool-jump');
          location.type = 'button';
          location.appendChild(element('small', '', String(match.line)));
          const snippet = element('span', 'project-search-line');
          const hit = match.value.length > 80 ? match.value.slice(0, 80) + '…' : match.value;
          snippet.append(match.prefix, element('mark', '', hit), match.suffix);
          location.appendChild(snippet);
          if (previewing) {
            const next = replacementPreview.length > 80 ? replacementPreview.slice(0, 80) + '…' : replacementPreview;
            const after = element('span', 'project-search-line project-replacement-line');
            after.append('→ ', match.prefix, element('mark', '', next), match.suffix);
            location.appendChild(after);
          }
          location.addEventListener('click', () => {
            if (!sameScope(result.scope, getScope())) {
              clearSearch('The project changed. Search again for current matches.');
              return;
            }
            jumpTo(group.path, match, match.value.length);
          });
          row.appendChild(location);
          list.appendChild(row);
        }
        fragment.appendChild(list);
      }
      searchResults.replaceChildren(fragment);
      updateSelection();
    }

    function clearSearch(message = 'Search the contents of project files.') {
      searchId++;
      result = null;
      replacementPreview = null;
      searchStatus.textContent = message;
      renderSearch();
    }

    function search(event) {
      event.preventDefault();
      if (applying || !query.value) return;
      clearSearch('Searching project files…');
      const request = searchId;
      const scope = getScope();
      const term = query.value;
      const sensitive = matchCase.checked;
      const current = () => searchId === request && sameScope(scope, getScope());
      searchQueue = searchQueue.then(async () => {
        if (!current()) return;
        const groups = [];
        const candidates = getTextFiles();
        let count = 0;
        let skipped = 0;
        let firstError = '';
        let finished = 0;
        // Batches preserve result order while limiting unopened blob reads.
        for (let index = 0; index < candidates.length && current() && count < MAX_MATCHES;) {
          const batch = [];
          let batchBytes = 0;
          while (index < candidates.length && batch.length < 4) {
            const { path, size } = candidates[index];
            if (batch.length && batchBytes + size > MAX_SEARCH_BATCH_BYTES) break;
            batch.push(path);
            batchBytes += size;
            index++;
          }
          const files = await Promise.allSettled(batch.map(readText));
          for (const [indexInBatch, file] of files.entries()) {
            if (!current() || count >= MAX_MATCHES) break;
            finished++;
            if (file.status === 'rejected') {
              skipped++;
              firstError ||= `${batch[indexInBatch]} · ${file.reason.message}`;
              continue;
            }
            if (!file.value) continue;
            const { text, revision } = file.value;
            const matches = await scanMatches(text, term, sensitive, MAX_MATCHES - count, current);
            if (!matches.length) continue;
            count += matches.length;
            groups.push({ path: batch[indexInBatch], revision, matches });
          }
          // Yield even when every file was already cached.
          await tick();
        }
        if (!current()) return;
        result = { count, groups, scope };
        const summary = count === MAX_MATCHES ? `Showing up to ${MAX_MATCHES} matches. Narrow the search to see more.` :
          count ? `${count} ${count === 1 ? 'match' : 'matches'} in ${groups.length} ${groups.length === 1 ? 'file' : 'files'}.` : 'No matches found.';
        searchStatus.textContent = summary + (skipped ? ` Could not read ${skipped} of ${finished} files. ${firstError}` : '');
        renderSearch();
      }).catch(error => { if (current()) clearSearch(`Search failed. ${error.message}`); }).finally(() => {
        if (searchId === request && !sameScope(scope, getScope())) {
          clearSearch('The project changed. Search again for current matches.');
        }
      });
    }

    function previewReplacement() {
      if (!result || applying) return;
      replacementPreview = replacement.value;
      for (const group of result.groups) {
        for (const match of group.matches) match.selected = match.value !== replacementPreview;
      }
      renderSearch();
    }

    async function applyReplacement() {
      if (!result || replacementPreview === null || applying) return;
      const { groups, scope } = result;
      const request = searchId;
      const next = replacementPreview;
      const current = () => searchId === request && sameScope(scope, getScope());
      if (!current()) { clearSearch('The project changed. Search again to replace current matches.'); return; }
      applying = true;
      for (const input of [query, matchCase, replacement, selectButton]) input.disabled = true;
      renderSearch();
      let replaced = 0;
      let skipped = 0;
      const failures = [];
      try {
        for (const group of groups) {
          if (!current()) return;
          const selected = group.matches.filter(match => match.selected);
          if (!selected.length) continue;
          try {
            const count = await replace(group.path, group.revision, selected, next, current);
            replaced += count;
            skipped += selected.length - count;
          } catch (error) { failures.push(`${group.path} · ${error.message}`); }
        }
        if (current()) {
          if (replaced || failures.length) afterReplace();
          const skippedText = skipped ? ` Skipped ${skipped} outdated ${skipped === 1 ? 'match' : 'matches'}.` : '';
          const failedText = failures.length ? ` Could not finish ${failures.length} ${failures.length === 1 ? 'file' : 'files'}. ${failures[0]}` : '';
          clearSearch(`Replaced ${replaced} ${replaced === 1 ? 'match' : 'matches'}.${skippedText}${failedText} Search again for current matches.`);
        }
      } finally {
        applying = false;
        for (const input of [query, matchCase, replacement, selectButton]) input.disabled = false;
        renderSearch();
      }
    }

    function renderOutline(entries) {
      const root = { children: [] };
      const parents = [root];
      for (const entry of entries) {
        if (entry.kind === 'heading') {
          while (parents.length > 1 && parents.at(-1).level >= entry.level) parents.pop();
        }
        const item = { ...entry, children: [] };
        parents.at(-1).children.push(item);
        if (entry.kind === 'heading') parents.push(item);
      }
      function renderList(items) {
        const list = element('ul');
        for (const item of items) {
          const li = element('li');
          const button = element('button', 'project-tool-jump');
          button.type = 'button';
          button.title = `${item.path} · line ${item.line}`;
          if (item.kind !== 'heading') button.appendChild(element('small', '', item.kind === 'figure' ? 'Figure' : 'Table'));
          button.append(item.title || (item.kind === 'heading' ? 'Heading' : `Line ${item.line}`));
          button.addEventListener('click', () => jumpTo(item.path, item));
          li.appendChild(button);
          if (item.children.length) li.appendChild(renderList(item.children));
          list.appendChild(li);
        }
        return list;
      }
      outlineResults.replaceChildren(renderList(root.children));
    }

    function scheduleOutline(delay = 220) {
      if (mode !== 'outline') return;
      const request = ++outlineId;
      clearTimeout(outlineTimer);
      outlineTimer = setTimeout(() => {
        const scope = getScope();
        const entryPath = getEntry();
        const current = () => outlineId === request && sameScope(scope, getScope()) && getEntry() === entryPath;
        outlineQueue = outlineQueue.then(async () => {
          if (!current()) return;
          if (!entryPath) {
            outlineStatus.textContent = 'Choose a Typst file for preview.';
            outlineResults.replaceChildren();
            return;
          }
          if (!outlineResults.children.length) outlineStatus.textContent = 'Reading document structure…';
          const entries = [];
          const active = new Set();
          const used = new Set();
          let visited = 0;
          let unavailable = 0;
          let limited = false;
          async function visit(path) {
            if (!current() || active.has(path)) return;
            if (++visited > MAX_OUTLINE_FILES || entries.length >= MAX_MATCHES) { limited = true; return; }
            active.add(path);
            used.add(path);
            try {
              const file = await readText(path);
              if (!current()) return;
              if (!file) { unavailable++; return; }
              let cached = outlineCache.get(path);
              if (!cached || cached.revision !== file.revision) {
                cached = { revision: file.revision, tokens: await scanOutline(file.text, current) };
                if (!current()) return;
                outlineCache.set(path, cached);
              }
              for (const token of cached.tokens) {
                if (!current()) return;
                if (entries.length >= MAX_MATCHES) { limited = true; break; }
                if (token.kind === 'include') {
                  const ref = resolveReference(path, token.reference);
                  if (ref && /\.typ$/i.test(ref)) await visit(ref);
                } else entries.push({ ...token, path });
              }
            } catch { unavailable++; }
            finally { active.delete(path); }
          }
          await visit(entryPath);
          if (!current()) return;
          for (const path of outlineCache.keys()) if (!used.has(path)) outlineCache.delete(path);
          const summary = entries.length ? entryPath : `No source headings, figures, or tables in ${entryPath}.`;
          outlineStatus.textContent = summary + (limited ? ' Outline limit reached.' : '') +
            (unavailable ? ` Could not read ${unavailable} source ${unavailable === 1 ? 'file' : 'files'}.` : '');
          renderOutline(entries);
        }).catch(error => {
          if (!current()) return;
          outlineStatus.textContent = `Could not read the outline. ${error.message}`;
          outlineResults.replaceChildren();
        });
      }, delay);
    }

    for (const button of buttons) button.addEventListener('click', () => setMode(button.dataset.projectTool));
    byId('project-search-form').addEventListener('submit', search);
    query.addEventListener('input', () => clearSearch());
    matchCase.addEventListener('change', () => clearSearch());
    replacement.addEventListener('input', () => {
      if (replacementPreview === null) return;
      replacementPreview = null;
      renderSearch();
    });
    previewButton.addEventListener('click', previewReplacement);
    applyButton.addEventListener('click', applyReplacement);
    selectButton.addEventListener('click', () => {
      const select = !result.groups.some(group => group.matches.some(match => match.selected));
      for (const group of result.groups) {
        for (const match of group.matches) match.selected = select && match.value !== replacementPreview;
      }
      renderSearch();
    });
    return {
      scheduleOutline,
      reset() {
        setMode('files');
        clearSearch();
        query.value = '';
        replacement.value = '';
        outlineResults.replaceChildren();
        outlineStatus.textContent = '';
      },
    };
  }

  window.createProjectTools = createProjectTools;
})();
