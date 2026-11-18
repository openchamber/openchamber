import { spawn, spawnSync } from 'child_process';
import type { SpawnOptions, SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns, ChildProcessByStdio } from 'child_process';
import type { Readable } from 'node:stream';
import fs from 'fs';
import {
  createExecutableSearchEnv,
  resolveExecutableLaunchTarget,
} from './tunnels/executable-search.js';
import { TUNNEL_MODE_FUNNEL, TunnelServiceError } from './tunnels/types.js';
import type { JsonValue } from './shared/json-values.js';

interface TailscaleTarget {
  command: string;
  env: NodeJS.ProcessEnv;
}

type TailscaleSpawnSync = (command: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => Pick<SpawnSyncReturns<string>, 'status' | 'stdout' | 'stderr'>;
type TailscaleChild = ChildProcessByStdio<null, Readable, Readable>;
type TailscaleSpawn = (command: string, args: string[], options: SpawnOptions & { stdio: ['ignore', 'pipe', 'pipe'] }) => TailscaleChild;

interface TailscaleCommandOptions {
  target: TailscaleTarget;
  spawnSyncImpl?: TailscaleSpawnSync;
}

interface TailscaleStartOptions {
  port: number | null | undefined;
  mode: string;
  httpsPort: number | undefined;
  target: TailscaleTarget;
  spawnImpl?: TailscaleSpawn;
  startupTimeoutMs?: number;
}

interface TailscaleOutput {
  publicUrl?: string;
  approvalUrl?: string;
}

const STARTUP_TIMEOUT_MS = 30000;
const COMMAND_TIMEOUT_MS = 10000;

const MAC_APP_CLI_PATH = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

const OPERATOR_HELP = 'Tailscale does not let this user share ports. Run: sudo tailscale set --operator=$USER';

const withCliEnv = (env: NodeJS.ProcessEnv) => ({ ...env, TAILSCALE_BE_CLI: '1' });

export function resolveTailscaleTarget({
  env = process.env,
  platform = process.platform,
  existsSync = fs.existsSync,
}: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  existsSync?: typeof fs.existsSync;
} = {}): TailscaleTarget | null {
  if (platform === 'darwin' && existsSync(MAC_APP_CLI_PATH)) {
    return { command: MAC_APP_CLI_PATH, env: withCliEnv(createExecutableSearchEnv({ env, platform })) };
  }
  const target = resolveExecutableLaunchTarget('tailscale', { env, platform });
  return target ? { command: target.command, env: withCliEnv(target.env) } : null;
}

const runTailscale = (target: TailscaleTarget, args: string[], spawnSyncImpl: TailscaleSpawnSync) => spawnSyncImpl(target.command, args, {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
  timeout: COMMAND_TIMEOUT_MS,
  env: target.env,
});

const outputOf = (result: Pick<SpawnSyncReturns<string>, 'stdout' | 'stderr'> | null | undefined) => `${result?.stdout || ''}${result?.stderr || ''}`.trim();

export function checkTailscaleAvailable({ target = resolveTailscaleTarget(), spawnSyncImpl = spawnSync }: {
  target?: TailscaleTarget | null;
  spawnSyncImpl?: TailscaleSpawnSync;
} = {}) {
  if (!target) {
    return { available: false, path: null, version: null };
  }
  const result = runTailscale(target, ['version'], spawnSyncImpl);
  if (result.status !== 0) {
    return { available: false, path: target.command, version: null };
  }
  return { available: true, path: target.command, version: outputOf(result).split('\n')[0] || null };
}

export function checkTailscaleRunning({ target, spawnSyncImpl = spawnSync }: TailscaleCommandOptions) {
  const result = runTailscale(target, ['status', '--json'], spawnSyncImpl);
  let state: JsonValue = '';
  try {
    const status: { BackendState?: JsonValue } = JSON.parse(result.stdout || '{}');
    state = status.BackendState || '';
  } catch {
    state = '';
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

export function readTailscaleOutput(text: string): TailscaleOutput {
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

const lastOutputLine = (output: string) => {
  const line = output.trim().split('\n').pop()?.trim();
  return line ? `: ${line}` : '';
};

export async function startTailscaleTunnel({
  port,
  mode,
  httpsPort,
  target,
  spawnImpl = spawn,
  startupTimeoutMs = STARTUP_TIMEOUT_MS,
}: TailscaleStartOptions) {
  const child = spawnImpl(target.command, [mode, `--https=${httpsPort}`, `http://127.0.0.1:${port}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: target.env,
  });

  let publicUrl: string | null = null;
  let output = '';
  const stop = () => {
    publicUrl = null;
    try {
      child.kill('SIGINT');
    } catch {
      return;
    }
  };

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    const finish = (error?: Error) => {
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

    const onOutput = (chunk: Buffer | string) => {
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
