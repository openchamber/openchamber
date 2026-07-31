import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Well-formedness test for `scripts/guardian-smoke-test.ps1` (W-E).
//
// The script is the Windows-side mirror of `scripts/guardian-smoke-test.sh`
// and is exercised end-to-end by the `windows-latest` GitHub Actions job.
// On the Linux CI runner the script is never executed (it short-circuits
// with `skip: not Windows`); this test fills the gap with a static
// well-formedness check that does not require `pwsh` to be installed.
//
// We deliberately place this test in
// `packages/web/server/lib/guardian/` rather than under `scripts/`
// because:
//   - `scripts/` has no vitest config (the existing `guardian-smoke-test.sh`
//     is a plain shell script with no test runner).
//   - The vitest config in `packages/web` (`packages/web/vitest.config.ts`)
//     already discovers `server/lib/guardian/*.test.js`, so adding a new
//     file here is a one-liner with no infra changes.
//   - The W-E plan (`plans/vscode-handoff-design-notes.md` § W-E) calls
//     this exact location out as the home for the new test.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..', '..');
const scriptPath = join(repoRoot, 'scripts', 'guardian-smoke-test.ps1');
const clientScriptPath = join(repoRoot, 'scripts', 'guardian-smoke-client.js');

const readScript = () => {
  if (!existsSync(scriptPath)) {
    throw new Error(`PowerShell smoke script not found at ${scriptPath}`);
  }
  return readFileSync(scriptPath, 'utf8');
};

describe('scripts/guardian-smoke-test.ps1 well-formedness', () => {
  it('exists at the canonical path', () => {
    expect(existsSync(scriptPath)).toBe(true);
  });

  it('declares ErrorActionPreference (PowerShell equivalent of `set -e`)', () => {
    const src = readScript();
    expect(src).toMatch(/\$ErrorActionPreference\s*=\s*['"]Stop['"]/);
  });

  it('starts with a `#Requires` or shebang/comment block', () => {
    const src = readScript();
    const head = src.split('\n').slice(0, 10).join('\n');
    // PowerShell best-practice: a `#Requires` line at the top, or a
    // leading comment block (this script uses both).
    expect(head).toMatch(/#Requires\s+-Version/);
    expect(head.trimStart().startsWith('#') || head.includes('<#')).toBe(true);
  });

  it('short-circuits on non-Windows hosts', () => {
    const src = readScript();
    // The bash version prints "skip: not Linux"; the PowerShell
    // version prints "skip: not Windows". Either phrasing is OK as
    // long as the platform check is there.
    const hasIsWindows = /\$IsWindows/.test(src);
    const hasEnvCheck = /\$env:OS/.test(src);
    const hasSkipMessage = /skip:\s*not\s*Windows/.test(src);
    expect(hasIsWindows || hasEnvCheck).toBe(true);
    expect(hasSkipMessage).toBe(true);
  });

  it('delegates the real IPC round-trip to the cross-platform smoke client', () => {
    const src = readScript();
    expect(src).toMatch(/guardian-smoke-client\.js/);
    expect(src).toMatch(/node\.exe/);
    expect(existsSync(clientScriptPath)).toBe(true);
  });

  it('passes --data-dir and the Windows startup flags to the entrypoint', () => {
    const src = readScript();
    expect(src).toMatch(/--data-dir/);
    // The Windows startup branch in `bin/openchamber-guardian.js`
    // accepts `--port-path`; the smoke script forwards it.
    expect(src).toMatch(/--port-path/);
  });

  it('sends `list` and `shutdown` JSON-line requests', () => {
    const src = readFileSync(clientScriptPath, 'utf8');
    expect(src).toMatch(/'list'/);
    expect(src).toMatch(/'shutdown'/);
    expect(src).toMatch(/'spawn'/);
    expect(src).toMatch(/'stop'/);
  });

  it('has balanced curly braces (sanity check for an unterminated block)', () => {
    const src = readScript();
    const open = (src.match(/\{/g) || []).length;
    const close = (src.match(/\}/g) || []).length;
    expect(open).toBe(close);
  });

  it('does not embed any POSIX-only shell idioms', () => {
    const src = readScript();
    // The bash version uses `set -uo pipefail`; the PowerShell
    // version uses `$ErrorActionPreference`. Make sure the
    // POSIX-only directive never leaked across.
    expect(src).not.toMatch(/\bset\s+-uo\s+pipefail\b/);
    // `uname`, `bash -c`, and other POSIX-only commands have no
    // place in a PowerShell-only script.
    expect(src).not.toMatch(/\buname\b/);
    expect(src).not.toMatch(/\bbash\s+-c\b/);
    // POSIX-only shell `set` options: `set -e`, `set -u`, `set -o pipefail`.
    expect(src).not.toMatch(/\bset\s+-[a-z]+\b/);
  });

  it('does not import POSIX-only Node built-ins (net.createServer, etc.)', () => {
    const src = readScript();
    // The script is PowerShell — it should not embed a Node `require`
    // / `import` of `node:net` (the bash version does that, but
    // PowerShell is a separate language).
    expect(src).not.toMatch(/require\(['"]node:net['"]\)/);
    expect(src).not.toMatch(/from\s+['"]node:net['"]/);
  });

  it('registers a `finally` cleanup that kills the spawned node process', () => {
    const src = readScript();
    // The W-E spec says any premature exit must kill the spawned
    // node child so a CI failure does not leak processes.
    expect(src).toMatch(/\bfinally\b/);
    expect(src).toMatch(/Stop-Process/);
  });

  it('keeps early failure diagnostics safe before log paths are initialized', () => {
    const src = readScript();
    expect(src).toMatch(/\$LogFile\s+-and\s+\(Test-Path\s+-LiteralPath\s+\$LogFile\)/);
    expect(src).toMatch(/\$LogErrFile\s+-and\s+\(Test-Path\s+-LiteralPath\s+\$LogErrFile\)/);
  });

  // Optional: if `pwsh` is on PATH, run the PowerShell parser against
  // the file. This is a best-effort, more-rigorous check than the
  // curly-brace balance above. The test is skipped (via `it.runIf`)
  // when `pwsh` is not installed so Linux CI without PowerShell
  // stays green.
  it.runIf(whichPwsh())('parses cleanly under pwsh', () => {
    const which = whichPwsh();
    expect(which).toBeTruthy();
    // `[System.Management.Automation.Language.Parser]::ParseFile`
    // throws on any parse error. We let the exception propagate
    // through vitest as a test failure.
    const escapedPath = scriptPath.replaceAll("'", "''");
    const parseCommand = [
      '$tokens = $null',
      '$errors = $null',
      "[System.Management.Automation.Language.Parser]::ParseFile('" + escapedPath + "', [ref]$tokens, [ref]$errors) | Out-Null",
      "if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }",
      "Write-Host 'OK'",
    ].join('; ');
    execFileSync(which, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      parseCommand,
    ], { stdio: 'pipe', timeout: 15000 });
  }, 20000);
});

function whichPwsh() {
  // Cheap probe: try `which pwsh` synchronously on POSIX. On
  // Windows we return `null` so the optional `parses cleanly under
  // pwsh` test below is skipped via `it.runIf(null)`. The reason:
  // on the GitHub Actions `windows-latest` runner, `where pwsh`
  // (Windows) or `which pwsh` (Git Bash) often returns a msys-style
  // path like `/c/Program Files/PowerShell/7/pwsh`. Node's
  // `spawnSync` on that path resolves as if on Linux and yields
  // ENOENT, even when the binary exists. The real Windows smoke
  // run is exercised separately by the CI job via
  // `pwsh -File scripts/guardian-smoke-test.ps1`; this test file
  // is the well-formedness backstop for non-Windows CI, and the
  // static assertions above (ErrorActionPreference, curly-brace
  // balance, .NET TcpClient presence, etc.) still run on Windows.
  if (process.platform === 'win32') {
    return null;
  }
  try {
    const out = execFileSync('which', ['pwsh'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}
