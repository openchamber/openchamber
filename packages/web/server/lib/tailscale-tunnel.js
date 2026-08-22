import { spawn, spawnSync } from 'child_process';
import {
  createExecutableSearchEnv,
  resolveExecutableLaunchTarget,
} from './tunnels/executable-search.js';
import { getTunnelDependencyInstallInfo } from './tunnels/install-help.js';
import {
  TAILSCALE_DEFAULT_HTTPS_PORT,
  TAILSCALE_HTTPS_PORTS,
  TUNNEL_MODE_PRIVATE_NETWORK,
  TUNNEL_MODE_QUICK,
  TUNNEL_PROVIDER_TAILSCALE,
  normalizeTailscaleHttpsPort,
} from './tunnels/types.js';

const DEFAULT_TAILSCALE_STARTUP_TIMEOUT_MS = 30000;
const DEFAULT_TAILSCALE_COMMAND_TIMEOUT_MS = 10000;

const TAILSCALE_URL_REGEX = /https:\/\/[a-z0-9.-]+\.ts\.net(?:[^\s"'`<>]*)?/gi;
const getErrorMessage = (error) => (error instanceof Error ? error.message : String(error));
const getOutput = (result) => `${result?.stdout || ''}${result?.stderr || ''}`.trim();
const normalizeCommandTimeoutMs = (value) => Number.isFinite(value) && value > 0
  ? Math.floor(value)
  : DEFAULT_TAILSCALE_COMMAND_TIMEOUT_MS;
const isTimeoutResult = (result) => result?.error?.code === 'ETIMEDOUT'
  || /timed out|timeout/i.test(getErrorMessage(result?.error || result));

const getInstallInfo = () => getTunnelDependencyInstallInfo(TUNNEL_PROVIDER_TAILSCALE);

const permissionError = (error, output = '') => (
  error?.code === 'EACCES'
  || error?.code === 'EPERM'
  || /permission denied|operation not permitted|eacces|eperm/i.test(output)
);

const formatCommandFailure = (command, result, timeoutMs) => {
  if (isTimeoutResult(result)) {
    return `${command} timed out after ${timeoutMs}ms.`;
  }
  const output = getOutput(result);
  if (permissionError(result?.error, output)) {
    return `Unable to run '${command}': permission denied${output ? ` (${output})` : ''}`;
  }
  return `${command} failed${output ? `: ${output}` : result?.error ? `: ${getErrorMessage(result.error)}` : '.'}`;
};

const resolveTarget = ({
  tailscalePath = null,
  target = null,
  resolveExecutableLaunchTargetImpl = resolveExecutableLaunchTarget,
  env = process.env,
} = {}) => target || (tailscalePath
  ? { command: tailscalePath, env: createExecutableSearchEnv({ env }) }
  : resolveExecutableLaunchTargetImpl('tailscale', { env }));

export async function checkTailscaleAvailable({
  resolveExecutableLaunchTargetImpl = resolveExecutableLaunchTarget,
  spawnSyncImpl = spawnSync,
  commandTimeoutMs = DEFAULT_TAILSCALE_COMMAND_TIMEOUT_MS,
  env = process.env,
} = {}) {
  const timeoutMs = normalizeCommandTimeoutMs(commandTimeoutMs);
  const installInfo = getInstallInfo();
  const target = resolveTarget({ resolveExecutableLaunchTargetImpl, env });
  if (!target) {
    return {
      available: false,
      path: null,
      version: null,
      ...installInfo,
    };
  }

  try {
    const result = spawnSyncImpl(target.command, ['version'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: timeoutMs,
      env: target.env,
    });
    const output = getOutput(result);
    if (result?.status === 0 && !result?.error) {
      return {
        available: true,
        path: target.command,
        version: output || null,
        env: target.env,
      };
    }
    const detail = formatCommandFailure('tailscale version', result, timeoutMs);
    return {
      available: false,
      path: target.command,
      version: null,
      blocker: isTimeoutResult(result)
        ? 'timeout'
        : permissionError(result?.error, output) ? 'permission' : 'version',
      message: detail,
      installUrl: installInfo.installUrl,
      installCommand: installInfo.installCommand,
      env: target.env,
    };
  } catch (error) {
    const detail = isTimeoutResult({ error })
      ? `tailscale version timed out after ${timeoutMs}ms.`
      : permissionError(error)
        ? `Unable to run 'tailscale version': permission denied (${getErrorMessage(error)})`
        : `Unable to run 'tailscale version': ${getErrorMessage(error)}`;
    return {
      available: false,
      path: target.command,
      version: null,
      blocker: isTimeoutResult({ error }) ? 'timeout' : permissionError(error) ? 'permission' : 'version',
      message: detail,
      installUrl: installInfo.installUrl,
      installCommand: installInfo.installCommand,
      env: target.env,
    };
  }
}

function normalizeTailscalePublicUrl(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }
  const candidate = value.trim().replace(/[),.;!?]+$/, '');
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:' || !/\.ts\.net$/i.test(parsed.hostname)) {
      return null;
    }
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

export function extractTailscalePublicUrlFromText(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return null;
  }
  for (const match of text.matchAll(TAILSCALE_URL_REGEX)) {
    const url = normalizeTailscalePublicUrl(match[0]);
    if (url) {
      return url;
    }
  }
  return null;
}

const classifyStatusFailure = (result, command = 'tailscale status --json', timeoutMs = DEFAULT_TAILSCALE_COMMAND_TIMEOUT_MS) => {
  if (isTimeoutResult(result)) {
    return {
      ready: false,
      blocker: 'timeout',
      detail: `${command} timed out after ${timeoutMs}ms.`,
    };
  }
  const output = getOutput(result);
  if (permissionError(result?.error, output)) {
    return {
      ready: false,
      blocker: 'permission',
      detail: `Tailscale status permission denied. Ensure the current user can access tailscaled${output ? `: ${output}` : '.'}`,
    };
  }
  if (/failed to connect|not running|no such file|daemon|socket/i.test(output)) {
    return {
      ready: false,
      blocker: 'daemon',
      detail: `Tailscale daemon is unavailable. Start tailscaled and retry${output ? `: ${output}` : '.'}`,
    };
  }
  return {
    ready: false,
    blocker: 'status',
    detail: formatCommandFailure(command, result, timeoutMs),
  };
};

export async function checkTailscaleStatus({
  tailscalePath = null,
  target = null,
  resolveExecutableLaunchTargetImpl = resolveExecutableLaunchTarget,
  spawnSyncImpl = spawnSync,
  commandTimeoutMs = DEFAULT_TAILSCALE_COMMAND_TIMEOUT_MS,
  env = process.env,
} = {}) {
  const timeoutMs = normalizeCommandTimeoutMs(commandTimeoutMs);
  const resolvedTarget = resolveTarget({
    tailscalePath,
    target,
    resolveExecutableLaunchTargetImpl,
    env,
  });
  if (!resolvedTarget) {
    return {
      ready: false,
      blocker: 'install',
      detail: getInstallInfo().message,
    };
  }

  let result;
  try {
    result = spawnSyncImpl(resolvedTarget.command, ['status', '--json'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: timeoutMs,
      env: resolvedTarget.env,
    });
  } catch (error) {
    return classifyStatusFailure({ error }, 'tailscale status --json', timeoutMs);
  }

  if (result?.error || result?.status !== 0) {
    return classifyStatusFailure(result, 'tailscale status --json', timeoutMs);
  }

  const rawStatus = typeof result?.stdout === 'string' ? result.stdout.trim() : '';
  let status;
  try {
    status = JSON.parse(rawStatus);
  } catch (error) {
    return {
      ready: false,
      blocker: 'status',
      detail: `Tailscale returned invalid status JSON: ${getErrorMessage(error)}${rawStatus ? ` (${rawStatus})` : ''}`,
    };
  }

  const backendState = typeof status?.BackendState === 'string'
    ? status.BackendState
    : typeof status?.backendState === 'string'
      ? status.backendState
      : '';
  const normalizedState = backendState.toLowerCase();
  if (normalizedState === 'running') {
    return {
      ready: true,
      blocker: null,
      state: backendState,
      detail: 'Tailscale daemon is running and authenticated.',
      status,
    };
  }
  if (/needslogin|needsmachineauth|needsunlock|login|auth/.test(normalizedState)) {
    return {
      ready: false,
      blocker: 'login',
      state: backendState || null,
      detail: "Tailscale is not authenticated. Run 'tailscale up' to log in and authorize this machine.",
      status,
    };
  }
  if (!backendState || /nostate|stopped|starting|stopping|offline/.test(normalizedState)) {
    return {
      ready: false,
      blocker: 'daemon',
      state: backendState || null,
      detail: `Tailscale daemon is not ready${backendState ? ` (state: ${backendState})` : ''}. Start tailscaled and retry.`,
      status,
    };
  }
  return {
    ready: false,
    blocker: 'status',
    state: backendState,
    detail: `Tailscale reported an unsupported backend state: ${backendState}.`,
    status,
  };
}

const summarizeOutput = (output) => output.trim().replace(/\s+/g, ' ').slice(-1000);
const formatStartupFailure = (verb, frontendPort, output) => {
  if (/listener already exists for port\s+\d+/i.test(output)) {
    const alternatives = verb === 'funnel'
      ? TAILSCALE_HTTPS_PORTS.filter((port) => port !== frontendPort).join(', ')
      : '1 to 65535';
    const portHint = verb === 'funnel'
      ? `another allowed port (${alternatives})`
      : 'another port from 1 to 65535';
    return `Tailscale ${verb} could not use HTTPS frontend port ${frontendPort}: a listener already exists. Stop the existing service or try ${portHint}.`;
  }
  return `Tailscale ${verb} failed${output ? `: ${summarizeOutput(output)}` : ''}`;
};

export async function startTailscaleTunnel({
  port,
  mode = TUNNEL_MODE_PRIVATE_NETWORK,
  tailscaleHttpsPort = TAILSCALE_DEFAULT_HTTPS_PORT,
  tailscalePath = null,
  spawnImpl = spawn,
  availabilityCheck = checkTailscaleAvailable,
  statusCheck = checkTailscaleStatus,
  resolveExecutableLaunchTargetImpl = resolveExecutableLaunchTarget,
  spawnSyncImpl = spawnSync,
  startupTimeoutMs = DEFAULT_TAILSCALE_STARTUP_TIMEOUT_MS,
  commandTimeoutMs = DEFAULT_TAILSCALE_COMMAND_TIMEOUT_MS,
  env = process.env,
} = {}) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid Tailscale tunnel port: ${port}`);
  }
  if (mode !== TUNNEL_MODE_PRIVATE_NETWORK && mode !== TUNNEL_MODE_QUICK) {
    throw new Error(`Tailscale does not support '${mode}' mode`);
  }
  const frontendPort = normalizeTailscaleHttpsPort(tailscaleHttpsPort);
  const modeName = mode === TUNNEL_MODE_QUICK ? 'Funnel' : 'Serve';
  if (frontendPort === null) {
    throw new Error(`Invalid Tailscale ${modeName} HTTPS frontend port: ${tailscaleHttpsPort}. Must be an integer from 1 to 65535.`);
  }
  if (mode === TUNNEL_MODE_QUICK && !TAILSCALE_HTTPS_PORTS.includes(frontendPort)) {
    throw new Error(`Invalid Tailscale Funnel HTTPS frontend port: ${frontendPort}. Allowed ports: ${TAILSCALE_HTTPS_PORTS.join(', ')}`);
  }

  const dependency = tailscalePath
    ? { available: true, path: tailscalePath, env: createExecutableSearchEnv({ env }) }
    : await availabilityCheck({ resolveExecutableLaunchTargetImpl, spawnSyncImpl, commandTimeoutMs, env });
  if (!dependency?.available) {
    throw new Error(dependency?.message || getInstallInfo().message);
  }

  let status;
  try {
    status = await statusCheck({
      tailscalePath: dependency.path,
      target: dependency.target,
      resolveExecutableLaunchTargetImpl,
      spawnSyncImpl,
      commandTimeoutMs,
      env,
    });
  } catch (error) {
    throw new Error(`Tailscale status check failed: ${getErrorMessage(error)}`);
  }
  if (!status?.ready) {
    throw new Error(status?.detail || 'Tailscale is not ready to start a tunnel.');
  }

  const verb = mode === TUNNEL_MODE_QUICK ? 'funnel' : 'serve';
  const args = [verb, `--https=${frontendPort}`, String(port)];
  const command = dependency.path || resolveExecutableLaunchTargetImpl('tailscale', { env })?.command || 'tailscale';
  const childEnv = dependency.env || createExecutableSearchEnv({ env });
  let child;
  try {
    child = spawnImpl(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: childEnv,
      killSignal: 'SIGINT',
    });
  } catch (error) {
    throw new Error(`Failed to start Tailscale ${verb}: ${getErrorMessage(error)}`);
  }
  if (!child || typeof child.on !== 'function') {
    throw new Error(`Failed to start Tailscale ${verb}: child process was not created`);
  }

  let publicUrl = null;
  let output = '';
  let stopped = false;
  let exited = false;
  let settled = false;
  let timeout;
  const appendOutput = (chunk) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
    if (!text) {
      return;
    }
    output = `${output}${text}`.slice(-8192);
    const url = extractTailscalePublicUrlFromText(output);
    if (url && !settled) {
      publicUrl = url;
      settled = true;
    }
  };
  const stopChild = () => {
    if (stopped || exited) {
      return;
    }
    stopped = true;
    publicUrl = null;
    try {
      child.kill?.('SIGINT');
    } catch {
      // The child may have exited between readiness and cleanup.
    }
  };

  child.stdout?.on?.('data', appendOutput);
  child.stderr?.on?.('data', appendOutput);

  const controller = await new Promise((resolve, reject) => {
    let resolved = false;
    const cleanup = ({ keepProcessListeners = false } = {}) => {
      clearTimeout(timeout);
      if (!keepProcessListeners) {
        child.removeListener?.('error', onError);
        child.removeListener?.('exit', onExit);
        child.removeListener?.('close', onClose);
      }
    };
    const resolveReady = () => {
      if (resolved) {
        return;
      }
      resolved = true;
      cleanup({ keepProcessListeners: true });
      resolve({
        mode,
        process: child,
        stop: stopChild,
        getPublicUrl: () => publicUrl,
      });
    };
    const rejectStartup = (error, shouldStop = true) => {
      if (resolved) {
        return;
      }
      resolved = true;
      cleanup();
      if (shouldStop) {
        stopChild();
      }
      reject(error);
    };
    const onData = () => {
      if (publicUrl && !resolved) {
        resolveReady();
      }
    };
    const onError = (error) => {
      if (resolved) {
        publicUrl = null;
        cleanup();
        return;
      }
      rejectStartup(new Error(`${formatStartupFailure(verb, frontendPort, output)}${getErrorMessage(error) ? ` (${getErrorMessage(error)})` : ''}`));
    };
    const onExit = (code, signal) => {
      exited = true;
      if (resolved) {
        publicUrl = null;
        cleanup();
        return;
      }
      rejectStartup(
        new Error(`${formatStartupFailure(verb, frontendPort, output)} (exited before emitting a public URL; code ${code ?? 'unknown'}, signal ${signal ?? 'none'})`),
        false,
      );
    };
    const onClose = (code, signal) => onExit(code, signal);

    child.stdout?.on?.('data', onData);
    child.stderr?.on?.('data', onData);
    child.on('error', onError);
    child.on('exit', onExit);
    child.on('close', onClose);
    timeout = setTimeout(() => {
      rejectStartup(new Error(`${formatStartupFailure(verb, frontendPort, output)} (timed out waiting for a public URL)`));
    }, startupTimeoutMs);

    if (publicUrl) {
      resolveReady();
    }
  });

  return controller;
}
