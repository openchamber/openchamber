import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import {
  createExecutableSearchEnv,
  resolveExecutableLaunchTarget,
} from './tunnels/executable-search.js';
import { TUNNEL_MODE_FUNNEL, TunnelServiceError } from './tunnels/types.js';

const STARTUP_TIMEOUT_MS = 30000;
const COMMAND_TIMEOUT_MS = 10000;

// The Mac App Store and Standalone apps keep the CLI inside the app bundle.
// Their "CLI integration" puts a /bin/sh wrapper on PATH that runs the binary
// as its child, so a signal to the wrapper never reaches Tailscale and the
// tunnel would outlive Stop. The bundle binary is therefore run directly.
const MAC_APP_CLI_PATH = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

const OPERATOR_HELP = 'Tailscale does not let this user share ports. Run: sudo tailscale set --operator=$USER';

// The macOS app binary picks between opening its window and acting as the CLI
// by looking at terminal variables, which a desktop app's child process lacks.
const withCliEnv = (env) => ({ ...env, TAILSCALE_BE_CLI: '1' });

export function resolveTailscaleTarget({
  env = process.env,
  platform = process.platform,
  existsSync = fs.existsSync,
} = {}) {
  if (platform === 'darwin' && existsSync(MAC_APP_CLI_PATH)) {
    return { command: MAC_APP_CLI_PATH, env: withCliEnv(createExecutableSearchEnv({ env, platform })) };
  }
  const target = resolveExecutableLaunchTarget('tailscale', { env, platform });
  return target ? { command: target.command, env: withCliEnv(target.env) } : null;
}

const runTailscale = (target, args, spawnSyncImpl) => spawnSyncImpl(target.command, args, {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
  timeout: COMMAND_TIMEOUT_MS,
  env: target.env,
});

const outputOf = (result) => `${result?.stdout || ''}${result?.stderr || ''}`.trim();

export function checkTailscaleAvailable({ target = resolveTailscaleTarget(), spawnSyncImpl = spawnSync } = {}) {
  if (!target) {
    return { available: false, path: null, version: null };
  }
  const result = runTailscale(target, ['version'], spawnSyncImpl);
  if (result.status !== 0) {
    return { available: false, path: target.command, version: null };
  }
  return { available: true, path: target.command, version: outputOf(result).split('\n')[0] || null };
}

// BackendState names come from tailscale/ipn/backend.go.
export function checkTailscaleRunning({ target, spawnSyncImpl = spawnSync }) {
  const result = runTailscale(target, ['status', '--json'], spawnSyncImpl);
  let state = '';
  try {
    state = JSON.parse(result.stdout || '{}').BackendState || '';
  } catch {
    // Not JSON: the CLI could not reach tailscaled and printed why.
  }
  if (state === 'Running') {
    return { ready: true, detail: 'Tailscale is running and signed in.' };
  }
  if (state === 'NeedsLogin' || state === 'NeedsMachineAuth') {
    return { ready: false, detail: 'Tailscale is not signed in. Open Tailscale and sign in.' };
  }
  if (state === 'Stopped') {
    return { ready: false, detail: 'Tailscale is turned off. Turn it on and try again.' };
  }
  if (state) {
    return { ready: false, detail: `Tailscale is not ready (${state}).` };
  }
  const output = outputOf(result);
  return { ready: false, detail: `Tailscale is not running${output ? `: ${output}` : '.'}` };
}

// The CLI prints the address under "Available within your tailnet:" or
// "Available on the internet:"; it is always on the tailnet's ts.net domain.
// Before HTTPS or Funnel is on for the tailnet, it prints an approval link
// (seen live as https://login.tailscale.com/f/serve?node=...) and waits for
// the user to open it. Any other link, such as a notice, is skipped.
export function readTailscaleOutput(text) {
  for (const match of text.matchAll(/https:\/\/[^\s"'<>]+/gi)) {
    let url;
    try {
      url = new URL(match[0]);
    } catch {
      continue;
    }
    if (url.hostname.endsWith('.ts.net')) {
      return { publicUrl: url.origin };
    }
    if (url.pathname.startsWith('/f/')) {
      return { approvalUrl: url.href };
    }
  }
  return {};
}

const lastOutputLine = (output) => {
  const line = output.trim().split('\n').pop()?.trim();
  return line ? `: ${line}` : '';
};

// Runs `tailscale serve|funnel` in the foreground. Tailscale ties a foreground
// config to the CLI's session and drops it when the process ends, so stopping
// the child is the whole cleanup on every platform.
export async function startTailscaleTunnel({
  port,
  mode,
  httpsPort,
  target,
  spawnImpl = spawn,
  startupTimeoutMs = STARTUP_TIMEOUT_MS,
}) {
  const child = spawnImpl(target.command, [mode, `--https=${httpsPort}`, `http://127.0.0.1:${port}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: target.env,
  });

  let publicUrl = null;
  let output = '';
  const stop = () => {
    publicUrl = null;
    try {
      child.kill('SIGINT');
    } catch {
      // Already exited.
    }
  };

  await new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        stop();
        reject(error);
      } else {
        resolve();
      }
    };

    const onOutput = (chunk) => {
      output = `${output}${chunk}`.slice(-8192);
      if (/serve config denied/i.test(output)) {
        finish(new Error(OPERATOR_HELP));
        return;
      }
      const found = readTailscaleOutput(output);
      if (found.approvalUrl) {
        const feature = mode === TUNNEL_MODE_FUNNEL ? 'Funnel' : 'HTTPS';
        finish(new TunnelServiceError(
          'approval_required',
          `Turn on ${feature} for your tailnet at ${found.approvalUrl}, then start the tunnel again.`,
          { approvalUrl: found.approvalUrl },
        ));
        return;
      }
      if (found.publicUrl) {
        publicUrl = found.publicUrl;
        finish();
      }
    };

    child.stdout.on('data', onOutput);
    child.stderr.on('data', onOutput);
    child.once('error', (error) => finish(new Error(`Could not run Tailscale: ${error.message}`)));
    child.once('exit', () => {
      publicUrl = null;
      finish(new Error(`Tailscale ${mode} stopped before it was ready${lastOutputLine(output)}`));
    });
    timer = setTimeout(() => {
      finish(new Error(`Tailscale ${mode} gave no address within ${startupTimeoutMs / 1000} seconds${lastOutputLine(output)}`));
    }, startupTimeoutMs);
  });

  return {
    mode,
    httpsPort,
    process: child,
    stop,
    getPublicUrl: () => publicUrl,
  };
}
