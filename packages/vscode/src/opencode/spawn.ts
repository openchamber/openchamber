import * as net from 'net';
import { spawn } from 'child_process';
import { applyProviderEnvAliases } from '../provider-env-aliases';
import { registerManagedProcess, unregisterManagedProcess } from '../opencodeProcessRegistry';
import {
  isMacOpenCodeAppBundlePath,
  resolveWindowsLaunchSpec,
  stripWrappingQuotes,
} from './cli-discovery';

export async function spawnManagedOpenCodeServer(
  workingDirectory: string,
  port: number,
  timeoutMs: number
): Promise<{ url: string; close: () => void }> {
  const binary = stripWrappingQuotes(process.env.OPENCODE_BINARY || 'opencode') || 'opencode';
  const launch = resolveWindowsLaunchSpec(binary, ['serve', '--hostname', '127.0.0.1', '--port', String(port)]);
  const child = spawn(launch.binary, launch.args, {
    cwd: workingDirectory,
    env: applyProviderEnvAliases({ ...process.env }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const url = await new Promise<string>((resolve, reject) => {
    let output = '';
    let settled = false;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off('data', onStdout);
      child.stderr?.off('data', onStderr);
      child.off('exit', onExit);
      child.off('error', onError);
    };

    const onStdout = (chunk: Buffer) => {
      output += chunk.toString();
      const lines = output.split('\n');
      for (const line of lines) {
        if (!line.startsWith('opencode server listening')) continue;
        const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
        if (!match) {
          cleanup();
          reject(new Error(`Failed to parse server url from output: ${line}`));
          return;
        }
        cleanup();
        resolve(match[1]);
        return;
      }
    };

    const onStderr = (chunk: Buffer) => {
      output += chunk.toString();
    };

    const onExit = (code: number | null) => {
      cleanup();
      const appBundleHint = isMacOpenCodeAppBundlePath(binary)
        ? ' The configured binary appears to point at the macOS desktop app bundle; OpenChamber needs the standalone opencode CLI.'
        : '';
      reject(new Error(`OpenCode process exited before serving with code ${code}. Binary used: ${binary}.${appBundleHint} Output: ${output}`));
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const timer = setTimeout(() => {
      cleanup();
      // Surface whatever OpenCode printed while we waited — otherwise a hung or
      // misconfigured start is indistinguishable from a slow one in the status
      // report, leaving no thread to pull on.
      const trimmedOutput = output.trim();
      const outputHint = trimmedOutput ? ` Output: ${trimmedOutput}` : ' Output: (none — process printed nothing)';
      reject(new Error(`Timeout waiting for server to start after ${timeoutMs}ms.${outputHint}`));
    }, timeoutMs);

    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.on('exit', onExit);
    child.on('error', onError);
  });

  // Record this child so a future run can reap it if we crash before teardown.
  registerManagedProcess({ pid: child.pid, ownerPid: process.pid, port, binary, runtime: 'vscode' });

  return {
    url,
    close: () => {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      unregisterManagedProcess(child.pid);
    },
  };
}

export async function allocateManagedOpenCodePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once('error', (error) => {
      reject(error);
    });

    server.once('listening', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close(() => {
        if (port > 0) {
          resolve(port);
          return;
        }
        reject(new Error('Failed to allocate OpenCode port'));
      });
    });

    server.listen(0, '127.0.0.1');
  });
}
