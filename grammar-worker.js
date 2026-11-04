'use strict';

// This worker checks English prose. The scanner recognizes common Typst
// constructs so code and verbatim text don't become grammar suggestions.
const MARKUP_TOKEN = /\b(?:https?:\/\/|ftp:\/\/|mailto:|www\.)[^\s<>\[\]{}]+|\/\/|\/\*|[\\#$`*_\[\]<@"']/gi;
const IDENTIFIER = /[\p{L}_][\p{L}\p{N}_-]*/uy;
const NUMBER = /[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[\p{L}%]*/uy;
const LABEL = /<[^<>\s]+>/y;
const REFERENCE = /@[\p{L}\p{N}_:.-]+/uy;
const DIRECTIVES = new Set(['let', 'set', 'show', 'import', 'include', 'if', 'else', 'for', 'while', 'context', 'return', 'break', 'continue']);
const MAX_NESTING = 64;
const MAX_DIAGNOSTICS = 200;
const FILE_EXTENSION = '(?:typ|pdf|png|jpe?g|gif|svg|webp|csv|json|ya?ml|xml|toml|txt|md|[ot]tf|woff2?)';
const PATH_PREFIX = String.raw`(?:\.\.?[\\/]|[A-Za-z]:\\|\/)`;
const QUOTED_PATH = new RegExp(String.raw`(["'])(?:${PATH_PREFIX}[^"'\r\n]+|[^"'\r\n]*\.${FILE_EXTENSION})\1`, 'iy');
const FILE_PATH = new RegExp(String.raw`(?<![\p{L}\p{M}\p{N}_])(?:${PATH_PREFIX}[^\s"'<>]+|[\p{L}\p{N}_-]+(?:[\\/][\p{L}\p{N}_.-]+)+|[\p{L}\p{N}_-]+\.${FILE_EXTENSION}\b)`, 'giu');
const REPEATED_WORD = /(?<![\p{L}\p{N}_])(the|a|an|to|of|in|for|with|and|or|from|at|on|by|is|was|were|are|will)[ \t]+(?=(\1)(?![\p{L}\p{N}_'’]))/giu;
const LOWERCASE_I = /(?<![\p{L}\p{M}\p{N}_'’])i(?![\p{L}\p{M}\p{N}_])/gu;
const AGREEMENT = /(?<![\p{L}\p{N}_'’])(i|you|we|they|he|she|it)[ \t]+(am|is|are|has|does)(?![\p{L}\p{N}_'’])/giu;
const MODAL_OF = /(?<![\p{L}\p{N}_])(?:could|would|should|might|must)[ \t]+(of)(?=[ \t]+(?:been|had|done|gone|known|said|seen|made|told|taken|given|forgotten|brought|thought)\b)/giu;
const VERB_CORRECTIONS = {
  i: { is: 'am', are: 'am', has: 'have', does: 'do' },
  you: { am: 'are', is: 'are', has: 'have', does: 'do' },
  we: { am: 'are', is: 'are', has: 'have', does: 'do' },
  they: { am: 'are', is: 'are', has: 'have', does: 'do' },
  he: { am: 'is', are: 'is' },
  she: { am: 'is', are: 'is' },
  it: { am: 'is', are: 'is' },
};

function matchAt(pattern, source, index) {
  pattern.lastIndex = index;
  return pattern.exec(source)?.[0];
}

function checkGrammar(source) {
  const diagnostics = [];
  function add(start, end, message, replacement) {
    diagnostics.push({ start, end, message, replacement });
    return diagnostics.length < MAX_DIAGNOSTICS;
  }

  function lineEnd(index) {
    const lineBreak = source.indexOf('\n', index);
    return lineBreak === -1 ? source.length : lineBreak;
  }

  function skipComment(index) {
    if (source[index + 1] === '/') return lineEnd(index);
    let depth = 1;
    for (let next = index + 2; next < source.length; next++) {
      const pair = source.slice(next, next + 2);
      if (pair === '/*') { depth++; next++; }
      if (pair === '*/') {
        if (--depth === 0) return next + 2;
        next++;
      }
    }
    return source.length;
  }

  function skipString(index) {
    for (let next = index + 1; next < source.length; next++) {
      if (source[next] === '\\') next++;
      else if (source[next] === '"') return next + 1;
    }
    return source.length;
  }

  function skipRaw(index) {
    let end = index + 1;
    while (source[end] === '`') end++;
    const delimiter = source.slice(index, end);
    for (let next = source.indexOf(delimiter, end); next !== -1; next = source.indexOf(delimiter, next + 1)) {
      if (source[next - 1] !== '`' && source[next + delimiter.length] !== '`') return next + delimiter.length;
    }
    return source.length;
  }

  function skipMath(index) {
    let next = index + 1;
    while (next < source.length) {
      const char = source[next];
      if (char === '$') return next + 1;
      if (char === '\\') next += 2;
      else if (char === '"') next = skipString(next);
      else if (char === '`') next = skipRaw(next);
      else if (char === '/' && (source[next + 1] === '/' || source[next + 1] === '*')) next = skipComment(next);
      else next++;
    }
    return source.length;
  }

  function codeGroup(index, closing, depth) {
    if (depth > MAX_NESTING) return source.length;
    let next = index;
    while (next < source.length) {
      const char = source[next];
      if (char === closing || (!closing && char === ';')) return next + 1;
      if (!closing && (char === '\r' || char === '\n')) return next;
      if (char === '"') next = skipString(next);
      else if (char === '`') next = skipRaw(next);
      else if (char === '$') next = skipMath(next);
      else if (char === '/') {
        next = source[next + 1] === '/' || source[next + 1] === '*' ? skipComment(next) : next + 1;
      } else if (char === '[') next = markup(next + 1, true, depth + 1);
      else if (char === '(' || char === '{') next = codeGroup(next + 1, char === '(' ? ')' : '}', depth + 1);
      else next++;
    }
    return source.length;
  }

  function inlineCode(index, depth) {
    const first = source[index];
    if (first === '"') return skipString(index);
    if (first === '$') return skipMath(index);
    if (first === '`') return skipRaw(index);
    const name = matchAt(IDENTIFIER, source, index);
    if (DIRECTIVES.has(name)) return codeGroup(index + name.length, '', depth + 1);
    const number = name ? '' : matchAt(NUMBER, source, index);
    let next = index + (name || number || '').length;
    while (next < source.length) {
      const char = source[next];
      if (char === '[') next = markup(next + 1, true, depth + 1);
      else if (char === '(' || char === '{') next = codeGroup(next + 1, char === '(' ? ')' : '}', depth + 1);
      else if (char === '.' && next > index) {
        const field = matchAt(IDENTIFIER, source, next + 1);
        if (!field) return next;
        next += field.length + 1;
      } else return next;
    }
    return source.length;
  }

  function scanProse(start, end) {
    if (start >= end || diagnostics.length >= MAX_DIAGNOSTICS) return;
    const text = source.slice(start, end);
    let from = 0;
    for (const path of text.matchAll(FILE_PATH)) {
      scanRules(text.slice(from, path.index), start + from);
      if (diagnostics.length >= MAX_DIAGNOSTICS) return;
      from = path.index + path[0].length;
    }
    scanRules(text.slice(from), start + from);
  }

  function scanRules(text, base) {
    if (!text) return;
    for (const match of text.matchAll(REPEATED_WORD)) {
      const [, first, second] = match;
      // "What it is is unclear" can legitimately repeat the verb.
      if (first.toLowerCase() === 'is' && /\b(?:what|where|who|why|how|when|which)\b[^.!?\n]*$/i.test(text.slice(Math.max(0, match.index - 160), match.index))) continue;
      const start = base + match.index + first.length;
      const end = base + match.index + match[0].length + second.length;
      if (!add(start, end, `“${second}” is repeated.`, '')) return;
    }
    for (const match of text.matchAll(LOWERCASE_I)) {
      const start = base + match.index;
      const before = source[start - 1];
      const after = source[start + 1];
      // Leave quoted letters, parenthesized variables and list numerals alone.
      if ((before === '(' && after === ')') ||
          (before === '"' && after === '"') ||
          (before === "'" && after === "'") ||
          (before === '‘' && after === '’') ||
          (before === '“' && after === '”')) continue;
      if (after === '.' && /^\s*$/.test(source.slice(source.lastIndexOf('\n', start - 1) + 1, start))) continue;
      if (!add(start, start + 1, 'Capitalize the pronoun “I”.', 'I')) return;
    }
    for (const match of text.matchAll(AGREEMENT)) {
      const [, subject, verb] = match;
      const replacement = VERB_CORRECTIONS[subject.toLowerCase()][verb.toLowerCase()];
      const subjectStart = base + match.index;
      if (!replacement || /\b(?:and|or|nor)[ \t]+$/i.test(source.slice(Math.max(0, subjectStart - 24), subjectStart))) continue;
      const end = subjectStart + match[0].length;
      if (!add(end - verb.length, end, `Use “${replacement}” with “${subject}”.`, matchCase(verb, replacement))) return;
    }
    for (const match of text.matchAll(MODAL_OF)) {
      const original = match[1];
      const end = base + match.index + match[0].length;
      if (!add(end - original.length, end, 'Use “have” after a modal verb.', matchCase(original, 'have'))) return;
    }
  }

  function markup(index, inBlock, depth) {
    if (depth > MAX_NESTING) return source.length;
    let start = index;
    let next = index;
    while (next < source.length) {
      MARKUP_TOKEN.lastIndex = next;
      const match = MARKUP_TOKEN.exec(source);
      if (!match) break;
      const [token] = match;
      const at = match.index;
      next = at + token.length;
      if (token === ']' && inBlock) {
        scanProse(start, at);
        return next;
      }
      if (token === '\\') {
        const escape = /^u\{[0-9a-fA-F]+\}/.exec(source.slice(next, next + 12));
        next += escape ? escape[0].length : 1;
      } else if (token === '//' || token === '/*') next = skipComment(at);
      else if (token === '`') next = skipRaw(at);
      else if (token === '$') next = skipMath(at);
      else if (token === '#') next = inlineCode(next, depth);
      else if (token === '[') next = markup(next, true, depth + 1);
      else if (token === '<') {
        const label = matchAt(LABEL, source, at);
        if (!label) continue;
        next = at + label.length;
      } else if (token === '@') {
        const reference = matchAt(REFERENCE, source, at);
        if (!reference) continue;
        next = at + reference.length;
      } else if (token === '"' || token === "'") {
        const path = matchAt(QUOTED_PATH, source, at);
        if (!path) continue;
        next = at + path.length;
      }
      scanProse(start, at);
      start = next;
    }
    scanProse(start, source.length);
    return source.length;
  }

  markup(0, false, 0);
  return diagnostics.sort((left, right) => left.start - right.start);
}

function matchCase(original, replacement) {
  if (original === original.toUpperCase()) return replacement.toUpperCase();
  if (original[0] === original[0].toUpperCase()) return replacement[0].toUpperCase() + replacement.slice(1);
  return replacement;
}

self.onmessage = event => {
  const { id, text } = event.data || {};
  try {
    if (typeof text !== 'string') throw new TypeError('Grammar checking requires document text.');
    self.postMessage({ id, diagnostics: checkGrammar(text) });
  } catch (error) {
    self.postMessage({ id, error: error?.message || String(error) });
  }
};
