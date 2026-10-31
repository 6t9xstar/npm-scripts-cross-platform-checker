// A small, quote-aware shell lexer. It is not a full POSIX parser; it is
// exactly precise enough to reason about how npm scripts behave under
// /bin/sh (macOS, Linux) and cmd.exe (Windows).

/**
 * Split a script into command segments at &&, ||, ;, | and & while
 * respecting quotes, $(...) and backticks.
 * @returns {{text: string, start: number, end: number, before: string|null, after: string|null}[]}
 */
export function splitCommands(script) {
  const segments = [];
  let quote = null;
  let depth = 0;
  let backtick = false;
  let start = 0;
  let before = null;

  const cut = (end, op, next) => {
    segments.push({ text: script.slice(start, end), start, end, before, after: op });
    before = op;
    start = next;
  };

  for (let i = 0; i < script.length; i++) {
    const ch = script[i];
    if (quote) {
      if (quote === '"' && ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '`') {
      backtick = !backtick;
      continue;
    }
    if (ch === '$' && script[i + 1] === '(') {
      depth++;
      i++;
      continue;
    }
    if (ch === ')' && depth > 0) {
      depth--;
      continue;
    }
    if (depth > 0 || backtick) continue;

    const two = script.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      cut(i, two, i + 2);
      i++;
    } else if (ch === ';' || ch === '|') {
      cut(i, ch, i + 1);
    } else if (ch === '&') {
      // 2>&1, >&2 and &> are redirections, not the background operator.
      if (script[i - 1] === '>' || script[i + 1] === '>') continue;
      cut(i, '&', i + 1);
    }
  }
  segments.push({ text: script.slice(start), start, end: script.length, before, after: null });
  return segments.filter((s) => s.text.trim() !== '');
}

/**
 * Split a single command segment into words.
 * Each word records whether it contained single/double quotes and whether it
 * has glob characters outside of quotes.
 */
export function tokenize(text) {
  const words = [];
  let word = null;
  let quote = null;

  const open = (i) => {
    if (!word) word = { raw: '', value: '', start: i, end: i, single: false, double: false, glob: false };
  };
  const close = (i) => {
    if (word) {
      word.end = i;
      words.push(word);
      word = null;
    }
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      word.raw += ch;
      if (ch === quote) {
        quote = null;
      } else if (quote === '"' && ch === '\\' && i + 1 < text.length) {
        word.raw += text[i + 1];
        word.value += text[i + 1];
        i++;
      } else {
        word.value += ch;
      }
      continue;
    }
    if (/\s/.test(ch)) {
      close(i);
      continue;
    }
    open(i);
    word.raw += ch;
    if (ch === "'") {
      quote = ch;
      word.single = true;
    } else if (ch === '"') {
      quote = ch;
      word.double = true;
    } else if (ch === '\\' && i + 1 < text.length && !/\s/.test(text[i + 1])) {
      // Keep backslashes in the value: on Windows they are path separators.
      word.value += ch;
    } else {
      if (ch === '*' || ch === '?') word.glob = true;
      word.value += ch;
    }
  }
  close(text.length);
  return words;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

export function isAssignment(word) {
  return ASSIGNMENT.test(word.raw);
}

/** Index of the first word that is not a leading VAR=value assignment. */
export function commandIndex(words) {
  let i = 0;
  while (i < words.length && isAssignment(words[i])) i++;
  return i;
}

/** Replace everything inside single quotes with spaces (positions are kept). */
export function maskSingleQuoted(text) {
  let out = '';
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") {
        quote = null;
        out += ch;
      } else out += ' ';
      continue;
    }
    if (quote === '"') {
      if (ch === '\\') {
        out += ch + (text[i + 1] ?? '');
        i++;
        continue;
      }
      if (ch === '"') quote = null;
      out += ch;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    out += ch;
  }
  return out;
}
