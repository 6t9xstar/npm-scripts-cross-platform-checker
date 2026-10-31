# ScriptPort: cross-platform npm scripts checker

**Find `package.json` scripts that break on Windows, Linux or macOS, and fix them automatically.**

[![CI](https://github.com/6t9xstar/npm-scripts-cross-platform-checker/actions/workflows/ci.yml/badge.svg)](https://github.com/6t9xstar/npm-scripts-cross-platform-checker/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node.js](https://img.shields.io/badge/node-%3E%3D18.17-brightgreen)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)

Your `npm run build` works on your Mac but your Windows teammate gets `'NODE_ENV' is not recognized as an internal or external command`.
npm runs scripts with `/bin/sh` on macOS and Linux and with `cmd.exe` on Windows, and the two shells disagree on environment variables, quoting, globs, `rm -rf`, `;`, `&`, `$(...)` and more.

**ScriptPort** is a zero-dependency linter for npm scripts. It parses every script the way each shell would, reports what breaks on which operating system, and rewrites the common cases using `cross-env`, `rimraf` and `shx`.

```bash
npx github:6t9xstar/npm-scripts-cross-platform-checker scan
```

## Example

```text
ScriptPort Compatibility Report

Windows:  14 potential issues
Linux:    7 potential issues
macOS:    6 potential issues

Issues:
[ERROR]   "build" SP001 package.json:5 [windows]
  Environment assignment "NODE_ENV" is not portable: cmd.exe treats "NODE_ENV=production" as the command name.
  Fix: cross-env NODE_ENV=production webpack --config webpack.config.js
[ERROR]   "clean" SP004 package.json:6 [windows]
  "rm" is not a cmd.exe command.
  Fix: rimraf <paths>
[ERROR]   "copy" SP004 package.json:7 [windows]
  "mkdir -p" fails in cmd.exe: it creates a directory literally named "-p".
  Fix: shx mkdir -p ...
[WARNING] "lint" SP006 package.json:8 [windows]
  Single quotes in 'src/**/*.js' are passed literally to the program by cmd.exe.
  Fix: use escaped double quotes: \"src/**/*.js\"

Suggested fixes available: run `scriptport fix` to preview them.
```

The full example lives in [`fixtures/broken/package.json`](fixtures/broken/package.json).

## Features

- **Per-OS report**: every finding says whether it breaks Windows, Linux or macOS.
- **Real shell parsing**: a quote-aware lexer understands `&&`, `||`, `;`, `|`, `&`, redirections, `$(...)` and quoting, so `echo "a && b"` is not split.
- **Auto-fix**: `scriptport fix` rewrites scripts with `cross-env`, `rimraf` and `shx`, keeps your `package.json` formatting, and tells you which helpers to install.
- **Both directions**: POSIX-only syntax (breaks Windows) *and* `cmd.exe`-only syntax such as `del`, `set`, `%VAR%` and `.\bin\tool.bat` (breaks macOS and Linux).
- **Monorepos**: `--recursive` scans every `package.json` and skips `node_modules`.
- **CI-ready**: SARIF for GitHub code scanning, GitHub annotations, JSON, Markdown, and a ready-made GitHub Action.
- **Zero dependencies** and no build step. It runs anywhere Node.js 18.17+ runs.

## Install

ScriptPort runs straight from GitHub. You need Node.js 18.17+ and git.

```bash
# run once without installing
npx github:6t9xstar/npm-scripts-cross-platform-checker scan

# or install the scriptport command globally
npm install -g github:6t9xstar/npm-scripts-cross-platform-checker
scriptport scan

# or add it to a project
npm install --save-dev github:6t9xstar/npm-scripts-cross-platform-checker
```

## Usage

```bash
scriptport scan                      # ./package.json
scriptport scan packages/api         # a folder or a package.json path
scriptport scan --recursive          # every package.json in a monorepo
scriptport scan -p windows           # only issues that affect Windows
scriptport fix                       # preview automatic fixes
scriptport fix --write               # apply them
scriptport check "rm -rf dist && NODE_ENV=test jest"   # check one command
scriptport rules                     # list all rules
```

| Option | Description |
| --- | --- |
| `-r, --recursive` | Scan every `package.json` below the given paths |
| `-f, --format` | `text` (default), `json`, `sarif`, `markdown`, `github` |
| `-o, --output <file>` | Write the report to a file |
| `-p, --platform` | `windows`, `linux` or `macos` |
| `--fail-on <level>` | `error` (default), `warning`, `info` or `none` |
| `--ignore <ids>` | Skip rules, e.g. `--ignore SP007,SP012` |
| `--write` | With `fix`: write the changes |

Exit codes: `0` no issues at or above `--fail-on`, `1` issues found, `2` usage error.

## Automatic fixes

```text
$ scriptport fix
package.json
  build
  - NODE_ENV=production webpack --config webpack.config.js
  + cross-env NODE_ENV=production webpack --config webpack.config.js
  clean
  - rm -rf dist coverage
  + rimraf dist coverage
  copy
  - mkdir -p dist/assets && cp -r assets/* dist/assets
  + shx mkdir -p dist/assets && shx cp -r assets/* dist/assets
  lint
  - eslint 'src/**/*.js'
  + eslint "src/**/*.js"

Install the helpers: npm install --save-dev cross-env rimraf shx
Preview only. Re-run with --write to apply.
```

`fix` only applies mechanical changes that are safe to automate. Command substitution, `if`/`for` blocks and `.sh` files are reported with a suggestion instead, usually to move the logic into a small Node.js script.

## GitHub Action

```yaml
name: Cross-platform scripts
on: [pull_request]
jobs:
  scriptport:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: 6t9xstar/npm-scripts-cross-platform-checker@v1
        with:
          path: .            # package.json or folder
          recursive: false   # true for monorepos
          fail-on: error
```

Findings appear as annotations on the pull request, and a Markdown report is added to the job summary.

To upload results to GitHub code scanning instead:

```yaml
      - run: npx github:6t9xstar/npm-scripts-cross-platform-checker scan -f sarif -o scriptport.sarif --fail-on none
      - uses: github/codeql-action/upload-sarif@v4
        with:
          sarif_file: scriptport.sarif
```

## Rules

| Rule | Severity | Breaks | What it finds |
| --- | --- | --- | --- |
| SP001 | error | Windows | `NAME=value command` inline environment variables → `cross-env` |
| SP002 | warning | Windows | `$VAR` / `${VAR}` references (cmd.exe uses `%VAR%`) |
| SP003 | warning | Linux, macOS | `%VAR%` references |
| SP004 | error | Windows | Unix commands: `rm`, `cp`, `mv`, `mkdir -p`, `cat`, `ls`, `grep`, `sed`, `export`, `true`, `sleep`, ... |
| SP005 | error | Linux, macOS | cmd.exe commands: `del`, `rd`, `copy`, `xcopy`, `move`, `set X=`, `type`, `start`, ... |
| SP006 | warning | Windows | Single-quoted arguments (cmd.exe passes the quotes literally) |
| SP007 | warning | Linux, macOS | Unquoted globs (sh expands them without `**`; cmd.exe does not) |
| SP008 | error | Windows | `./script` / `../script` executables |
| SP009 | error | Linux, macOS | Backslash paths like `scripts\build.js` |
| SP010 | error | Windows | `$(...)` and backtick command substitution |
| SP011 | error | Windows | `;` used as a command separator |
| SP012 | warning | all | `&` runs in the background in sh but sequentially in cmd.exe |
| SP013 | error | all | `/dev/null` (Windows) and `NUL` (POSIX) |
| SP014 | error | Windows | `if`, `for`, `[ ]`, `test`, heredocs, `~/` |
| SP015 | warning | Windows | `bash script.sh` / `*.sh` needs Git Bash or WSL |
| SP016 | error | Linux, macOS | `.bat`, `.cmd`, `.ps1`, `powershell` |
| SP017 | error | varies | `open` (macOS only) and `xdg-open` (Linux only) → `open-cli` |
| SP018 | info | Windows | `echo "text"` prints the quotes in cmd.exe |
| SP019 | warning | all | `cross-env`, `rimraf`, `shx`, ... used but not in `devDependencies` |
| SP020 | info | Windows | `.npmrc` sets `script-shell` |

## Configuration

Add a `scriptport` field to `package.json`:

```json
{
  "scriptport": {
    "ignore": ["SP007"],
    "ignoreScripts": ["postinstall"]
  }
}
```

## Programmatic API

```js
import { analyzeScript, fixScript } from 'scriptport';

analyzeScript('NODE_ENV=production webpack');
// [{ ruleId: 'SP001', severity: 'error', platforms: ['windows'], message: '...', fix: 'cross-env NODE_ENV=production webpack' }]

fixScript('rm -rf dist').script; // 'rimraf dist'
```

## FAQ

### Why do npm scripts fail on Windows?

npm executes scripts through `cmd.exe` on Windows (unless `script-shell` is configured). `cmd.exe` doesn't support `VAR=value` prefixes, `rm`, `cp`, single quotes, `$VAR`, `$(...)` or `;`. Scripts written on macOS or Linux often rely on all of these.

### How do I set NODE_ENV in an npm script on Windows?

Use [`cross-env`](https://www.npmjs.com/package/cross-env): `"build": "cross-env NODE_ENV=production webpack"`. `scriptport fix` does this rewrite for you.

### How do I delete a folder in an npm script on every OS?

Use [`rimraf`](https://www.npmjs.com/package/rimraf) (`rimraf dist`), or `node -e "require('fs').rmSync('dist', { recursive: true, force: true })"`.

### Is this a replacement for cross-env?

No. `cross-env`, `rimraf` and `shx` make a script portable. ScriptPort finds the scripts that need them and adds them for you.

### Can I just set `script-shell` to Git Bash?

You can, but every contributor and CI runner then needs bash at the exact same path. ScriptPort reports this as info (SP020) and still checks your scripts.

## More developer tools

- [ScriptPort](https://github.com/6t9xstar/npm-scripts-cross-platform-checker): cross-platform npm scripts checker
- [ComposeDoctor](https://github.com/6t9xstar/docker-compose-doctor): Docker Compose validator and troubleshooter
- [CachePilot](https://github.com/6t9xstar/github-actions-cache-optimizer): GitHub Actions cache analyzer and optimizer
- [DevContainer Doctor](https://github.com/6t9xstar/devcontainer-json-validator): devcontainer.json validator
- [OwnerScope](https://github.com/6t9xstar/codeowners-coverage-checker): CODEOWNERS validator and coverage checker

## License

[MIT](LICENSE)
