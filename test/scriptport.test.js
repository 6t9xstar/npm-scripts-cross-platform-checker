import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { splitCommands, tokenize } from '../src/shell.js';
import { analyzeScript, analyzePackage, scriptLine } from '../src/analyzer.js';
import { fixScript, fixPackageJson } from '../src/fixer.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'bin', 'scriptport.js');
const ids = (script) => analyzeScript(script).map((f) => f.ruleId).sort();

test('splitCommands respects quotes, substitutions and redirects', () => {
  assert.deepEqual(
    splitCommands('a && b || c; d | e & f').map((s) => s.text.trim()),
    ['a', 'b', 'c', 'd', 'e', 'f'],
  );
  assert.equal(splitCommands('echo "a && b"').length, 1);
  assert.equal(splitCommands("echo 'x; y'").length, 1);
  assert.equal(splitCommands('echo $(a && b)').length, 1);
  assert.equal(splitCommands('node x 2>&1').length, 1);
  assert.equal(splitCommands('node x &> log').length, 1);
});

test('tokenize tracks quoting and globs', () => {
  const [a, b, c] = tokenize(`eslint 'src/**' "lib/*"`).slice(0, 3);
  assert.equal(a.value, 'eslint');
  assert.equal(b.single, true);
  assert.equal(b.glob, false);
  assert.equal(c.double, true);
  assert.equal(tokenize('rm dist/*')[1].glob, true);
});

test('clean, portable scripts produce no findings', () => {
  for (const script of [
    'cross-env NODE_ENV=production webpack',
    'rimraf dist',
    'eslint "src/**/*.js"',
    'npm run build && npm test',
    'node scripts/build.mjs --out dist',
    'tsc -p tsconfig.json',
    'shx cp -r assets dist',
    'concurrently "npm:watch" "npm:serve"',
    'node -e "console.log(1)"',
    'vitest run --coverage',
  ]) {
    assert.deepEqual(ids(script), [], script);
  }
});

test('detects POSIX-only constructs that fail on Windows', () => {
  assert.deepEqual(ids('NODE_ENV=production webpack'), ['SP001']);
  assert.deepEqual(ids('rm -rf dist'), ['SP004']);
  assert.deepEqual(ids('mkdir -p dist'), ['SP004']);
  assert.deepEqual(ids("eslint 'src/**/*.js'"), ['SP006']);
  assert.deepEqual(ids('./scripts/run.js'), ['SP008']);
  assert.deepEqual(ids('echo $(date)'), ['SP010']);
  assert.ok(ids('a; b').includes('SP011'));
  assert.ok(ids('a & b').includes('SP012'));
  assert.ok(ids('node x > /dev/null').includes('SP013'));
  assert.ok(ids('if [ -f x ]; then echo y; fi').includes('SP014'));
  assert.ok(ids('bash scripts/setup.sh').includes('SP015'));
  assert.ok(ids('jest || true').includes('SP004'));
  assert.ok(ids('echo $HOME').includes('SP002'));
  assert.deepEqual(ids("echo '$HOME'").filter((id) => id === 'SP002'), []);
});

test('detects Windows-only constructs that fail on Linux and macOS', () => {
  assert.deepEqual(ids('del /q dist'), ['SP005']);
  assert.deepEqual(ids('rmdir /s /q dist'), ['SP005']);
  assert.ok(ids('set NODE_ENV=production&& node app').includes('SP005'));
  assert.ok(ids('node scripts\\build.js').includes('SP009'));
  assert.ok(ids('.\\tools\\build.bat').includes('SP016'));
  assert.ok(ids('echo %PATH%').includes('SP003'));
  assert.ok(ids('node x > nul').includes('SP013'));
});

test('open and xdg-open are flagged for the other platforms', () => {
  const [f] = analyzeScript('open http://localhost:3000');
  assert.equal(f.ruleId, 'SP017');
  assert.deepEqual(f.platforms, ['windows', 'linux']);
});

test('fixScript rewrites common patterns', () => {
  assert.equal(fixScript('NODE_ENV=production webpack').script, 'cross-env NODE_ENV=production webpack');
  assert.equal(fixScript('rm -rf dist coverage').script, 'rimraf dist coverage');
  assert.equal(fixScript('rm -rf dist/*.map').script, 'rimraf --glob "dist/*.map"');
  assert.equal(fixScript('mkdir -p a && cp x a').script, 'shx mkdir -p a && shx cp x a');
  assert.equal(fixScript("eslint 'src/**/*.js'").script, 'eslint "src/**/*.js"');
  assert.equal(fixScript('jest || true').script, 'jest || exit 0');
  assert.equal(fixScript('a; b').script, 'a && b');
  assert.equal(fixScript('tsc && node dist/index.js').script, 'tsc && node dist/index.js');
  // `'$HOME'` must not become `"$HOME"` (that would expand on POSIX).
  assert.equal(fixScript("echo '$HOME'").script, "echo '$HOME'");
  const { packages } = fixScript('NODE_ENV=x rm -rf a');
  assert.deepEqual([...packages], ['cross-env']);
});

test('fixed scripts are clean for the rules the fixer handles', () => {
  const fixed = fixScript('NODE_ENV=production webpack && rm -rf dist && mkdir -p out').script;
  assert.deepEqual(ids(fixed), []);
});

test('fixPackageJson keeps indentation and reports missing helpers', () => {
  const raw = '{\n    "scripts": {\n        "clean": "rm -rf dist"\n    },\n    "devDependencies": { "rimraf": "^6.0.0" }\n}\n';
  const { text, diffs, packages } = fixPackageJson(raw);
  assert.match(text, /^\{\n {4}"scripts"/);
  assert.ok(text.endsWith('\n'));
  assert.equal(JSON.parse(text).scripts.clean, 'rimraf dist');
  assert.equal(diffs.length, 1);
  assert.deepEqual(packages, []);
});

test('scriptLine finds the line of a script key', () => {
  const raw = '{\n  "name": "x",\n  "scripts": {\n    "build": "a",\n    "test": "b"\n  }\n}';
  assert.equal(scriptLine(raw, 'build'), 4);
  assert.equal(scriptLine(raw, 'test'), 5);
});

test('analyzePackage honours config, ignore lists and missing helpers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptport-'));
  const file = path.join(dir, 'package.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      scripts: { a: 'cross-env A=1 node x', b: 'rm -rf dist', c: './x.sh' },
      scriptport: { ignore: ['SP004'], ignoreScripts: ['c'] },
    }),
  );
  const { findings } = analyzePackage(file, { cwd: dir });
  assert.deepEqual(findings.map((f) => f.ruleId), ['SP019']);
  fs.writeFileSync(path.join(dir, '.npmrc'), 'script-shell=C:\\Program Files\\Git\\bin\\bash.exe\n');
  assert.ok(analyzePackage(file, { cwd: dir }).findings.some((f) => f.ruleId === 'SP020'));
});

function run(args, opts = {}) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd: root, env: { ...process.env, NO_COLOR: '1' }, ...opts });
}

test('CLI: exit codes and formats', () => {
  const broken = run(['scan', 'fixtures/broken']);
  assert.equal(broken.status, 1);
  assert.match(broken.stdout, /ScriptPort Compatibility Report/);
  assert.match(broken.stdout, /Windows: +\d+ potential issues/);

  assert.equal(run(['scan', 'fixtures/clean']).status, 0);
  assert.equal(run(['scan', 'fixtures/broken', '--fail-on', 'none']).status, 0);

  const json = JSON.parse(run(['scan', 'fixtures/broken', '-f', 'json']).stdout);
  assert.ok(json.summary.error > 0);
  assert.ok(json.platforms.windows > 0);

  const sarif = JSON.parse(run(['scan', 'fixtures/broken', '-f', 'sarif']).stdout);
  assert.equal(sarif.version, '2.1.0');
  assert.ok(sarif.runs[0].results.length > 0);

  assert.match(run(['scan', 'fixtures/broken', '-f', 'github']).stdout, /^::error file=fixtures\/broken\/package.json,line=\d+/m);
  assert.match(run(['scan', 'fixtures/broken', '-f', 'markdown']).stdout, /\| Windows \| \d+ \|/);
  assert.equal(run(['scan', 'does-not-exist']).status, 2);
  assert.equal(run(['--format', 'xml']).status, 2);
  assert.equal(run(['check', 'rm -rf x']).status, 1);
  assert.equal(run(['--version']).stdout.trim(), JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version);
});

test('CLI: --platform filters findings', () => {
  const linux = JSON.parse(run(['scan', 'fixtures/broken', '-f', 'json', '-p', 'linux']).stdout);
  assert.ok(linux.findings.every((f) => f.platforms.includes('linux')));
});

test('CLI: recursive scan and fix --write', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptport-'));
  fs.mkdirSync(path.join(dir, 'packages', 'a'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { ok: 'node x' } }));
  fs.writeFileSync(path.join(dir, 'packages', 'a', 'package.json'), JSON.stringify({ scripts: { clean: 'rm -rf dist' } }, null, 2));
  fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'package.json'), JSON.stringify({ scripts: { bad: 'rm -rf /' } }));

  const scan = run(['scan', '-r', dir, '-f', 'json']);
  const files = JSON.parse(scan.stdout).files;
  assert.equal(files.length, 2);

  const fix = run(['fix', '-r', dir, '--write']);
  assert.equal(fix.status, 0);
  assert.match(fix.stdout, /npm install --save-dev rimraf/);
  const fixed = JSON.parse(fs.readFileSync(path.join(dir, 'packages', 'a', 'package.json'), 'utf8'));
  assert.equal(fixed.scripts.clean, 'rimraf dist');
});
