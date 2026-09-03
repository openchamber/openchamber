import { spawnSync as defaultSpawnSync } from 'node:child_process';
import {
  probeProcessLiveness,
  resolveWindowsPowerShellPath,
  WINDOWS_POWERSHELL_FALLBACK_PATH,
} from './process-identity.js';

/**
 * Windows process-termination helpers (W-D).
 *
 * The Unix `ManagedOpenCodeGuardian.#terminateChild` uses
 * `process.kill(-pid, 'SIGTERM')` and `child.kill('SIGTERM')` then
 * escalates to `SIGKILL` after `STOP_SIGNAL_TIMEOUT_MS`. None of that
 * works on Windows: there is no `setpgid(0,0)` (no process groups via
 * `process.kill(-pid, ...)`), and `child.kill('SIGTERM')` translates to
 * a `TerminateProcess` on Node.js which is the moral equivalent of
 * `SIGKILL` (no graceful shutdown). A live Node ChildProcess has a process
 * handle, so the safe primitive is `child.kill()`. A rehydrated child has no
 * Node ChildProcess handle. Its termination therefore uses the tightly scoped
 * PowerShell/.NET helper below, which opens one kernel process handle, checks
 * the persisted start-time and launch identity against that handle's target,
 * and terminates that same retained handle. If the helper is unavailable, the
 * lifecycle fails closed. `runTaskkillForce` remains a low-level compatibility
 * and test helper and is not used by the lifecycle path:
 *
 *   - `/F` is required because there is no graceful SIGTERM equivalent
 *     for arbitrary Node.js children on Windows; `CTRL+C` only works
 *     when the child has a console and a signal handler, neither of
 *     which we can rely on for a detached `opencode serve` child.
 *   - `/T` (tree kill) is intentionally NOT used: it would walk the
 *     child process tree and kill the OpenCode child's own children
 *     (e.g. a wrapped shim or a future bundled process). The T2 design
 *     invariant says we only kill the spawned OpenCode PID (see the
 *     plan's risk register: "taskkill /pid /f kills our own process
 *     group via accidental /t" — High).
 *   - Exit code 128 ("process not found") is treated as success
 *     because it means the process is already gone.
 *   - `ESRCH` errors are treated as success because the process was never
 *     present. `EPERM` remains an error: permission loss is ambiguous and
 *     must not be mistaken for a terminated child.
 *
 * Live ChildProcess objects use their `close` event; rehydrated children use
 * an operating-system liveness poll only after a handle-backed terminator.
 *
 * No raw secret / password / token is ever logged or persisted here.
 */

const TASKKILL_TIMEOUT_MS = 5000;
// `taskkill` exit code 128 == "process not found" (the OS error
// `ERROR_INVALID_PARAMETER` mapped by `taskkill.exe` to its own
// status). Treat as already-gone.
const TASKKILL_EXIT_NOT_FOUND = 128;
const PROCESS_POLL_INTERVAL_MS = 25;
const WINDOWS_HANDLE_TERMINATION_TIMEOUT_MS = 5000;

// This helper deliberately receives its request over stdin and is launched
// with an encoded command. No user-controlled value is interpolated into a
// shell command. The process handle is opened before any identity check and
// retained until the final TerminateProcess call, so a PID cannot be reused
// between verification and termination of a different process.
const WINDOWS_HANDLE_TERMINATION_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class OpenChamberHandleTerminator
{
    public const uint ProcessTerminate = 0x0001;
    public const uint ProcessQueryLimitedInformation = 0x1000;
    public const uint StillActive = 259;

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetProcessTimes(
        IntPtr processHandle,
        out long creationTime,
        out long exitTime,
        out long kernelTime,
        out long userTime);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetExitCodeProcess(IntPtr processHandle, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool TerminateProcess(IntPtr processHandle, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr handle);

    public static int LastError()
    {
        return Marshal.GetLastWin32Error();
    }
}
'@

function New-Result([string]$status, [string]$reason) {
    $value = @{ status = $status }
    if ($reason) { $value.reason = $reason }
    return $value
}

function Split-WindowsCommandLine([string]$value) {
    if ([string]::IsNullOrWhiteSpace($value)) { return $null }
    $commandText = $value.Trim()
    $tokens = New-Object 'System.Collections.Generic.List[string]'
    $current = New-Object 'System.Text.StringBuilder'
    $backslash = [string][char]92
    $tokenStarted = $false
    $inQuotes = $false
    $index = 0

    while ($index -lt $commandText.Length) {
        $character = $commandText[$index]
        if ($character -eq '\') {
            $start = $index
            while ($index -lt $commandText.Length -and $commandText[$index] -eq '\') { $index++ }
            $slashCount = $index - $start
            if ($index -lt $commandText.Length -and $commandText[$index] -eq '"') {
                $pairs = [int][math]::Floor($slashCount / 2)
                if ($pairs -gt 0) { [void]$current.Append((($backslash * $pairs) -join '')) }
                $tokenStarted = $true
                if (($slashCount % 2) -eq 1) {
                    [void]$current.Append('"')
                    $index++
                } else {
                    $inQuotes = -not $inQuotes
                    $index++
                }
                continue
            }
            if ($slashCount -gt 0) { [void]$current.Append((($backslash * $slashCount) -join '')) }
            $tokenStarted = $true
            continue
        }
        if ($character -eq '"') {
            $inQuotes = -not $inQuotes
            $tokenStarted = $true
            $index++
            continue
        }
        if ([char]::IsWhiteSpace($character) -and -not $inQuotes) {
            if ($tokenStarted) {
                [void]$tokens.Add($current.ToString())
                [void]$current.Clear()
                $tokenStarted = $false
            }
            $index++
            continue
        }
        [void]$current.Append($character)
        $tokenStarted = $true
        $index++
    }

    if ($inQuotes) { return $null }
    if ($tokenStarted) { [void]$tokens.Add($current.ToString()) }
    if ($tokens.Count -eq 0) { return $null }
    return ,$tokens.ToArray()
}

function Normalize-WindowsCommandToken([string]$value) {
    if ([string]::IsNullOrWhiteSpace($value)) { return $null }
    $normalized = $value.Trim()
    if ($normalized -match '[\x00-\x1F\x7F]') { return $null }
    return $normalized.ToLowerInvariant()
}

function Test-WindowsExecutableToken([string]$expected, [string]$actual) {
    $normalizedExpected = Normalize-WindowsCommandToken $expected
    $normalizedActual = Normalize-WindowsCommandToken $actual
    if ($null -eq $normalizedExpected -or $null -eq $normalizedActual) { return $false }
    if ($normalizedExpected -eq $normalizedActual) { return $true }
    if ($normalizedExpected -match '[\\/:]') { return $false }
    $expectedStem = [IO.Path]::GetFileName($normalizedExpected) -replace '\.(?:exe|cmd|bat)$', ''
    $actualStem = [IO.Path]::GetFileName($normalizedActual) -replace '\.(?:exe|cmd|bat)$', ''
    return $expectedStem -eq $actualStem
}

$result = $null
$handle = [IntPtr]::Zero
try {
    $requestJson = [Console]::In.ReadToEnd()
    $request = $requestJson | ConvertFrom-Json
    $requestPid = [uint32]$request.pid
    $expectedTicks = [string]$request.processStartTicks
    $launchSpec = $request.launchSpec
    $expectedPort = 0
    try { $expectedPort = [int]$request.port } catch { $expectedPort = 0 }

    if ($requestPid -eq 0 -or [string]::IsNullOrEmpty($expectedTicks) -or $null -eq $launchSpec
        -or [string]::IsNullOrEmpty([string]$launchSpec.binary)
        -or $null -eq $launchSpec.args
        -or [string]::IsNullOrEmpty([string]$launchSpec.hostname)
        -or $expectedPort -le 0 -or $expectedPort -gt 65535
        -or [int]$launchSpec.port -ne $expectedPort) {
        $result = New-Result 'error' 'persisted Windows process identity is incomplete'
    } else {
        $access = [OpenChamberHandleTerminator]::ProcessTerminate -bor [OpenChamberHandleTerminator]::ProcessQueryLimitedInformation
        $handle = [OpenChamberHandleTerminator]::OpenProcess($access, $false, $requestPid)
        if ($handle -eq [IntPtr]::Zero) {
            $result = New-Result 'error' ("OpenProcess failed with Win32 error {0}" -f [OpenChamberHandleTerminator]::LastError())
        } else {
            try {
                [long]$creationTime = 0
                [long]$exitTime = 0
                [long]$kernelTime = 0
                [long]$userTime = 0
                if (-not [OpenChamberHandleTerminator]::GetProcessTimes($handle, [ref]$creationTime, [ref]$exitTime, [ref]$kernelTime, [ref]$userTime)) {
                    $result = New-Result 'error' ("GetProcessTimes failed with Win32 error {0}" -f [OpenChamberHandleTerminator]::LastError())
                } else {
                    $actualTicks = [DateTime]::FromFileTimeUtc($creationTime).Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
                    if ($actualTicks -ne $expectedTicks) {
                        $result = New-Result 'error' 'Windows process start identity changed'
                    } else {
                        $commandLine = ''
                        try {
                            $processInfo = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId = {0}" -f $requestPid)
                            $commandLine = [string]$processInfo.CommandLine
                        } catch {
                            $commandLine = ''
                        }

                        if ([string]::IsNullOrEmpty($commandLine)) {
                            $result = New-Result 'error' 'Windows process launch identity is unavailable'
                        } else {
                            $expectedTokens = New-Object System.Collections.Generic.List[string]
                            [void]$expectedTokens.Add([string]$launchSpec.binary)
                            foreach ($argument in @($launchSpec.args)) {
                                [void]$expectedTokens.Add([string]$argument)
                            }
                            [void]$expectedTokens.Add('serve')
                            [void]$expectedTokens.Add('--hostname')
                            [void]$expectedTokens.Add([string]$launchSpec.hostname)
                            [void]$expectedTokens.Add('--port')
                            [void]$expectedTokens.Add([string]$expectedPort)

                            $actualTokens = Split-WindowsCommandLine $commandLine
                            $identityMatches = $null -ne $actualTokens -and $actualTokens.Count -eq $expectedTokens.Count
                            if ($identityMatches) {
                                for ($index = 0; $index -lt $expectedTokens.Count; $index++) {
                                    $expectedToken = [string]$expectedTokens[$index]
                                    $actualToken = [string]$actualTokens[$index]
                                    $tokenMatches = if ($index -eq 0) {
                                        Test-WindowsExecutableToken $expectedToken $actualToken
                                    } else {
                                        $normalizedExpected = Normalize-WindowsCommandToken $expectedToken
                                        $normalizedActual = Normalize-WindowsCommandToken $actualToken
                                        $null -ne $normalizedExpected -and $normalizedExpected -eq $normalizedActual
                                    }
                                    if (-not $tokenMatches) {
                                        $identityMatches = $false
                                        break
                                    }
                                }
                            }
                            if (-not $identityMatches) {
                                $result = New-Result 'error' 'Windows process launch identity changed'
                            } elseif ([OpenChamberHandleTerminator]::TerminateProcess($handle, 1)) {
                                $result = New-Result 'killed' $null
                            } else {
                                [uint32]$exitCode = 0
                                if ([OpenChamberHandleTerminator]::GetExitCodeProcess($handle, [ref]$exitCode) -and $exitCode -ne [OpenChamberHandleTerminator]::StillActive) {
                                    $result = New-Result 'already-gone' $null
                                } else {
                                    $result = New-Result 'error' ("TerminateProcess failed with Win32 error {0}" -f [OpenChamberHandleTerminator]::LastError())
                                }
                            }
                        }
                    }
                }
            } finally {
                [void][OpenChamberHandleTerminator]::CloseHandle($handle)
            }
        }
    }
} catch {
    $result = New-Result 'error' 'Windows handle terminator failed'
} finally {
    if ($result -eq $null) {
        $result = New-Result 'error' 'Windows handle terminator returned no result'
    }
}

$result | ConvertTo-Json -Compress
`;

const assertIntegerPid = (pid, label) => {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new TypeError(`windows-process: ${label} must be a positive integer (got ${pid})`);
  }
};

const hasChildExited = (child) =>
  !child || child.exitCode !== null || child.signalCode !== null;

const isRehydratedChild = (child) => child?.isRehydrated === true;

const defaultIsProcessAlive = probeProcessLiveness;

const normalizeLiveness = (value) => {
  if (value === false || value === 'dead') return 'dead';
  if (value === true || value === 'alive') return 'alive';
  return 'unknown';
};

const readLiveness = (pid, isProcessAlive) => {
  try {
    return normalizeLiveness(isProcessAlive(pid));
  } catch {
    // A failed liveness probe is not proof that a process is gone.  Keep the
    // termination attempt fail-closed and let the handle helper make the next
    // decision.
    return 'unknown';
  }
};

const waitForClose = (child, timeoutMs) => new Promise((resolve) => {
  if (hasChildExited(child)) {
    resolve(true);
    return;
  }
  const timer = setTimeout(() => resolve(hasChildExited(child)), timeoutMs);
  child.once('close', () => {
    clearTimeout(timer);
    resolve(true);
  });
});

const waitForProcessExit = (pid, timeoutMs, isProcessAlive) => new Promise((resolve) => {
  const deadline = Date.now() + timeoutMs;
  const check = () => {
    if (readLiveness(pid, isProcessAlive) === 'dead') {
      resolve(true);
      return;
    }
    if (Date.now() >= deadline) {
      resolve(false);
      return;
    }
    setTimeout(check, Math.min(PROCESS_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  };
  check();
});

const encodePowerShellCommand = (script) => Buffer.from(script, 'utf16le').toString('base64');

const WINDOWS_HELPER_DIAGNOSTIC_MAX_LENGTH = 512;
const SAFE_HANDLE_HELPER_REASONS = new Set([
  'persisted Windows process identity is incomplete',
  'Windows process start identity changed',
  'Windows process launch identity is unavailable',
  'Windows process launch identity changed',
  'Windows handle terminator failed',
  'Windows handle terminator returned no result',
]);

const sanitizeWindowsHelperDiagnostic = (value) => {
  const normalized = String(value ?? '')
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return '';
  const redacted = normalized.replace(
    /((?:password|passwd|token|secret|credential|authorization|basic)\s*[:=]\s*)[^\s,;]+/gi,
    '$1[redacted]',
  );
  return redacted.length > WINDOWS_HELPER_DIAGNOSTIC_MAX_LENGTH
    ? `${redacted.slice(0, WINDOWS_HELPER_DIAGNOSTIC_MAX_LENGTH - 1)}…`
    : redacted;
};

const safeDiagnosticCode = (value) => {
  const code = sanitizeWindowsHelperDiagnostic(value);
  return /^[A-Za-z0-9_]{1,32}$/.test(code) ? code : '';
};

const safeHandleHelperReason = (value) => {
  const reason = sanitizeWindowsHelperDiagnostic(value);
  if (SAFE_HANDLE_HELPER_REASONS.has(reason)) return reason;
  if (/^(?:OpenProcess|GetProcessTimes|TerminateProcess) failed with Win32 error \d{1,10}$/.test(reason)) {
    return reason;
  }
  return 'Windows handle terminator failed';
};

const parseHandleTerminatorResult = (stdout) => {
  const text = String(stdout ?? '').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed?.status === 'killed' || parsed?.status === 'already-gone') {
      return { status: parsed.status };
    }
    if (parsed?.status === 'error') {
      return { status: 'error', reason: safeHandleHelperReason(parsed.reason) };
    }
  } catch {
    // The caller below turns malformed helper output into a fail-closed error.
  }
  return null;
};

/**
 * Terminate a rehydrated child through a retained Windows process handle.
 *
 * The PowerShell/.NET helper opens the handle, verifies the persisted
 * `processStartTicks` and launch-spec identity, then calls `TerminateProcess`
 * on that same handle. There is intentionally no PID-only fallback. The
 * `spawnSync` seam is injectable so tests can cover helper availability,
 * identity rejection, and successful outcomes without requiring Windows.
 *
 * @param {object} child - Rehydrated child with a positive `pid`.
 * @param {object} options
 * @param {object} options.record - Durable record containing process identity.
 * @param {typeof defaultSpawnSync} [options.spawnSync]
 * @param {string} [options.systemRoot] - Test seam for the trusted Windows
 *   installation root; production uses `process.env.SystemRoot`.
 * @returns {{ status: 'killed'|'already-gone' } | { status: 'error', reason: string }}
 */
export function terminateRehydratedChildWindows(
  child,
  { record, spawnSync = defaultSpawnSync, systemRoot } = {},
) {
  assertIntegerPid(child?.pid, 'rehydrated child pid');
  if (!record || !/^(?:0|[1-9]\d*)$/.test(String(record.processStartTicks ?? ''))
    || !record.launchSpec || typeof record.launchSpec !== 'object'
    || !Number.isSafeInteger(record.port) || record.port <= 0 || record.port > 65535
    || record.launchSpec.port !== record.port) {
    return { status: 'error', reason: 'persisted Windows process identity is incomplete' };
  }

  const request = JSON.stringify({
    pid: child.pid,
    processStartTicks: String(record.processStartTicks),
    port: record.port,
    launchSpec: record.launchSpec,
  });
  let result;
  const powershellPath = resolveWindowsPowerShellPath(systemRoot);
  try {
    result = spawnSync(powershellPath, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-EncodedCommand',
      encodePowerShellCommand(WINDOWS_HANDLE_TERMINATION_SCRIPT),
    ], {
      input: request,
      encoding: 'utf8',
      timeout: WINDOWS_HANDLE_TERMINATION_TIMEOUT_MS,
      windowsHide: true,
      shell: false,
    });
  } catch (error) {
    const code = safeDiagnosticCode(error?.code);
    return {
      status: 'error',
      reason: `Windows handle terminator spawn failed${code ? ` (${code})` : ''}`,
    };
  }

  if (result?.error) {
    if (result.error.code === 'ENOENT') {
      return { status: 'error', reason: 'Windows handle terminator is unavailable: powershell.exe not found' };
    }
    const code = safeDiagnosticCode(result.error.code);
    return {
      status: 'error',
      reason: `Windows handle terminator spawn failed${code ? ` (${code})` : ''}`,
    };
  }
  if (result?.signal) {
    const signal = safeDiagnosticCode(result.signal) || 'unknown';
    return { status: 'error', reason: `Windows handle terminator terminated by signal ${signal}` };
  }
  if (result?.status !== 0) {
    return {
      status: 'error',
      reason: `Windows handle terminator exited with code ${Number.isInteger(result?.status) ? result.status : 'unknown'}`,
    };
  }
  const helperResult = parseHandleTerminatorResult(result.stdout);
  if (helperResult) return helperResult;
  return {
    status: 'error',
    reason: 'Windows handle terminator returned malformed or ambiguous output',
  };
}

/**
 * Run `taskkill.exe /F /PID <pid>` synchronously and translate the
 * outcome into a `{ status, reason }` envelope. Exposed for unit
 * tests; the public API is `terminateChildWindows`.
 *
 * The result envelope is:
 *   - `{ status: 'killed' }` — `taskkill` accepted the request against
 *     a live process (exit 0). The caller should wait for the child
 *     `close` event, or poll a rehydrated child's OS liveness, to confirm
 *     the kill landed.
 *   - `{ status: 'already-gone' }` — `taskkill` confirmed the process
 *     is no longer reachable (exit 128 = "process not found", or
 *     `ESRCH` spawn error). The caller can return success without waiting
 *     for a close event that will never fire.
 *   - `{ status: 'error', reason }` — unexpected failure
 *     (`ENOENT` for missing binary, non-zero non-128 exit, killed
 *     by signal, etc.).
 *
 * Note: `spawnSync` does not throw on `EPERM`/`ESRCH`; it returns
 * `{ error: <Error>, status: null, ... }`. We detect by `result.error`
 * (and `result.error.code`) rather than try/catch.
 *
 * @param {object} options
 * @param {number} options.pid
 * @param {typeof defaultSpawnSync} [options.spawnSync]
 * @returns {{ status: 'killed' } | { status: 'already-gone' } | { status: 'error', reason: string }}
 */
export function runTaskkillForce({ pid, spawnSync = defaultSpawnSync } = {}) {
  assertIntegerPid(pid, 'pid');
  // The PID is a positive integer validated by `assertIntegerPid`
  // above; we coerce via `String()` for the argument list so the
  // values flow through Node's `args` array (not a shell string) and
  // therefore need no shell-style quoting. `assertIntegerPid` is the
  // defense-in-depth boundary.
  const args = ['/F', '/PID', String(pid)];
  const result = spawnSync('taskkill.exe', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: TASKKILL_TIMEOUT_MS,
  });
  if (result.error) {
    if (result.error.code === 'ESRCH') {
      return { status: 'already-gone' };
    }
    if (result.error.code === 'ENOENT') {
      return { status: 'error', reason: 'taskkill.exe not found on PATH' };
    }
    const code = safeDiagnosticCode(result.error.code);
    return { status: 'error', reason: `taskkill.exe spawn failed${code ? ` (${code})` : ''}` };
  }
  if (result.signal) {
    // The taskkill.exe process itself was killed by a signal (e.g.
    // a parent timeout fired). Treat as a real failure.
    const signal = safeDiagnosticCode(result.signal) || 'unknown';
    return { status: 'error', reason: `taskkill.exe terminated by signal ${signal}` };
  }
  if (result.status === TASKKILL_EXIT_NOT_FOUND) {
    return { status: 'already-gone' };
  }
  if (result.status === 0) {
    return { status: 'killed' };
  }
  return {
    status: 'error',
    reason: `taskkill.exe exited with code ${Number.isInteger(result.status) ? result.status : 'unknown'}`,
  };
}

/**
 * Terminate an OpenCode child on Windows without a PID-only fallback.
 *
 * Behavior:
 *   1. If the child has already exited (`exitCode !== null` or
 *      `signalCode !== null`), return `{ ok: true }` immediately.
 *   2. A live ChildProcess is terminated through its process handle via
 *      `child.kill()`; a rehydrated child requires an injected native
 *      handle-backed terminator (the guardian supplies the Windows helper).
 *   3. Wait up to `timeoutMs` for the child's `close` event, or poll the
 *      operating-system liveness of a rehydrated child (which has no live
 *      ChildProcess handle and therefore cannot emit `close`).
 *   4. Return `{ ok: true }` on observed close; `{ ok: false, reason: 'still-running' }` otherwise.
 *
 * PID-only taskkill remains available through `runTaskkillForce` as a
 * low-level compatibility/test helper, but is not used here because an
 * identity check followed by PID termination retains a reuse window.
 *
 * @param {object} child - A Node.js ChildProcess handle or a guardian
 *   rehydrated child. Must have a numeric `pid`; live handles expose
 *   `exitCode`, `signalCode`, and a `close` event, while rehydrated handles
 *   set `isRehydrated: true`.
 * @param {object} [options]
 * @param {number} [options.timeoutMs=2500] - Outer close-wait or liveness-poll
 *   window. Matches the Unix `STOP_SIGNAL_TIMEOUT_MS` so both
 *   platforms spend the same wall-clock time waiting for the child
 *   to die before reporting failure.
 * @param {(pid: number) => ('alive'|'dead'|'unknown'|boolean)} [options.isProcessAlive]
 *   Operating system liveness probe used for rehydrated children; defaults to
 *   the shared tri-state `process.kill(pid, 0)` probe. Unknown is never dead.
 * @param {(child: object) => Promise<{ status?: 'killed'|'already-gone' }|boolean>|{ status?: 'killed'|'already-gone' }|boolean} [options.terminateByHandle]
 *   Native process-handle terminator for rehydrated children. Omit to fail
 *   closed rather than issue a PID-only termination command.
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
export async function terminateChildWindows(
  child,
  {
    timeoutMs = 2500,
    isProcessAlive = defaultIsProcessAlive,
    terminateByHandle,
  } = {},
) {
  const rehydrated = isRehydratedChild(child);
  if (!rehydrated && hasChildExited(child)) {
    return { ok: true };
  }
  const pid = child?.pid;
  if (!pid) return { ok: true };

  if (rehydrated) {
    if (readLiveness(pid, isProcessAlive) === 'dead') return { ok: true };
    // A persisted PID has no process handle in this process. An identity
    // check followed by taskkill /PID still has a reuse window, so fail closed
    // unless the caller supplies a native handle-backed terminator.
    if (typeof terminateByHandle !== 'function') {
      return {
        ok: false,
        reason: 'handle-backed Windows termination is unavailable for a rehydrated child',
      };
    }
    let result;
    try {
      result = await terminateByHandle(child);
    } catch (error) {
      const code = safeDiagnosticCode(error?.code);
      return {
        ok: false,
        reason: `handle-backed Windows termination failed${code ? ` (${code})` : ''}`,
      };
    }
    if (result === false || result?.status === 'error'
      || (result !== true && result?.status !== 'killed' && result?.status !== 'already-gone')) {
      return { ok: false, reason: safeHandleHelperReason(result?.reason) };
    }
    if (result?.status === 'already-gone') return { ok: true };
    if (await waitForProcessExit(pid, timeoutMs, isProcessAlive)) {
      return { ok: true };
    }
    return { ok: false, reason: 'still-running' };
  }

  // A live ChildProcess exposes a kernel-backed handle through child.kill().
  // Use that primitive rather than converting an identity check into a
  // PID-only taskkill operation.
  if (typeof child.kill !== 'function') {
    return { ok: false, reason: 'handle-backed Windows termination is unavailable for a live child' };
  }
  try {
    if (child.kill() === false && !hasChildExited(child)) {
      return { ok: false, reason: 'handle-backed Windows termination was rejected' };
    }
  } catch (error) {
    const code = safeDiagnosticCode(error?.code);
    return {
      ok: false,
      reason: `handle-backed Windows termination failed${code ? ` (${code})` : ''}`,
    };
  }
  if (hasChildExited(child)) return { ok: true };
  if (await waitForClose(child, timeoutMs)) return { ok: true };
  return { ok: false, reason: 'still-running' };
}

// Exported for unit tests; not part of the public surface.
export const __test__ = {
  TASKKILL_TIMEOUT_MS,
  TASKKILL_EXIT_NOT_FOUND,
  WINDOWS_HANDLE_TERMINATION_TIMEOUT_MS,
  WINDOWS_POWERSHELL_FALLBACK_PATH,
  WINDOWS_HANDLE_TERMINATION_SCRIPT,
  resolveWindowsPowerShellPath,
  sanitizeWindowsHelperDiagnostic,
  safeHandleHelperReason,
  hasChildExited,
};
