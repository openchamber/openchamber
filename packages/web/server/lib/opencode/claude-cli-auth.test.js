import { describe, expect, test } from 'bun:test';

import { getClaudeCliAuthStatus } from './claude-cli-auth.js';

describe('getClaudeCliAuthStatus', () => {
  test('reports the authoritative Claude CLI login state', () => {
    let invocation = null;
    const status = getClaudeCliAuthStatus({
      env: {
        PATH: '/usr/bin',
        CLAUDE_CODE_OAUTH_TOKEN: 'must-not-leak',
      },
      spawnSyncFn(command, args, options) {
        invocation = { command, args, options };
        return { stdout: JSON.stringify({ loggedIn: true, authMethod: 'oauth' }) };
      },
    });

    expect(status).toEqual({ connected: true, reason: 'logged-in' });
    expect(invocation.command).toBe('claude');
    expect(invocation.args).toEqual(['auth', 'status', '--json']);
    expect(invocation.options.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  test('ignores a stale OpenCode marker when the CLI is logged out', () => {
    const status = getClaudeCliAuthStatus({
      spawnSyncFn: () => ({ stdout: JSON.stringify({ loggedIn: false }) }),
    });

    expect(status).toEqual({ connected: false, reason: 'logged-out' });
  });

  test('finds Claude through a login shell when a desktop PATH cannot', () => {
    const invocations = [];
    const status = getClaudeCliAuthStatus({
      env: { HOME: '/Users/test', PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' },
      platform: 'darwin',
      spawnSyncFn(command, args, options) {
        invocations.push({ command, args, options });
        if (command === 'claude') return { stdout: '', error: new Error('spawnSync claude ENOENT') };
        if (command === '/bin/zsh') return { stdout: '/Users/test/.local/bin/claude\n' };
        return { stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) };
      },
    });

    expect(status).toEqual({ connected: true, reason: 'logged-in' });
    expect(invocations.map(({ command }) => command)).toEqual([
      'claude',
      '/bin/zsh',
      '/Users/test/.local/bin/claude',
    ]);
    expect(invocations[1].args).toEqual(['-lic', 'command -v claude']);
  });
});
