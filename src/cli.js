import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { analyzePackage, analyzeScript, findPackageFiles } from './analyzer.js';
import { fixPackageJson } from './fixer.js';
import { RULES } from './rules.js';
import * as R from './reporters.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');
const TOOL = { name: 'ScriptPort', version: pkg.version, uri: 'https://github.com/6t9xstar/npm-scripts-cross-platform-checker' };
const PLATFORMS = ['windows', 'linux', 'macos'];

const HELP = `ScriptPort ${pkg.version} - cross-platform npm scripts checker

Usage
  scriptport scan [paths...]      Check package.json scripts (default command)
  scriptport fix [paths...]       Preview automatic fixes (add --write to apply)
  scriptport check "<script>"     Check a single script string
  scriptport rules                List all rules

Options
  -r, --recursive         Scan every package.json below the given paths (monorepos)
  -f, --format <fmt>      text | json | sarif | markdown | github   (default: text)
  -o, --output <file>     Write the report to a file instead of stdout
  -p, --platform <os>     Only report issues for windows | linux | macos
      --fail-on <level>   error | warning | info | none            (default: error)
      --ignore <ids>      Comma-separated rule ids to skip, e.g. SP007,SP012
      --write             (fix) write the fixed package.json files
      --no-color          Disable colors
  -h, --help              Show help
  -v, --version           Show version

Exit codes: 0 = ok, 1 = issues at or above --fail-on, 2 = usage error

Docs: ${TOOL.uri}`;

export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        recursive: { type: 'boolean', short: 'r' },
        format: { type: 'string', short: 'f', default: 'text' },
        output: { type: 'string', short: 'o' },
        platform: { type: 'string', short: 'p' },
        'fail-on': { type: 'string', default: 'error' },
        ignore: { type: 'string', default: '' },
        write: { type: 'boolean' },
        color: { type: 'boolean' },
        'no-color': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (err) {
    console.error(`scriptport: ${err.message}\n\n${HELP}`);
    return 2;
  }
  const { values: opts, positionals } = parsed;
  if (opts.version) return print(pkg.version), 0;
  if (opts.help) return print(HELP), 0;

  const commands = ['scan', 'fix', 'check', 'rules'];
  const command = commands.includes(positionals[0]) ? positionals.shift() : 'scan';
  if (!R.FORMATS.includes(opts.format)) return usage(`Unknown format "${opts.format}"`);
  if (!['error', 'warning', 'info', 'none'].includes(opts['fail-on'])) return usage(`Unknown --fail-on level "${opts['fail-on']}"`);
  if (opts.platform && !PLATFORMS.includes(opts.platform)) return usage(`Unknown platform "${opts.platform}"`);
  const c = R.colors(R.shouldUseColor(opts['no-color'] ? false : opts.color));
  const ignore = opts.ignore.split(',').map((s) => s.trim()).filter(Boolean);

  try {
    if (command === 'rules') return listRules(c), 0;
    if (command === 'fix') return runFix(positionals, opts, c);

    let findings;
    let files;
    if (command === 'check') {
      if (!positionals.length) return usage('check needs a script string, e.g. scriptport check "rm -rf dist"');
      files = ['<input>'];
      findings = analyzeScript(positionals.join(' '), { ignore: new Set(ignore.map((s) => s.toUpperCase())) }).map((f) => ({ ...f, file: '<input>', line: 1 }));
    } else {
      const paths = findPackageFiles(positionals, { recursive: opts.recursive });
      files = paths.map((p) => path.relative(process.cwd(), p) || 'package.json');
      findings = paths.flatMap((p) => analyzePackage(p, { ignore }).findings);
    }
    if (opts.platform) findings = findings.filter((f) => f.platforms.length === 0 || f.platforms.includes(opts.platform));

    const output = render(findings, files, opts.format, c);
    if (opts.output) fs.writeFileSync(opts.output, output + '\n');
    else print(output);

    return findings.some((f) => opts['fail-on'] !== 'none' && R.atLeast(f.severity, opts['fail-on'])) ? 1 : 0;
  } catch (err) {
    console.error(`scriptport: ${err.message}`);
    return 2;
  }
}

function render(findings, files, format, c) {
  switch (format) {
    case 'json':
      return R.renderJson(findings, { tool: TOOL, extra: { platforms: platformCounts(findings), files } });
    case 'sarif':
      return R.renderSarif(findings, { tool: TOOL, rules: RULES });
    case 'markdown':
      return R.renderMarkdown(findings, { tool: TOOL, title: 'ScriptPort Compatibility Report' }) + '\n\n' + platformTable(findings);
    case 'github':
      return R.renderGithub(findings) || '::notice title=ScriptPort::No cross-platform issues found';
    default:
      return renderText(findings, files, c);
  }
}

function platformCounts(findings) {
  const counts = { windows: 0, linux: 0, macos: 0 };
  for (const f of findings) for (const p of f.platforms) counts[p]++;
  return counts;
}

function platformTable(findings) {
  const counts = platformCounts(findings);
  return ['| Platform | Potential issues |', '| --- | --- |', `| Windows | ${counts.windows} |`, `| Linux | ${counts.linux} |`, `| macOS | ${counts.macos} |`].join('\n');
}

function renderText(findings, files, c) {
  const counts = platformCounts(findings);
  const fmt = (n) => (n === 0 ? c.green('0 issues') : c.yellow(`${n} potential issue${n === 1 ? '' : 's'}`));
  const lines = [c.bold('ScriptPort Compatibility Report'), ''];
  lines.push(`Windows:  ${fmt(counts.windows)}`, `Linux:    ${fmt(counts.linux)}`, `macOS:    ${fmt(counts.macos)}`, '');
  if (findings.length === 0) {
    lines.push(c.green(`✔ All scripts in ${files.length} file${files.length === 1 ? '' : 's'} look cross-platform.`));
    return lines.join('\n');
  }
  lines.push('Issues:');
  let lastFile = null;
  for (const f of R.sortFindings(findings)) {
    if (f.file !== lastFile && files.length > 1) lines.push('', c.bold(f.file));
    lastFile = f.file;
    const where = f.context ? `${f.context.replace(/^script /, '')}` : '';
    lines.push(`${R.severityLabel(f.severity, c)} ${c.bold(where)} ${c.gray(`${f.ruleId} ${f.file}:${f.line} [${f.platforms.join(', ')}]`)}`);
    lines.push(`  ${f.message}`);
    if (f.fix) lines.push(`  ${c.cyan('Fix:')} ${f.fix}`);
  }
  const s = R.countBySeverity(findings);
  lines.push('', `${s.error} errors, ${s.warning} warnings, ${s.info} info.`);
  if (findings.some((f) => f.autofix || ['SP001', 'SP004'].includes(f.ruleId))) lines.push(c.cyan('Suggested fixes available: run `scriptport fix` to preview them.'));
  return lines.join('\n');
}

function runFix(positionals, opts, c) {
  const paths = findPackageFiles(positionals, { recursive: opts.recursive });
  let changed = 0;
  const needed = new Set();
  for (const file of paths) {
    const raw = fs.readFileSync(file, 'utf8');
    const { text, diffs, packages } = fixPackageJson(raw);
    if (!diffs.length) continue;
    changed++;
    print(c.bold(path.relative(process.cwd(), file).split(path.sep).join('/') || 'package.json'));
    for (const d of diffs) {
      print(`  ${d.name}`);
      print(c.red(`  - ${d.before}`));
      print(c.green(`  + ${d.after}`));
    }
    packages.forEach((p) => needed.add(p));
    if (opts.write) fs.writeFileSync(file, text);
    print('');
  }
  if (!changed) {
    print(c.green('Nothing to fix automatically.') + ' Run `scriptport scan` for issues that need a manual change.');
    return 0;
  }
  if (needed.size) print(`Install the helpers: ${c.cyan(`npm install --save-dev ${[...needed].sort().join(' ')}`)}`);
  print(opts.write ? c.green(`Updated ${changed} package.json file(s).`) : c.yellow('Preview only. Re-run with --write to apply.'));
  return 0;
}

function listRules(c) {
  for (const [id, rule] of Object.entries(RULES)) {
    print(`${c.bold(id)} ${rule.name} ${c.gray(`(${rule.severity}; ${rule.platforms.join(', ')})`)}\n    ${rule.description}`);
  }
}

function usage(message) {
  console.error(`scriptport: ${message}\nRun "scriptport --help" for usage.`);
  return 2;
}

function print(s) {
  process.stdout.write(s + '\n');
}
