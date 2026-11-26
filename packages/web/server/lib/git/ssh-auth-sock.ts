import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const gpgconfCandidates = ['gpgconf', '/opt/homebrew/bin/gpgconf', '/usr/local/bin/gpgconf'];
const GPGCONF_TIMEOUT_MS = 5_000;
const gpgAgentLaunchesWithoutSocket = new Set<string>();
const gpgAgentLaunchesInFlight = new Map<string, Promise<string | null>>();

type GpgconfResult = { status: 'ok'; stdout: string } | { status: 'failed' } | { status: 'timed-out' };

const isSocketPath = async (candidate: string) => {
  if (!candidate) {
    return false;
  }
  try {
    const stat = await fs.promises.stat(candidate);
    return stat.isSocket();
  } catch {
    return false;
  }
};

const killProcessGroup = (pid: number | undefined) => {
  if (!pid) {
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    return;
  }
};

const runGpgconfCandidate = (command: string, args: string[]) => new Promise<GpgconfResult>((resolve) => {
  let settled = false;
  let stdout = '';
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(command, args, { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    resolve({ status: 'failed' });
    return;
  }
  const settle = (result: GpgconfResult) => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(deadline);
    resolve(result);
  };
  const deadline = setTimeout(() => {
    killProcessGroup(child.pid);
    child.stdout?.destroy();
    settle({ status: 'timed-out' });
  }, GPGCONF_TIMEOUT_MS);
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.once('error', () => settle({ status: 'failed' }));
  child.once('close', (code) => settle(code === 0 ? { status: 'ok', stdout } : { status: 'failed' }));
});

const runGpgconf = async (args: string[]) => {
  for (const candidate of gpgconfCandidates) {
    const result = await runGpgconfCandidate(candidate, args);
    if (result.status === 'ok') {
      return result.stdout;
    }
    if (result.status === 'timed-out') {
      return '';
    }
  }
  return '';
};

const launchGpgAgent = async (candidate: string) => {
  await runGpgconf(['--launch', 'gpg-agent']);
  const retried = (await runGpgconf(['--list-dirs', 'agent-ssh-socket'])).trim();
  if (retried && await isSocketPath(retried)) {
    return retried;
  }
  gpgAgentLaunchesWithoutSocket.add(candidate);
  return null;
};

export const resolveSshAuthSock = async () => {
  const existing = (process.env.SSH_AUTH_SOCK || '').trim();
  if (existing) {
    return existing;
  }

  if (process.platform === 'win32') {
    return null;
  }

  const gpgSock = path.join(os.homedir(), '.gnupg', 'S.gpg-agent.ssh');
  if (await isSocketPath(gpgSock)) {
    return gpgSock;
  }

  const candidate = (await runGpgconf(['--list-dirs', 'agent-ssh-socket'])).trim();
  if (candidate && await isSocketPath(candidate)) {
    return candidate;
  }

  if (!candidate || gpgAgentLaunchesWithoutSocket.has(candidate)) {
    return null;
  }

  let launch = gpgAgentLaunchesInFlight.get(candidate);
  if (!launch) {
    launch = launchGpgAgent(candidate).finally(() => gpgAgentLaunchesInFlight.delete(candidate));
    gpgAgentLaunchesInFlight.set(candidate, launch);
  }
  return launch;
};
