import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { DEFAULT_PORT } from './cli-args.js';
import { EXIT_CODE, TunnelCliError } from './cli-errors.js';
import { getDataDir } from './cli-paths.js';
import { hasUiPasswordConfigured } from './cli-network.js';
import { searchPathFor } from './cli-executables.js';
import { requestServerShutdown } from './cli-http.js';
import { isProcessRunning, stopInstanceProcess } from './cli-process.js';
import { injectedEnvKeys } from '../../server/lib/injected-env.js';

const STARTUP_SERVICE_ID = 'dev.openchamber.web';

function getStartupServicePaths() {
  if (process.platform === 'darwin') {
    return {
      platform: 'macos',
      servicePath: path.join(os.homedir(), 'Library', 'LaunchAgents', `${STARTUP_SERVICE_ID}.plist`),
    };
  }
  if (process.platform === 'linux') {
    return {
      platform: 'linux',
      servicePath: path.join(os.homedir(), '.config', 'systemd', 'user', 'openchamber.service'),
    };
  }
  if (process.platform === 'win32') {
    return { platform: 'windows', servicePath: STARTUP_SERVICE_ID };
  }
  return { platform: process.platform, servicePath: null };
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function systemdEscapeArg(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function startupShellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function systemdUnitPath(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/ /g, '\\x20');
}

function powershellQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function startupEnvFileQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function systemdEnvFileQuote(value) {
  return `"${String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$')}"`;
}

function getStartupEnvFilePath() {
  return path.join(getDataDir(), 'startup.env');
}

function getMacosStartupWrapperPath() {
  return path.join(getDataDir(), 'bin', 'OpenChamber');
}

function getWindowsStartupWrapperPath() {
  return path.join(getDataDir(), 'bin', 'OpenChamber.ps1');
}

function collectStartupEnv(options = {}) {
  // Variables OpenChamber itself put into this shell (the desktop app's
  // terminal, an agent's shell) describe that instance, not the service.
  const injected = injectedEnvKeys(process.env);
  const env = options.envSnapshot === false ? {} : Object.fromEntries(
    Object.entries(process.env)
      .filter(([key, value]) => !injected.has(key) && shouldPersistStartupEnv(key, value))
      .map(([key, value]) => [key, String(value)])
  );

  if (options.envSnapshot !== false) {
    const opencodeBinary = process.env.OPENCODE_BINARY || searchPathFor('opencode');
    if (typeof opencodeBinary === 'string' && opencodeBinary.trim().length > 0) {
      env.OPENCODE_BINARY = opencodeBinary.trim();
    }
  }
  const uiPassword = hasUiPasswordConfigured(options.uiPassword) ? options.uiPassword : undefined;
  if (uiPassword) {
    env.OPENCHAMBER_UI_PASSWORD = uiPassword;
  }
  if (options.apiOnly === true) {
    env.OPENCHAMBER_API_ONLY = 'true';
  }
  if (typeof process.env.OPENCHAMBER_DATA_DIR === 'string' && process.env.OPENCHAMBER_DATA_DIR.trim().length > 0) {
    env.OPENCHAMBER_DATA_DIR = path.resolve(process.env.OPENCHAMBER_DATA_DIR.trim());
  }
  return env;
}

function shouldPersistStartupEnv(key, value) {
  if (typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return false;
  if (typeof value !== 'string') return false;
  if (/[\r\n]/.test(value)) return false;

  // These are shell/session implementation details, not app configuration.
  const volatileKeys = new Set([
    '_',
    'BASH_ENV',
    'COLUMNS',
    'CONDA_DEFAULT_ENV',
    'CONDA_PREFIX',
    'CONDA_PROMPT_MODIFIER',
    'CONDA_SHLVL',
    'ENV',
    'HISTFILE',
    'HISTFILESIZE',
    'HISTSIZE',
    'LINES',
    'OLDPWD',
    'PROMPT',
    'PROMPT_COMMAND',
    'PS1',
    'PS2',
    'PS3',
    'PS4',
    'PWD',
    'PYENV_VERSION',
    'SHLVL',
    'TERM',
    'TERM_PROGRAM',
    'TERM_PROGRAM_VERSION',
    'TTY',
    'VIRTUAL_ENV',
    'VIRTUAL_ENV_PROMPT',
  ]);
  return !volatileKeys.has(key);
}

function writeStartupEnvFile(options = {}, fileOptions = {}) {
  const envFilePath = getStartupEnvFilePath();
  const lines = [];
  const env = collectStartupEnv(options);
  const quoteValue = typeof fileOptions.quoteValue === 'function' ? fileOptions.quoteValue : startupEnvFileQuote;
  for (const [key, value] of Object.entries(env)) {
    lines.push(`${key}=${quoteValue(value)}`);
  }
  fs.mkdirSync(path.dirname(envFilePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(envFilePath, lines.length > 0 ? `${lines.join('\n')}\n` : '', { mode: 0o600 });
  return envFilePath;
}

function removeStartupEnvFile() {
  try { fs.unlinkSync(getStartupEnvFilePath()); } catch {}
}

const PNPM_STORE_SEGMENT = `${path.sep}.pnpm${path.sep}`;
const PACKAGE_SEGMENT = `${path.sep}node_modules${path.sep}@openchamber${path.sep}web${path.sep}`;

// pnpm keeps every installed version in its own store directory and links the
// current one into node_modules. A startup service pointed at the store path
// keeps launching the old version after an update, so prefer the link.
function stablePnpmEntrypoint(resolved, exists = fs.existsSync) {
  const storeIndex = resolved.indexOf(PNPM_STORE_SEGMENT);
  if (storeIndex < 0) return null;
  const packageIndex = resolved.indexOf(PACKAGE_SEGMENT, storeIndex);
  if (packageIndex < 0) return null;
  const stable = path.join(
    resolved.slice(0, storeIndex),
    '@openchamber',
    'web',
    resolved.slice(packageIndex + PACKAGE_SEGMENT.length),
  );
  return exists(stable) ? stable : null;
}

// pnpm 11 and later install a global package into a new directory under
// global/v11 on every update and delete the old one. A link beside it, named
// after the installed packages, moves to each new directory, and pnpm's shim
// starts the CLI through that link. Resolving it would pin the service to a
// directory the next update deletes.
function isPnpmGlobalLinkEntrypoint(invoked) {
  const packageIndex = invoked.indexOf(PACKAGE_SEGMENT);
  if (packageIndex < 0) return false;
  const linkPath = invoked.slice(0, packageIndex);
  const layoutDir = path.dirname(linkPath);
  if (!/^v\d+$/.test(path.basename(layoutDir)) || path.basename(path.dirname(layoutDir)) !== 'global') {
    return false;
  }
  try {
    return fs.lstatSync(linkPath).isSymbolicLink();
  } catch {
    return false;
  }
}

function resolveCliEntrypoint() {
  const entry = typeof process.argv[1] === 'string' && process.argv[1].trim().length > 0
    ? process.argv[1]
    : path.join(__dirname, 'cli.js');
  const invoked = path.resolve(entry);
  if (isPnpmGlobalLinkEntrypoint(invoked)) {
    return invoked;
  }
  let resolved;
  try {
    resolved = fs.realpathSync(entry);
  } catch {
    return path.resolve(entry);
  }
  return stablePnpmEntrypoint(resolved) ?? resolved;
}

function buildStartupArgs(options = {}) {
  const args = [resolveCliEntrypoint(), 'serve', '--foreground', '--port', String(options.port || DEFAULT_PORT)];
  if (typeof options.host === 'string' && options.host.length > 0) {
    args.push('--host', options.host);
  }
  if (options.apiOnly === true) {
    args.push('--api-only');
  }
  return args;
}

function writeMacosStartupWrapper(options = {}) {
  const wrapperPath = getMacosStartupWrapperPath();
  const args = buildStartupArgs(options).map(startupShellQuote).join(' ');
  const content = `#!/bin/sh
exec ${startupShellQuote(process.execPath)} ${args}
`;
  fs.mkdirSync(path.dirname(wrapperPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(wrapperPath, content, { mode: 0o700 });
  return wrapperPath;
}

function writeWindowsStartupWrapper(options = {}) {
  const wrapperPath = getWindowsStartupWrapperPath();
  const envFilePath = getStartupEnvFilePath();
  const startupArgs = buildStartupArgs(options).map(powershellQuote).join(' ');
  const ps1Content = [
    `$envFile=${powershellQuote(envFilePath)}`,
    `if (Test-Path $envFile) { Get-Content $envFile | ForEach-Object { if ($_ -match '^([^=]+)=(.*)$') { $v=$matches[2]; if ($v.StartsWith("'") -and $v.EndsWith("'")) { $v=$v.Substring(1,$v.Length-2).Replace("'\\''","'") }; [Environment]::SetEnvironmentVariable($matches[1], $v, 'Process') } } }`,
    `& ${powershellQuote(process.execPath)} ${startupArgs}`,
  ].join('; ');
  fs.mkdirSync(path.dirname(wrapperPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(wrapperPath, ps1Content, { mode: 0o700 });
  return wrapperPath;
}

function buildWindowsStartupTaskCommand(wrapperPath) {
  return `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${wrapperPath}"`;
}

function buildMacosLaunchAgent(options = {}) {
  const wrapperPath = writeMacosStartupWrapper(options);
  const args = [wrapperPath];
  const env = collectStartupEnv(options);
  const logDir = path.join(os.homedir(), 'Library', 'Logs', 'OpenChamber');
  const argXml = args.map((arg) => `    <string>${escapeXml(arg)}</string>`).join('\n');
  const envXml = Object.entries(env).length > 0
    ? `  <key>EnvironmentVariables</key>\n  <dict>\n${Object.entries(env).map(([key, value]) => `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`).join('\n')}\n  </dict>\n`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${STARTUP_SERVICE_ID}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
${envXml}  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${escapeXml(os.homedir())}</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(path.join(logDir, 'startup.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(path.join(logDir, 'startup.err.log'))}</string>
</dict>
</plist>
`;
}

function buildSystemdUserService(options = {}) {
  const args = buildStartupArgs(options).map((arg) => `"${systemdEscapeArg(arg)}"`).join(' ');
  const envFilePath = getStartupEnvFilePath();
  return `[Unit]
Description=OpenChamber web server
After=network-online.target

[Service]
Type=simple
EnvironmentFile=-${systemdEscapeArg(envFilePath)}
ExecStart="${systemdEscapeArg(process.execPath)}" ${args}
WorkingDirectory=${systemdUnitPath(os.homedir())}
Restart=always
RestartSec=5
# A graceful shutdown on SIGTERM exits 143; a stop is not a failure.
SuccessExitStatus=143

[Install]
WantedBy=default.target
`;
}

function runStartupCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
    timeout: options.timeout,
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 && options.allowFailure !== true) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function parseLingerState(stdout) {
  if (typeof stdout !== 'string') {
    return null;
  }
  const match = stdout.match(/^Linger=([A-Za-z]+)\s*$/m);
  if (!match) {
    return null;
  }
  const value = match[1].toLowerCase();
  if (value === 'yes') return true;
  if (value === 'no') return false;
  return null;
}

function getCurrentUsername() {
  try {
    const name = os.userInfo().username;
    if (typeof name === 'string' && name.length > 0) {
      return name;
    }
  } catch {
    // userInfo() can throw when the uid has no passwd entry; fall back to env.
  }
  return process.env.USER || process.env.LOGNAME || '';
}

// A systemd --user service only keeps running without an active login session
// when the user has lingering enabled. Detect it so `startup enable` can warn
// that the service may otherwise stop on logout. Returns null when the state
// cannot be determined (no username, loginctl unavailable, or odd output).
function getUserLingerEnabled(user) {
  if (!user) {
    return null;
  }
  let result;
  try {
    result = runStartupCommand('loginctl', ['show-user', user, '-p', 'Linger'], { allowFailure: true });
  } catch {
    return null;
  }
  if (result.status !== 0) {
    return null;
  }
  return parseLingerState(result.stdout);
}

function getStartupStatus() {
  const paths = getStartupServicePaths();
  if (!paths.servicePath) {
    return { supported: false, platform: paths.platform, enabled: false, servicePath: null };
  }
  if (paths.platform === 'windows') {
    const result = runStartupCommand('schtasks.exe', ['/Query', '/TN', STARTUP_SERVICE_ID], { allowFailure: true });
    return { supported: true, platform: paths.platform, enabled: result.status === 0, active: null, servicePath: paths.servicePath };
  }
  if (paths.platform === 'linux') {
    const enabledResult = runStartupCommand('systemctl', ['--user', 'is-enabled', 'openchamber.service'], { allowFailure: true });
    const activeResult = runStartupCommand('systemctl', ['--user', 'is-active', 'openchamber.service'], { allowFailure: true });
    const activeState = (activeResult.stdout || '').trim() || 'inactive';
    const lingerUser = getCurrentUsername();
    return {
      supported: true,
      platform: paths.platform,
      enabled: enabledResult.status === 0 || fs.existsSync(paths.servicePath),
      active: activeState === 'active',
      activeState,
      servicePath: paths.servicePath,
      lingerEnabled: getUserLingerEnabled(lingerUser),
      lingerUser: lingerUser || null,
    };
  }
  return {
    supported: true,
    platform: paths.platform,
    enabled: fs.existsSync(paths.servicePath),
    active: null,
    servicePath: paths.servicePath,
  };
}

// The pid systemd reports as the unit's MainPID, from `systemctl show` output.
function parseSystemdMainPid(stdout) {
  const pid = Number.parseInt(String(stdout || '').trim(), 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

// The pid launchd reports for a running job, from `launchctl list <label>`
// output. The `"PID"` key is absent while the job is not running.
function parseLaunchdJobPid(stdout) {
  const match = /^\s*"PID"\s*=\s*(\d+);/m.exec(String(stdout || ''));
  const pid = match ? Number.parseInt(match[1], 10) : null;
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

// The process id of the running startup service, or null when it is not
// running or startup integration here is not a service. systemd answers with
// the unit's MainPID; launchd reports the pid of the job it runs.
function getStartupServicePid() {
  if (process.platform === 'linux') {
    let result;
    try {
      result = runStartupCommand('systemctl', ['--user', 'show', '--property=MainPID', '--value', 'openchamber.service'], { allowFailure: true });
    } catch {
      return null;
    }
    return result.status === 0 ? parseSystemdMainPid(result.stdout) : null;
  }
  if (process.platform === 'darwin') {
    let result;
    try {
      result = runStartupCommand('/bin/launchctl', ['list', STARTUP_SERVICE_ID], { allowFailure: true });
    } catch {
      return null;
    }
    return result.status === 0 ? parseLaunchdJobPid(result.stdout) : null;
  }
  return null;
}

// Task Scheduler has no pid to ask for, so the task's processes are read from
// the task itself: its state, then the PowerShell wrapper running the task's
// own arguments, then that wrapper's children. A second process with the same
// command line cannot be told from the task's, so it reports no processes.
const WINDOWS_TASK_PROCESSES_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  `$task = Get-ScheduledTask -TaskPath "\\" -TaskName "${STARTUP_SERVICE_ID}"`,
  'if ($task.State -ne "Running") { "stopped"; exit 0 }',
  '$arguments = $task.Actions[0].Arguments',
  '$wrappers = @(Get-CimInstance Win32_Process -Filter "Name=\'powershell.exe\'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($arguments) })',
  'if ($wrappers.Count -ne 1) { "running"; exit 0 }',
  '$children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($wrappers[0].ProcessId)")',
  '"running " + (($children | ForEach-Object { $_.ProcessId }) -join " ")',
].join('\n');

// The pids the running task owns, from the script's output, or null when the
// task is not running. The wrapper's children include its console host, so the
// list is matched against the known instances.
function parseWindowsTaskProcesses(stdout) {
  const output = String(stdout || '').trim();
  if (output === 'stopped') {
    return null;
  }
  const match = /^running((?:\s+\d+)*)$/.exec(output);
  if (!match) {
    throw new Error(`unexpected task state: ${output || 'no output'}`);
  }
  return match[1].split(/\s+/).filter(Boolean).map(Number);
}

function windowsPowershellPath() {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function windowsPowershellArgs(script) {
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

function getWindowsTaskProcesses() {
  if (getStartupStatus().enabled !== true) {
    return null;
  }
  const result = runStartupCommand(windowsPowershellPath(), windowsPowershellArgs(WINDOWS_TASK_PROCESSES_SCRIPT), { allowFailure: true, timeout: 15000 });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || '').trim() || `PowerShell exited with ${result.status}`);
  }
  return parseWindowsTaskProcesses(result.stdout);
}

// Throws when the task is running and no instance can be matched to it: the
// update would otherwise stop the service as a plain CLI copy, or leave it on
// the old release. Discovery skips a server that does not answer its probe, so
// an empty list says nothing about the task.
function findWindowsTaskInstance(instances, getTaskProcesses) {
  let taskPids;
  try {
    taskPids = getTaskProcesses();
  } catch (error) {
    throw windowsTaskOwnershipError(error.message);
  }
  if (taskPids === null) {
    return null;
  }
  const instance = instances.find((candidate) => taskPids.includes(candidate.pid));
  if (!instance) {
    throw windowsTaskOwnershipError('the task is running, but none of the running servers is its process');
  }
  return instance;
}

function windowsTaskOwnershipError(detail) {
  return new Error(`Could not tell which running server belongs to the startup task: ${detail}. Nothing was stopped or installed. Run \`openchamber startup disable\`, update, then run \`openchamber startup enable\`.`);
}

// The instance a process manager will start again on its own, or null when
// none of the running instances is that one. systemd and launchd report a pid,
// and a null pid means the service is not running. Windows matches the running
// task's processes and throws when it cannot.
function findStartupServiceInstance(instances, {
  getPid = getStartupServicePid,
  getTaskProcesses = getWindowsTaskProcesses,
  platform = process.platform,
} = {}) {
  if (platform === 'win32') {
    return findWindowsTaskInstance(instances, getTaskProcesses);
  }
  const pid = getPid();
  return pid === null ? null : instances.find((instance) => instance.pid === pid) ?? null;
}

function restartSystemdService() {
  runStartupCommand('systemctl', ['--user', 'restart', 'openchamber.service']);
}

// Starts the task once the old server is gone and the task has stopped, and
// gives up after 30 seconds, longer than the restart below waits for the exit.
function buildWindowsTaskStartScript(serverPid) {
  return [
    '$deadline = (Get-Date).AddSeconds(30)',
    'while ((Get-Date) -lt $deadline) {',
    `  $serverGone = -not (Get-Process -Id ${serverPid} -ErrorAction SilentlyContinue)`,
    `  $task = Get-ScheduledTask -TaskPath "\\" -TaskName "${STARTUP_SERVICE_ID}" -ErrorAction SilentlyContinue`,
    '  if ($serverGone -and $task.State -ne "Running") {',
    `    schtasks.exe /Run /TN ${STARTUP_SERVICE_ID}`,
    '    exit $LASTEXITCODE',
    '  }',
    '  Start-Sleep -Milliseconds 250',
    '}',
  ].join('\n');
}

// The update may run in a terminal of this very server, and that terminal dies
// with it, so a detached process has to issue the `/Run`.
function startWindowsTaskAfterExit(serverPid, spawnProcess = spawn) {
  return new Promise((resolve, reject) => {
    const helper = spawnProcess(windowsPowershellPath(), windowsPowershellArgs(buildWindowsTaskStartScript(serverPid)), {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    helper.once('error', reject);
    helper.once('spawn', () => {
      helper.unref();
      resolve();
    });
  });
}

// A bare `/Run` on a running task is a no-op, and a `/Run` while the old server
// holds the port starts a process that cannot bind it, so the helper waits for
// the old server to be gone. `/End` stops the program the task started, which
// is the PowerShell wrapper, so the server can outlive it and is stopped by
// pid. `/End` comes first: after the server exits it would end the new run.
async function restartWindowsStartupTask(instance, {
  run = runStartupCommand,
  requestShutdown = requestServerShutdown,
  isRunning = isProcessRunning,
  stopProcess = stopInstanceProcess,
  startTaskAfterExit = startWindowsTaskAfterExit,
} = {}) {
  try {
    await startTaskAfterExit(instance.pid);
  } catch (error) {
    throw new Error(`Could not prepare the startup task restart: ${error.message}. The new version is installed. Run \`taskkill /PID ${instance.pid} /T /F\`, then \`schtasks /Run /TN ${STARTUP_SERVICE_ID}\`.`);
  }
  const ended = run('schtasks.exe', ['/End', '/TN', STARTUP_SERVICE_ID], { allowFailure: true });
  const requested = await requestShutdown(instance.port, instance.host);
  if (ended.status !== 0 && !requested && isRunning(instance.pid)) {
    const detail = (ended.stderr || ended.stdout || '').trim();
    throw new Error(`Could not end the startup task${detail ? `: ${detail}` : ''}. The new version is installed. Run \`schtasks /End /TN ${STARTUP_SERVICE_ID}\`, then \`schtasks /Run /TN ${STARTUP_SERVICE_ID}\`.`);
  }
  const exited = await stopProcess(instance.pid, {
    shutdownWaitMs: 5000,
    gracefulTimeoutMs: 2500,
    forceTimeoutMs: 3000,
  });
  if (!exited) {
    throw new Error(`The startup server (pid ${instance.pid}) did not exit, so the task was not started again. The new version is installed. Run \`taskkill /PID ${instance.pid} /T /F\`, then \`schtasks /Run /TN ${STARTUP_SERVICE_ID}\`.`);
  }
}

async function restartStartupService(instance) {
  const paths = getStartupServicePaths();
  if (paths.platform === 'macos') {
    runStartupCommand('/bin/launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${STARTUP_SERVICE_ID}`]);
    return;
  }
  if (paths.platform === 'windows') {
    await restartWindowsStartupTask(instance);
    return;
  }
  restartSystemdService();
}

function enableStartupService(options = {}) {
  const paths = getStartupServicePaths();
  if (!paths.servicePath) {
    throw new TunnelCliError(`Startup integration is not supported on ${paths.platform}.`, EXIT_CODE.USAGE_ERROR);
  }

  if (paths.platform === 'macos') {
    removeStartupEnvFile();
    fs.mkdirSync(path.dirname(paths.servicePath), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(os.homedir(), 'Library', 'Logs', 'OpenChamber'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(paths.servicePath, buildMacosLaunchAgent(options), { mode: 0o600 });
    runStartupCommand('/bin/launchctl', ['bootout', `gui/${process.getuid()}`, paths.servicePath], { allowFailure: true });
    runStartupCommand('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, paths.servicePath]);
    runStartupCommand('/bin/launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${STARTUP_SERVICE_ID}`], { allowFailure: true });
    return getStartupStatus();
  }

  if (paths.platform === 'linux') {
    writeStartupEnvFile(options, { quoteValue: systemdEnvFileQuote });
    fs.mkdirSync(path.dirname(paths.servicePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(paths.servicePath, buildSystemdUserService(options), { mode: 0o600 });
    runStartupCommand('systemctl', ['--user', 'daemon-reload']);
    runStartupCommand('systemctl', ['--user', 'enable', 'openchamber.service']);
    // `enable --now` leaves a running service alone, so it would keep the old
    // unit and the old release.
    restartSystemdService();
    return getStartupStatus();
  }

  writeStartupEnvFile(options);
  const wrapperPath = writeWindowsStartupWrapper(options);
  const taskCommand = buildWindowsStartupTaskCommand(wrapperPath);
  runStartupCommand('schtasks.exe', [
    '/Create',
    '/TN', STARTUP_SERVICE_ID,
    '/SC', 'ONLOGON',
    '/RL', 'LIMITED',
    '/F',
    '/TR', taskCommand,
  ]);
  runStartupCommand('schtasks.exe', ['/Run', '/TN', STARTUP_SERVICE_ID], { allowFailure: true });
  return getStartupStatus();
}

function disableStartupService() {
  const paths = getStartupServicePaths();
  if (!paths.servicePath) {
    throw new TunnelCliError(`Startup integration is not supported on ${paths.platform}.`, EXIT_CODE.USAGE_ERROR);
  }

  if (paths.platform === 'macos') {
    runStartupCommand('/bin/launchctl', ['bootout', `gui/${process.getuid()}`, paths.servicePath], { allowFailure: true });
    try { fs.unlinkSync(paths.servicePath); } catch {}
    return getStartupStatus();
  }

  if (paths.platform === 'linux') {
    runStartupCommand('systemctl', ['--user', 'disable', '--now', 'openchamber.service'], { allowFailure: true });
    try { fs.unlinkSync(paths.servicePath); } catch {}
    runStartupCommand('systemctl', ['--user', 'daemon-reload'], { allowFailure: true });
    return getStartupStatus();
  }

  runStartupCommand('schtasks.exe', ['/End', '/TN', STARTUP_SERVICE_ID], { allowFailure: true });
  runStartupCommand('schtasks.exe', ['/Delete', '/TN', STARTUP_SERVICE_ID, '/F'], { allowFailure: true });
  try { fs.unlinkSync(getWindowsStartupWrapperPath()); } catch {}
  removeStartupEnvFile();
  return getStartupStatus();
}


export {
  stablePnpmEntrypoint,
  buildSystemdUserService,
  getStartupStatus,
  parseSystemdMainPid,
  parseLaunchdJobPid,
  parseWindowsTaskProcesses,
  findStartupServiceInstance,
  startWindowsTaskAfterExit,
  restartWindowsStartupTask,
  restartStartupService,
  enableStartupService,
  disableStartupService,
  buildWindowsStartupTaskCommand,
};
