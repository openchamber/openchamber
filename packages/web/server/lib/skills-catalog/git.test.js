import { describe, expect, it, vi } from 'vitest';
import { runGit } from './git.js';

const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';
// A shell alias makes Git print the environment it runs under.
const PRINT_HOME = ['-c', 'alias.print-home=!printf %s "$HOME"', 'print-home'];

const httpsResolver = (password = 'catalog-private-token') => ({
  resolve: vi.fn(async ({ endpoint }) => ({
    mode: 'managed',
    transport: 'https',
    username: 'x-access-token',
    password,
    allowedEndpoint: endpoint,
  })),
});

const httpsIdentity = {
  credentialId: 'managed-account-reference',
  endpoint: 'https://example.com/owner/private.git',
};

describe('skills catalog runGit', () => {
  it('configures managed HTTPS Git through the broker without exposing the token', async () => {
    const password = 'catalog-private-token';
    const credentialResolver = httpsResolver(password);

    const result = await runGit(['config', '--get', 'credential.helper'], { identity: httpsIdentity, credentialResolver });

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain('credential-helper.js');
    expect(result.stdout).not.toContain(password);
    expect(result.stderr).not.toContain(password);
    expect(credentialResolver.resolve).toHaveBeenCalledOnce();
  });

  it('runs managed SSH Git through the key wrapper and removes the key afterwards', async () => {
    const cleanup = vi.fn(async () => {});
    const credentialResolver = {
      resolve: vi.fn(async () => ({
        mode: 'managed',
        transport: 'ssh',
        key: { privateKeyPath: '/tmp/catalog-operation-key', cleanup },
      })),
    };

    const result = await runGit(['config', '--get', 'core.sshCommand'], {
      identity: { transport: 'ssh', credentialId: 'ssh-key-reference', endpoint: 'git@example.com:owner/private.git' },
      credentialResolver,
    });

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain('ssh-wrapper.js');
    expect(result.stdout).toContain('/tmp/catalog-operation-key');
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('hides the home directory from managed HTTPS Git so ~/.netrc cannot sign in', async () => {
    const result = await runGit(PRINT_HOME, { identity: httpsIdentity, credentialResolver: httpsResolver() });

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe(NULL_DEVICE);
  });

  it('hides the home directory from anonymous Git', async () => {
    const result = await runGit(PRINT_HOME, { identity: { anonymous: true, transport: 'anonymous' } });

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe(NULL_DEVICE);
  });

  it('refuses a selected identity without a credential instead of using System Git', async () => {
    const result = await runGit(['--version'], { identity: { transport: 'ssh', endpoint: 'git@example.com:owner/private.git' } });

    expect(result.ok).toBe(false);
    expect(result.message).toBe('Selected Git identity is unavailable');
  });
});
