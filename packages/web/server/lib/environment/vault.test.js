import { describe, expect, it, vi } from 'vitest';

import { createVaultResolver, isVaultReference } from './vault.js';

const REFERENCE = 'op://Vertex SRE/github_token/credential';

// Stands in for `op read`: answers per reference, or an error object.
const fakeOp = (answers) => vi.fn((command, args, _options, callback) => {
  const answer = answers[args[2]];
  if (answer instanceof Error) callback(answer, '', '');
  else callback(null, answer ?? '', '');
});

describe('vault references', () => {
  it('recognises op:// item references only', () => {
    expect(isVaultReference(REFERENCE)).toBe(true);
    expect(isVaultReference('op://Private/item/section/field')).toBe(true);
    expect(isVaultReference('op://Private/item')).toBe(false);
    expect(isVaultReference('ghp_plain_token')).toBe(false);
    expect(isVaultReference('')).toBe(false);
  });

  it('replaces a reference with the secret op reads, leaving other values alone', async () => {
    const execFile = fakeOp({ [REFERENCE]: 'ghp_secret' });
    const vault = createVaultResolver({ execFile, env: () => ({}), logger: { warn: vi.fn() } });
    await expect(vault.resolve({ GITHUB_TOKEN: REFERENCE, NODE_ENV: 'test' })).resolves.toEqual({ GITHUB_TOKEN: 'ghp_secret', NODE_ENV: 'test' });
    expect(execFile).toHaveBeenCalledWith('op', ['read', '--no-newline', REFERENCE], expect.any(Object), expect.any(Function));
    expect(vault.status()).toMatchObject({ GITHUB_TOKEN: { state: 'resolved' } });
  });

  // Passing the literal reference would look like a bad token to whatever reads it.
  it('leaves a variable out when its reference cannot be read, and never logs the secret or op output', async () => {
    const warn = vi.fn();
    const missing = Object.assign(new Error('spawn op ENOENT'), { code: 'ENOENT' });
    const vault = createVaultResolver({ execFile: fakeOp({ [REFERENCE]: missing }), env: () => ({}), logger: { warn } });
    await expect(vault.resolve({ GITHUB_TOKEN: REFERENCE, NODE_ENV: 'test' })).resolves.toEqual({ NODE_ENV: 'test' });
    expect(vault.status()).toMatchObject({ GITHUB_TOKEN: { state: 'failed', reason: 'op-not-installed' } });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain('Vertex');
  });

  it('serves the cache only when asked not to refresh, and re-reads when asked to refresh', async () => {
    let clock = 0;
    const execFile = fakeOp({ [REFERENCE]: 'ghp_secret' });
    const vault = createVaultResolver({ execFile, env: () => ({}), now: () => clock, ttlMs: 1_000, logger: { warn: vi.fn() } });

    await expect(vault.resolve({ GITHUB_TOKEN: REFERENCE }, { refresh: false })).resolves.toEqual({});
    expect(execFile).not.toHaveBeenCalled();

    await vault.resolve({ GITHUB_TOKEN: REFERENCE });
    await expect(vault.resolve({ GITHUB_TOKEN: REFERENCE }, { refresh: false })).resolves.toEqual({ GITHUB_TOKEN: 'ghp_secret' });
    expect(execFile).toHaveBeenCalledTimes(1);

    // Fresh or not, a refresh re-reads: this is the call a relaunch makes.
    await vault.resolve({ GITHUB_TOKEN: REFERENCE });
    expect(execFile).toHaveBeenCalledTimes(2);

    clock = 5_000;
    await expect(vault.resolve({ GITHUB_TOKEN: REFERENCE }, { refresh: false })).resolves.toEqual({ GITHUB_TOKEN: 'ghp_secret' });
    expect(execFile).toHaveBeenCalledTimes(2);
    await vault.resolve({ GITHUB_TOKEN: REFERENCE });
    expect(execFile).toHaveBeenCalledTimes(3);
  });

  it('a refresh after a rotation returns the rotated secret, not the fresh cached one', async () => {
    let clock = 0;
    const answers = { [REFERENCE]: 'ghp_before_rotation' };
    const execFile = fakeOp(answers);
    const vault = createVaultResolver({ execFile, env: () => ({}), now: () => clock, ttlMs: 60_000, logger: { warn: vi.fn() } });

    await expect(vault.resolve({ GITHUB_TOKEN: REFERENCE })).resolves.toEqual({ GITHUB_TOKEN: 'ghp_before_rotation' });
    answers[REFERENCE] = 'ghp_after_rotation';
    clock = 1_000;
    // Still inside the TTL: a non-refresh resolve serves the cached value,
    // while the refresh a relaunch asks for re-reads and gets the rotation.
    await expect(vault.resolve({ GITHUB_TOKEN: REFERENCE }, { refresh: false })).resolves.toEqual({ GITHUB_TOKEN: 'ghp_before_rotation' });
    await expect(vault.resolve({ GITHUB_TOKEN: REFERENCE })).resolves.toEqual({ GITHUB_TOKEN: 'ghp_after_rotation' });
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it('reports resolved when a failed variable is repointed at an already-cached reference', async () => {
    const BROKEN = 'op://Vault/broken/field';
    const execFile = fakeOp({ [REFERENCE]: 'ghp_secret', [BROKEN]: new Error('signed out') });
    const vault = createVaultResolver({ execFile, env: () => ({}), logger: { warn: vi.fn() } });

    await vault.resolve({ OTHER_TOKEN: REFERENCE });
    await expect(vault.resolve({ GITHUB_TOKEN: BROKEN })).resolves.toEqual({});
    expect(vault.status()).toMatchObject({ GITHUB_TOKEN: { state: 'failed', reason: 'op-read-failed' } });

    // Served from the cache when not refreshing, with no second read.
    await expect(vault.resolve({ GITHUB_TOKEN: REFERENCE }, { refresh: false })).resolves.toEqual({ GITHUB_TOKEN: 'ghp_secret' });
    expect(execFile).toHaveBeenCalledTimes(2);
    expect(vault.status()).toMatchObject({ GITHUB_TOKEN: { state: 'resolved' } });
    expect(vault.status({ GITHUB_TOKEN: REFERENCE })).toMatchObject({ GITHUB_TOKEN: { state: 'resolved' } });
  });

  it('never presents a previous reference outcome as the current reference outcome', async () => {
    const OTHER = 'op://Vault/other/field';
    const execFile = fakeOp({ [REFERENCE]: 'ghp_secret', [OTHER]: 'other_secret' });
    const vault = createVaultResolver({ execFile, env: () => ({}), logger: { warn: vi.fn() } });

    await vault.resolve({ GITHUB_TOKEN: REFERENCE });
    expect(vault.status({ GITHUB_TOKEN: REFERENCE })).toMatchObject({ GITHUB_TOKEN: { state: 'resolved' } });
    // Repointed, not yet read under this name: no status answers for it.
    expect(vault.status({ GITHUB_TOKEN: OTHER })).toEqual({});
    await expect(vault.resolve({ GITHUB_TOKEN: OTHER }, { refresh: false })).resolves.toEqual({});
    expect(vault.status({ GITHUB_TOKEN: OTHER })).toEqual({});
    expect(vault.status()).toEqual({});
  });

  it('keeps the last good value when a later read fails', async () => {
    let clock = 0;
    const answers = { [REFERENCE]: 'ghp_secret' };
    const vault = createVaultResolver({ execFile: fakeOp(answers), env: () => ({}), now: () => clock, ttlMs: 1_000, logger: { warn: vi.fn() } });
    await vault.resolve({ GITHUB_TOKEN: REFERENCE });
    answers[REFERENCE] = new Error('signed out');
    clock = 5_000;
    await expect(vault.resolve({ GITHUB_TOKEN: REFERENCE })).resolves.toEqual({ GITHUB_TOKEN: 'ghp_secret' });
    expect(vault.status()).toMatchObject({ GITHUB_TOKEN: { state: 'failed', reason: 'op-read-failed' } });
  });
});
