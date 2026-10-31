import fs from 'node:fs';
import path from 'node:path';
import { splitCommands, tokenize, commandIndex } from './shell.js';
import { RULES, HELPER_BINARIES, commandBase } from './rules.js';

/** Parse a script into segments enriched with words and the command name. */
export function parseScript(script) {
  return splitCommands(script).map((segment) => {
    const words = tokenize(segment.text);
    const cmdIndex = commandIndex(words);
    const cmdWord = words[cmdIndex];
    return {
      ...segment,
      words,
      cmdIndex,
      cmdWord,
      cmd: cmdWord ? commandBase(cmdWord.value) : '',
      args: words.slice(cmdIndex + 1),
    };
  });
}

/**
 * Analyze one script string.
 * @returns {{ruleId, severity, platforms, message, fix?, packages?, autofix?}[]}
 */
export function analyzeScript(script, { ignore = new Set() } = {}) {
  const findings = [];
  for (const seg of parseScript(script)) {
    for (const [ruleId, rule] of Object.entries(RULES)) {
      if (ignore.has(ruleId)) continue;
      for (const hit of rule.check(seg)) {
        findings.push({
          ruleId,
          severity: hit.severity || rule.severity,
          platforms: hit.platforms || rule.platforms,
          message: hit.message,
          fix: hit.fix,
          packages: hit.packages || [],
          autofix: Boolean(hit.autofix),
        });
      }
    }
  }
  return dedupe(findings);
}

function dedupe(findings) {
  const seen = new Set();
  return findings.filter((f) => {
    const key = `${f.ruleId}|${f.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Binaries from HELPER_BINARIES that a script invokes. */
export function helpersUsed(script) {
  const used = new Set();
  for (const seg of parseScript(script)) {
    let name = seg.cmd;
    if ((name === 'npx' || name === 'pnpx') && seg.args.length) {
      continue; // npx downloads the package on demand
    }
    if (HELPER_BINARIES[name]) used.add(name);
  }
  return used;
}

/** Find the 1-based line of a script key inside the raw package.json text. */
export function scriptLine(raw, name) {
  const scriptsAt = raw.search(/"scripts"\s*:/);
  if (scriptsAt === -1) return 1;
  const key = JSON.stringify(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${key}\\s*:`, 'g');
  re.lastIndex = scriptsAt;
  const m = re.exec(raw);
  const at = m ? m.index : scriptsAt;
  return raw.slice(0, at).split('\n').length;
}

function readNpmrcShell(dir) {
  const file = path.join(dir, '.npmrc');
  if (!fs.existsSync(file)) return null;
  const m = fs.readFileSync(file, 'utf8').match(/^\s*script-shell\s*=\s*(.+?)\s*$/m);
  return m ? { file, shell: m[1], line: fs.readFileSync(file, 'utf8').slice(0, m.index).split('\n').length } : null;
}

/**
 * Analyze a package.json file.
 * @param {string} file absolute or relative path to package.json
 * @param {{cwd?: string, ignore?: string[]}} options
 */
export function analyzePackage(file, options = {}) {
  const cwd = options.cwd || process.cwd();
  const rel = path.relative(cwd, file).split(path.sep).join('/') || 'package.json';
  const raw = fs.readFileSync(file, 'utf8');
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch (err) {
    return {
      file: rel,
      scripts: {},
      findings: [{ ruleId: 'SP000', severity: 'error', platforms: [], file: rel, line: 1, message: `package.json is not valid JSON: ${err.message}` }],
    };
  }

  const config = pkg.scriptport || {};
  const ignore = new Set([...(options.ignore || []), ...(config.ignore || [])].map((s) => s.toUpperCase()));
  const ignoreScripts = new Set(config.ignoreScripts || []);
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const declared = new Set([
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
    ...Object.keys(pkg.optionalDependencies || {}),
  ]);

  const findings = [];
  for (const [name, script] of Object.entries(scripts)) {
    if (typeof script !== 'string' || ignoreScripts.has(name)) continue;
    const line = scriptLine(raw, name);
    for (const f of analyzeScript(script, { ignore })) {
      findings.push({ ...f, file: rel, line, context: `script "${name}"`, script: name });
    }
    if (!ignore.has('SP019')) {
      for (const bin of helpersUsed(script)) {
        const candidates = HELPER_BINARIES[bin];
        if (!candidates.some((p) => declared.has(p)) && pkg.name !== candidates[0]) {
          findings.push({
            ruleId: 'SP019',
            severity: RULES.SP019.severity,
            platforms: RULES.SP019.platforms,
            file: rel,
            line,
            context: `script "${name}"`,
            script: name,
            message: `"${bin}" is used but "${candidates[0]}" is not in dependencies or devDependencies; it only works if installed globally.`,
            fix: `npm install --save-dev ${candidates[0]}`,
            packages: [candidates[0]],
          });
        }
      }
    }
  }

  const npmrc = ignore.has('SP020') ? null : readNpmrcShell(path.dirname(file));
  if (npmrc) {
    findings.push({
      ruleId: 'SP020',
      severity: RULES.SP020.severity,
      platforms: RULES.SP020.platforms,
      file: path.relative(cwd, npmrc.file).split(path.sep).join('/'),
      line: npmrc.line,
      context: '.npmrc',
      message: `script-shell is set to "${npmrc.shell}". Scripts will only run where that shell is installed at that path.`,
      fix: 'prefer cross-platform scripts over a custom script-shell',
    });
  }

  return { file: rel, name: pkg.name, scripts, raw, findings };
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.turbo', 'vendor']);

/** Find package.json files: either the given paths, or recursively below them. */
export function findPackageFiles(inputs, { recursive = false, cwd = process.cwd() } = {}) {
  const files = [];
  for (const input of inputs.length ? inputs : ['.']) {
    const abs = path.resolve(cwd, input);
    if (!fs.existsSync(abs)) throw new Error(`Path not found: ${input}`);
    const stat = fs.statSync(abs);
    if (stat.isFile()) {
      files.push(abs);
      continue;
    }
    if (!recursive) {
      const pj = path.join(abs, 'package.json');
      if (!fs.existsSync(pj)) throw new Error(`No package.json found in ${input}`);
      files.push(pj);
      continue;
    }
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) walk(path.join(dir, entry.name));
        } else if (entry.name === 'package.json') {
          files.push(path.join(dir, entry.name));
        }
      }
    };
    walk(abs);
  }
  return [...new Set(files)];
}
