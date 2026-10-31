import { maskSingleQuoted } from './shell.js';

// Commands that exist in /bin/sh environments but not in cmd.exe.
// `shx` = can be fixed by prefixing with shx (https://github.com/shelljs/shx).
export const UNIX_COMMANDS = {
  rm: { fix: 'rimraf <paths>', pkg: 'rimraf' },
  cp: { fix: 'shx cp ...', pkg: 'shx', shx: true },
  mv: { fix: 'shx mv ...', pkg: 'shx', shx: true },
  cat: { fix: 'shx cat ...', pkg: 'shx', shx: true },
  ls: { fix: 'shx ls ...', pkg: 'shx', shx: true },
  touch: { fix: 'shx touch ...', pkg: 'shx', shx: true },
  chmod: { fix: 'shx chmod ... (a no-op on Windows)', pkg: 'shx', shx: true },
  grep: { fix: 'shx grep ...', pkg: 'shx', shx: true },
  sed: { fix: 'shx sed ...', pkg: 'shx', shx: true },
  head: { fix: 'shx head ...', pkg: 'shx', shx: true },
  tail: { fix: 'shx tail ...', pkg: 'shx', shx: true },
  which: { fix: 'shx which ...', pkg: 'shx', shx: true },
  pwd: { fix: 'shx pwd', pkg: 'shx', shx: true },
  ln: { fix: 'shx ln -s ... (or a Node.js script using fs.symlinkSync)', pkg: 'shx', shx: true },
  uniq: { fix: 'shx uniq ...', pkg: 'shx', shx: true },
  export: { fix: 'cross-env NAME=value <command>', pkg: 'cross-env' },
  unset: { fix: 'remove it, or move the logic into a Node.js script' },
  true: { fix: '`exit 0` (works in sh and cmd.exe)' },
  false: { fix: '`exit 1` (works in sh and cmd.exe)' },
  sleep: { fix: 'node -e "setTimeout(() => {}, 1000)"' },
  awk: { fix: 'move the text processing into a Node.js script' },
  xargs: { fix: 'move the logic into a Node.js script' },
  tee: { fix: 'move the logic into a Node.js script' },
  wc: { fix: 'move the logic into a Node.js script' },
  cut: { fix: 'move the logic into a Node.js script' },
  tr: { fix: 'move the logic into a Node.js script' },
  uname: { fix: 'node -p "process.platform"' },
  env: { fix: 'cross-env NAME=value <command>', pkg: 'cross-env' },
  kill: { fix: 'use the tree-kill or fkill-cli package' },
  pkill: { fix: 'use the fkill-cli package' },
  killall: { fix: 'use the fkill-cli package' },
  dirname: { fix: 'node -p "require(\'path\').dirname(...)"' },
  basename: { fix: 'node -p "require(\'path\').basename(...)"' },
  realpath: { fix: 'node -p "require(\'fs\').realpathSync(...)"' },
  'xdg-open': { fix: 'open-cli <url>', pkg: 'open-cli' },
  open: { fix: 'open-cli <url>', pkg: 'open-cli', macOnly: true },
};

// Commands that exist in cmd.exe but not (or with different meaning) on POSIX.
export const WINDOWS_COMMANDS = {
  del: 'rimraf <paths>',
  erase: 'rimraf <paths>',
  rd: 'rimraf <dir>',
  copy: 'shx cp ... or cpy-cli',
  xcopy: 'shx cp -r ... or cpy-cli',
  robocopy: 'shx cp -r ... or cpy-cli',
  move: 'shx mv ...',
  ren: 'shx mv ...',
  type: 'shx cat ...',
  dir: 'shx ls ...',
  cls: 'remove it',
  findstr: 'shx grep ...',
  where: 'shx which ...',
  start: 'open-cli <url> for URLs, or concurrently / npm-run-all for parallel tasks',
  call: 'call the command directly',
  timeout: 'node -e "setTimeout(() => {}, 1000)"',
  mklink: 'shx ln -s ...',
  attrib: 'a Node.js script using fs.chmodSync',
  setx: 'cross-env NAME=value <command>',
  icacls: 'a Node.js script using fs.chmodSync',
  cmd: 'run the command directly',
};

const POSIX_KEYWORDS = new Set(['if', 'then', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', '[', '[[', 'test', 'source', '.', 'function']);
const SH_INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);

const PLATFORMS_WIN = ['windows'];
const PLATFORMS_POSIX = ['linux', 'macos'];
const PLATFORMS_ALL = ['windows', 'linux', 'macos'];

function base(cmd) {
  return cmd.replace(/^.*[\\/]/, '').toLowerCase();
}

export const RULES = {
  SP001: {
    name: 'inline-env-assignment',
    severity: 'error',
    platforms: PLATFORMS_WIN,
    description: 'Inline environment variable assignment (NAME=value command) is not supported by cmd.exe.',
    check(seg) {
      const assigns = seg.words.slice(0, seg.cmdIndex).map((w) => w.raw.split('=')[0]);
      if (assigns.length === 0) return [];
      return [
        {
          message: `Environment assignment "${assigns.join(', ')}" is not portable: cmd.exe treats "${seg.words[0].raw}" as the command name.`,
          fix: `cross-env ${seg.text.trim()}`,
          packages: ['cross-env'],
        },
      ];
    },
  },
  SP002: {
    name: 'posix-env-reference',
    severity: 'warning',
    platforms: PLATFORMS_WIN,
    description: '$VAR / ${VAR} references are not expanded by cmd.exe.',
    check(seg) {
      if (seg.cmd === 'cross-env-shell') return [];
      const masked = maskSingleQuoted(seg.text);
      const names = new Set();
      for (const m of masked.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)) names.add(m[1]);
      if (names.size === 0) return [];
      const list = [...names].map((n) => `$${n}`).join(', ');
      return [
        {
          message: `${list} is expanded by sh but passed literally by cmd.exe.`,
          fix: `cross-env-shell "${seg.text.trim().replace(/"/g, '\\"')}" or read process.env in a Node.js script`,
          packages: ['cross-env'],
        },
      ];
    },
  },
  SP003: {
    name: 'windows-env-reference',
    severity: 'warning',
    platforms: PLATFORMS_POSIX,
    description: '%VAR% references only work in cmd.exe.',
    check(seg) {
      const m = seg.text.match(/%([A-Za-z_][A-Za-z0-9_]*)%/);
      if (!m) return [];
      return [{ message: `%${m[1]}% is only expanded by cmd.exe; sh passes it literally.`, fix: 'use cross-env-shell with $VAR, or read process.env in a Node.js script', packages: ['cross-env'] }];
    },
  },
  SP004: {
    name: 'unix-only-command',
    severity: 'error',
    platforms: PLATFORMS_WIN,
    description: 'The command is not available in cmd.exe.',
    check(seg) {
      if (seg.cmd === 'mkdir' && seg.args.some((a) => /^-\w*p/.test(a.raw))) {
        return [{ message: '"mkdir -p" fails in cmd.exe: it creates a directory literally named "-p".', fix: 'shx mkdir -p ...', packages: ['shx'] }];
      }
      const info = UNIX_COMMANDS[seg.cmd];
      if (!info || seg.cmdWord?.raw.includes('\\')) return [];
      if (seg.cmd === 'open' || seg.cmd === 'xdg-open') return []; // handled by SP017
      return [{ message: `"${seg.cmd}" is not a cmd.exe command.`, fix: info.fix, packages: info.pkg ? [info.pkg] : [] }];
    },
  },
  SP005: {
    name: 'windows-only-command',
    severity: 'error',
    platforms: PLATFORMS_POSIX,
    description: 'The command only exists in cmd.exe.',
    check(seg) {
      let fix = WINDOWS_COMMANDS[seg.cmd];
      if (seg.cmd === 'set' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(seg.args[0]?.raw || '')) fix = 'cross-env NAME=value <command>';
      if (seg.cmd === 'rmdir' && seg.args.some((a) => /^\/[sq]$/i.test(a.raw))) fix = 'rimraf <dir>';
      if (!fix) return [];
      return [{ message: `"${seg.cmd}" only exists in cmd.exe; it fails under /bin/sh on Linux and macOS.`, fix }];
    },
  },
  SP006: {
    name: 'single-quoted-argument',
    severity: 'warning',
    platforms: PLATFORMS_WIN,
    description: 'cmd.exe does not treat single quotes as quoting characters.',
    check(seg) {
      const quoted = seg.words.filter((w) => w.single);
      if (quoted.length === 0) return [];
      return [
        {
          message: `Single quotes in ${quoted.map((w) => w.raw).join(' ')} are passed literally to the program by cmd.exe.`,
          fix: `use escaped double quotes: ${quoted.map((w) => w.raw.replace(/'/g, '\\"')).join(' ')}`,
          autofix: true,
        },
      ];
    },
  },
  SP007: {
    name: 'unquoted-glob',
    severity: 'warning',
    platforms: PLATFORMS_POSIX,
    description: 'Unquoted globs are expanded by sh (without ** support) but passed literally by cmd.exe.',
    check(seg) {
      if (seg.cmdIndex >= seg.words.length) return [];
      const globs = seg.args.filter((w) => w.glob);
      if (globs.length === 0) return [];
      return [
        {
          message: `Unquoted glob ${globs.map((w) => w.raw).join(' ')}: sh expands it itself (and treats ** like *), cmd.exe passes it unchanged, so the tool sees different files per OS.`,
          fix: `quote it so the tool expands it consistently: ${globs.map((w) => `\\"${w.value}\\"`).join(' ')}`,
        },
      ];
    },
  },
  SP008: {
    name: 'relative-executable-path',
    severity: 'error',
    platforms: PLATFORMS_WIN,
    description: 'Running ./script or ../script directly does not work in cmd.exe.',
    check(seg) {
      const raw = seg.cmdWord?.raw;
      if (!raw || !/^\.\.?\//.test(raw)) return [];
      const fix = /\.(c|m)?js$/.test(raw) ? `node ${raw} ...` : /\.sh$/.test(raw) ? 'rewrite the shell script as a Node.js script' : `node ${raw} ... or reference the binary by name`;
      return [{ message: `cmd.exe cannot execute "${raw}" (it reads "." as the command name).`, fix }];
    },
  },
  SP009: {
    name: 'backslash-path',
    severity: 'error',
    platforms: PLATFORMS_POSIX,
    description: 'Backslash path separators break on Linux and macOS.',
    check(seg) {
      // Quoted strings may legitimately contain escapes like "\n"; unquoted
      // words with a backslash between path characters are Windows paths.
      const bad = seg.words.filter((w) => !w.single && !w.double && /[\w.~-]\\[\w.-]/.test(w.raw));
      if (bad.length === 0) return [];
      return [{ message: `Backslash path ${bad.map((w) => w.raw).join(' ')} is an escape character in sh.`, fix: `use forward slashes: ${bad.map((w) => w.raw.replace(/\\/g, '/')).join(' ')} (they also work on Windows)` }];
    },
  },
  SP010: {
    name: 'command-substitution',
    severity: 'error',
    platforms: PLATFORMS_WIN,
    description: '$(...) and `...` command substitution are not supported by cmd.exe.',
    check(seg) {
      const masked = maskSingleQuoted(seg.text);
      if (!/\$\(|`/.test(masked)) return [];
      return [{ message: 'Command substitution is not supported by cmd.exe.', fix: 'move the logic into a Node.js script' }];
    },
  },
  SP011: {
    name: 'semicolon-separator',
    severity: 'error',
    platforms: PLATFORMS_WIN,
    description: '";" is not a command separator in cmd.exe.',
    check(seg) {
      if (seg.after !== ';') return [];
      return [{ message: '";" does not separate commands in cmd.exe; the rest of the line becomes arguments.', fix: 'use && to run commands in sequence', autofix: true }];
    },
  },
  SP012: {
    name: 'background-ampersand',
    severity: 'warning',
    platforms: PLATFORMS_ALL,
    description: 'A single "&" runs in the background in sh but sequentially in cmd.exe.',
    check(seg) {
      if (seg.after !== '&') return [];
      return [{ message: '"&" backgrounds the command in sh but runs commands one after another in cmd.exe.', fix: 'concurrently "npm:a" "npm:b" or run-p a b (npm-run-all2)', packages: ['concurrently'] }];
    },
  },
  SP013: {
    name: 'null-device',
    severity: 'error',
    platforms: PLATFORMS_ALL,
    description: '/dev/null does not exist on Windows; NUL does not exist on POSIX.',
    check(seg) {
      const out = [];
      if (/\/dev\/null/.test(seg.text)) out.push({ message: '/dev/null does not exist in cmd.exe ("The system cannot find the path specified").', fix: 'drop the redirect, or pass a --silent flag to the tool', platforms: PLATFORMS_WIN });
      if (/>\s*nul\b/i.test(seg.text)) out.push({ message: 'Redirecting to NUL creates a file named "NUL" on Linux and macOS.', fix: 'drop the redirect, or pass a --silent flag to the tool', platforms: PLATFORMS_POSIX, severity: 'warning' });
      return out;
    },
  },
  SP014: {
    name: 'posix-shell-syntax',
    severity: 'error',
    platforms: PLATFORMS_WIN,
    description: 'POSIX shell syntax (if, for, test, [ ], heredocs, ~) is not understood by cmd.exe.',
    check(seg) {
      const out = [];
      if (POSIX_KEYWORDS.has(seg.cmd)) out.push({ message: `"${seg.cmd}" is POSIX shell syntax and is not understood by cmd.exe.`, fix: 'move the logic into a Node.js script (node scripts/<name>.mjs)' });
      if (/<<-?\s*['"]?\w+/.test(maskSingleQuoted(seg.text))) out.push({ message: 'Heredocs are not supported by cmd.exe.', fix: 'move the logic into a Node.js script' });
      const tilde = seg.words.find((w) => !w.single && !w.double && /^~(\/|$)/.test(w.raw));
      if (tilde) out.push({ message: `"${tilde.raw}" is not expanded to the home directory by cmd.exe.`, fix: 'use os.homedir() in a Node.js script', severity: 'warning' });
      return out;
    },
  },
  SP015: {
    name: 'shell-script-invocation',
    severity: 'warning',
    platforms: PLATFORMS_WIN,
    description: 'Shell scripts need bash, which is not available in cmd.exe by default.',
    check(seg) {
      const raw = seg.cmdWord?.raw || '';
      if (SH_INTERPRETERS.has(seg.cmd) || /\.sh$/.test(raw)) {
        if (/^\.\.?\//.test(raw)) return []; // reported by SP008
        return [{ message: `"${seg.text.trim()}" requires a POSIX shell; it only works on Windows when Git Bash or WSL is on PATH.`, fix: 'rewrite the script in Node.js, or document the Git Bash requirement and set script-shell in .npmrc' }];
      }
      return [];
    },
  },
  SP016: {
    name: 'windows-script-invocation',
    severity: 'error',
    platforms: PLATFORMS_POSIX,
    description: '.bat, .cmd and .ps1 files cannot run on Linux or macOS.',
    check(seg) {
      const raw = seg.cmdWord?.raw || '';
      const target = /\.(bat|cmd|ps1)$/i.test(raw) ? raw : seg.cmd === 'powershell' ? 'powershell' : null;
      if (!target) return [];
      return [{ message: `"${target}" only runs on Windows.`, fix: 'rewrite the script in Node.js, or use pwsh (PowerShell 7) which is cross-platform' }];
    },
  },
  SP017: {
    name: 'os-specific-open',
    severity: 'error',
    platforms: PLATFORMS_ALL,
    description: 'open (macOS), xdg-open (Linux) and start (Windows) are each tied to one OS.',
    check(seg) {
      if (seg.cmd === 'open') return [{ message: '"open" only exists on macOS.', fix: 'open-cli <url>', packages: ['open-cli'], platforms: ['windows', 'linux'] }];
      if (seg.cmd === 'xdg-open') return [{ message: '"xdg-open" only exists on Linux desktops.', fix: 'open-cli <url>', packages: ['open-cli'], platforms: ['windows', 'macos'] }];
      return [];
    },
  },
  SP018: {
    name: 'echo-quotes',
    severity: 'info',
    platforms: PLATFORMS_WIN,
    description: 'cmd.exe echo prints quote characters literally.',
    check(seg) {
      if (seg.cmd !== 'echo' || !seg.args.some((w) => w.single || w.double)) return [];
      return [{ message: 'echo in cmd.exe prints the quote characters as part of the output.', fix: 'node -e "console.log(\'...\')"' }];
    },
  },
  SP019: {
    name: 'missing-helper-dependency',
    severity: 'warning',
    platforms: PLATFORMS_ALL,
    description: 'The script uses a cross-platform helper that is not declared in package.json.',
    // Evaluated at script level in analyzer.js.
    check: () => [],
  },
  SP020: {
    name: 'script-shell-configured',
    severity: 'info',
    platforms: PLATFORMS_WIN,
    description: '.npmrc overrides script-shell; every contributor needs that shell installed.',
    check: () => [],
  },
};

// Binary name -> packages that provide it.
export const HELPER_BINARIES = {
  'cross-env': ['cross-env'],
  'cross-env-shell': ['cross-env'],
  rimraf: ['rimraf'],
  shx: ['shx'],
  'open-cli': ['open-cli'],
  concurrently: ['concurrently'],
  'run-p': ['npm-run-all2', 'npm-run-all'],
  'run-s': ['npm-run-all2', 'npm-run-all'],
  'npm-run-all': ['npm-run-all2', 'npm-run-all'],
  mkdirp: ['mkdirp'],
  cpy: ['cpy-cli'],
};

export { base as commandBase };
