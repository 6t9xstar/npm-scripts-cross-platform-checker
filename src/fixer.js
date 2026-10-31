import { parseScript } from './analyzer.js';
import { UNIX_COMMANDS } from './rules.js';

/**
 * Rewrite one script into a cross-platform form. Only mechanical, low-risk
 * transformations are applied; everything else stays a manual suggestion.
 * @returns {{script: string, packages: Set<string>, changes: string[]}}
 */
export function fixScript(script) {
  const packages = new Set();
  const changes = [];
  const segments = parseScript(script);
  let out = script;

  // Work right-to-left so earlier offsets stay valid.
  for (let s = segments.length - 1; s >= 0; s--) {
    const seg = segments[s];
    let text = seg.text;
    const lead = text.match(/^\s*/)[0];
    const trail = text.match(/\s*$/)[0];
    let body = text.trim();
    const original = body;

    body = fixSingleQuotes(body, changes);
    body = fixCommand(body, packages, changes, seg);

    // `|| true` at the end of a script -> `|| exit 0`
    if (body === 'true' && seg.before === '||' && s === segments.length - 1) {
      body = 'exit 0';
      changes.push('|| true -> || exit 0');
    }

    if (body !== original) out = out.slice(0, seg.start) + lead + body + trail + out.slice(seg.end);

    // `a ; b` -> `a && b` (the separator sits right after this segment)
    if (seg.after === ';') {
      const at = out.indexOf(';', seg.start + lead.length + body.length);
      if (at !== -1) {
        const space = /\s/.test(out[at - 1] || ' ') ? '' : ' ';
        out = out.slice(0, at) + space + '&&' + out.slice(at + 1);
        changes.push('; -> &&');
      }
    }
  }
  return { script: out, packages, changes };
}

function fixSingleQuotes(body, changes) {
  const seg = parseScript(body)[0];
  if (!seg) return body;
  let result = body;
  for (let i = seg.words.length - 1; i >= 0; i--) {
    const w = seg.words[i];
    // Only safe when double quotes would not trigger expansion in sh.
    if (!w.single || w.double || /["$`\\!]/.test(w.value)) continue;
    const replaced = w.raw.replace(/'/g, '"');
    result = result.slice(0, w.start) + replaced + result.slice(w.end);
    changes.push(`${w.raw} -> ${replaced}`);
  }
  return result;
}

function fixCommand(body, packages, changes, seg) {
  const parsed = parseScript(body)[0];
  if (!parsed) return body;
  const { words, cmdIndex, cmd } = parsed;

  // NAME=value cmd -> cross-env NAME=value cmd
  if (cmdIndex > 0 && cmdIndex < words.length) {
    packages.add('cross-env');
    changes.push(`${words[0].raw} ... -> cross-env ${words[0].raw} ...`);
    return `cross-env ${body}`;
  }

  const cmdWord = words[cmdIndex];
  if (!cmdWord || cmdWord.raw.includes('\\')) return body;
  const rest = (from) => body.slice(from).trim();

  // rm -rf a b -> rimraf a b
  if (cmd === 'rm') {
    const args = words.slice(cmdIndex + 1);
    const flags = args.filter((w) => /^-[rRf]+$/.test(w.raw) || w.raw === '--');
    const paths = args.filter((w) => !flags.includes(w));
    if (paths.length === 0 || args.some((w) => w.raw.startsWith('-') && !flags.includes(w))) return body;
    const glob = paths.some((w) => w.glob || /[*?]/.test(w.value));
    const quoted = paths.map((w) => (w.glob ? `"${w.value}"` : w.raw));
    packages.add('rimraf');
    changes.push(`rm -> rimraf${glob ? ' --glob' : ''}`);
    return `rimraf${glob ? ' --glob' : ''} ${quoted.join(' ')}`;
  }

  // mkdir -p / cp / mv / cat ... -> shx <cmd>
  const shxable = (cmd === 'mkdir' && words.slice(cmdIndex + 1).some((w) => /^-\w*p/.test(w.raw))) || UNIX_COMMANDS[cmd]?.shx;
  if (shxable && seg.cmd !== 'shx') {
    packages.add('shx');
    changes.push(`${cmd} -> shx ${cmd}`);
    return `shx ${cmd} ${rest(cmdWord.end)}`.trim();
  }
  return body;
}

/**
 * Apply fixScript to every script in a package.json text, keeping formatting.
 * @returns {{text: string, diffs: {name, before, after}[], packages: Set<string>}}
 */
export function fixPackageJson(raw) {
  const pkg = JSON.parse(raw);
  const config = pkg.scriptport || {};
  const ignoreScripts = new Set(config.ignoreScripts || []);
  const packages = new Set();
  const diffs = [];
  for (const [name, script] of Object.entries(pkg.scripts || {})) {
    if (typeof script !== 'string' || ignoreScripts.has(name)) continue;
    const result = fixScript(script);
    if (result.script !== script) {
      pkg.scripts[name] = result.script;
      diffs.push({ name, before: script, after: result.script });
      result.packages.forEach((p) => packages.add(p));
    }
  }
  const declared = new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})]);
  const missing = [...packages].filter((p) => !declared.has(p));
  const indent = raw.match(/^[ \t]+(?=")/m)?.[0] || '  ';
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  let text = JSON.stringify(pkg, null, indent).replace(/\n/g, eol);
  if (/\r?\n$/.test(raw)) text += eol;
  return { text, diffs, packages: missing };
}
