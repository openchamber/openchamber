import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
// A gpgconf that never answers (a locked gpg-agent, a smartcard prompt)
// must not wedge every Git command: buildGitEnv resolves the SSH socket
// per command, before Git's own probe timeouts can apply (#862).
const GPGCONF_TIMEOUT_MS = 5_000;
const GPGCONF_MAX_BUFFER = 1024 * 1024;
const gpgconfCandidates = ['gpgconf', '/opt/homebrew/bin/gpgconf', '/usr/local/bin/gpgconf'];
const gpgAgentLaunchesWithoutSocket = new Set<string>();

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

  const runGpgconf = async (args: string[]) => {
    for (const candidate of gpgconfCandidates) {
      try {
        const { stdout } = await execFileAsync(candidate, args, { timeout: GPGCONF_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: GPGCONF_MAX_BUFFER });
        return String(stdout || '');
      } catch {
        continue;
      }
    }
    return '';
  };

  const candidate = (await runGpgconf(['--list-dirs', 'agent-ssh-socket'])).trim();
  if (candidate && await isSocketPath(candidate)) {
    return candidate;
  }

  if (candidate && !gpgAgentLaunchesWithoutSocket.has(candidate)) {
    await runGpgconf(['--launch', 'gpg-agent']);
    const retried = (await runGpgconf(['--list-dirs', 'agent-ssh-socket'])).trim();
    if (retried && await isSocketPath(retried)) {
      return retried;
    }
    gpgAgentLaunchesWithoutSocket.add(candidate);
  }

  return null;
};
