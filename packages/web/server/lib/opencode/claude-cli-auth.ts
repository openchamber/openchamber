import { spawnSync } from 'node:child_process';

export interface ClaudeCliAuthOptions {
  spawnSyncFn?: typeof spawnSync;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

const hasLoggedIn = (value: unknown): value is { loggedIn?: unknown } => value != null;

const readStatus = (spawnSyncFn: typeof spawnSync, command: string, env: NodeJS.ProcessEnv) => spawnSyncFn(command, ['auth', 'status', '--json'], {
  encoding: 'utf8',
  timeout: 6000,
  env,
  windowsHide: true,
});

const resolveFromLoginShell = (spawnSyncFn: typeof spawnSync, env: NodeJS.ProcessEnv, platform: NodeJS.Platform) => {
  if (platform === 'win32') {
    const result = spawnSyncFn('where', ['claude'], {
      encoding: 'utf8',
      timeout: 6000,
      env,
      windowsHide: true,
    });
    return `${result.stdout || ''}`.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null;
  }

  const shell = env.SHELL || '/bin/zsh';
  const result = spawnSyncFn(shell, ['-lic', 'command -v claude'], {
    encoding: 'utf8',
    timeout: 6000,
    env,
    windowsHide: true,
  });
  return `${result.stdout || ''}`.trim().split(/\s+/).pop() || null;
};

export const getClaudeCliAuthStatus = ({
  spawnSyncFn = spawnSync,
  env = process.env,
  platform = process.platform,
}: ClaudeCliAuthOptions = {}) => {
  const childEnv = { ...env };
  delete childEnv.ANTHROPIC_API_KEY;
  delete childEnv.ANTHROPIC_AUTH_TOKEN;
  delete childEnv.CLAUDE_CODE_OAUTH_TOKEN;

  try {
    let result = readStatus(spawnSyncFn, 'claude', childEnv);
    if (!`${result.stdout || ''}`.trim() && result.error) {
      const resolved = resolveFromLoginShell(spawnSyncFn, childEnv, platform);
      if (resolved) result = readStatus(spawnSyncFn, resolved, childEnv);
    }
    const output = `${result.stdout || ''}`.trim();
    if (!output) return { connected: false, reason: 'empty-status' };
    const parsed: unknown = JSON.parse(output);
    const payload = hasLoggedIn(parsed) ? parsed : undefined;
    return {
      connected: payload?.loggedIn === true,
      reason: payload?.loggedIn === true ? 'logged-in' : 'logged-out',
    };
  } catch (error) {
    return {
      connected: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
};
