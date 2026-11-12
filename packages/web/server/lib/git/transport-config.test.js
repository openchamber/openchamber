import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { readEffectiveGitTransportRevision } from './transport-config.js';

const hash = (value) => crypto.createHash('sha256').update(value).digest('base64url');

describe('effective Git transport configuration', () => {
  it('treats checkout-controlled config as empty for an unborn repository', async () => {
    const execFileImpl = vi.fn(async (_binary, args) => {
      if (args[0] === 'ls-tree') {
        throw Object.assign(new Error('unborn HEAD'), {
          code: 128,
          stderr: Buffer.from('fatal: Not a valid object name HEAD\n'),
        });
      }
      return { stdout: Buffer.alloc(0) };
    });

    await expect(readEffectiveGitTransportRevision('/repository', { execFileImpl }))
      .resolves.toBe(hash(Buffer.from([0])));
    expect(execFileImpl).toHaveBeenCalledTimes(2);
  });

  it('hashes raw scoped config output without returning values or origins', async () => {
    const raw = Buffer.from('global\0file:/private/global.gitconfig\0credential.helper\nsecret-helper\0');
    const checkoutObjects = Buffer.from(`100644 blob ${'a'.repeat(40)}\t.gitmodules\0`);
    const execFileImpl = vi.fn(async (_binary, args) => ({
      stdout: args[0] === 'config' ? raw : checkoutObjects,
      stderr: Buffer.alloc(0),
    }));

    await expect(readEffectiveGitTransportRevision('/repository', {
      gitBinary: '/usr/bin/git', execFileImpl, timeoutMs: 321, maxBuffer: 654,
    })).resolves.toBe(hash(Buffer.concat([raw, Buffer.from([0]), checkoutObjects])));
    expect(execFileImpl).toHaveBeenCalledWith('/usr/bin/git', expect.arrayContaining([
      'config', '--includes', '--show-origin', '--show-scope', '--null', '--get-regexp',
    ]), {
      cwd: '/repository', encoding: null, stdio: ['ignore', 'pipe', 'pipe'], timeout: 321,
      maxBuffer: 654, shell: false, windowsHide: true,
    });
    const pattern = execFileImpl.mock.calls[0][1].at(-1);
    for (const key of [
      'credential.helper', 'credential.https://example.com.helper', 'credential.usehttppath',
       'credential.https://example.com.username', 'core.sshcommand', 'core.askpass', 'url.ssh://example.com/.insteadof',
      'url.ssh://example.com/.pushinsteadof', 'http.proxy', 'http.https://example.com/.extraheader',
      'http.sslverify', 'http.cookiefile', 'remote.origin.proxy',
      'remote.origin.lfsurl', 'lfs.url', 'lfs.standalonetransferagent',
      'lfs.customtransfer.bad.path', 'filter.lfs.process', 'filter.lfs.required',
      'submodule.child.url', 'submodule.child.update',
    ]) expect(new RegExp(pattern).test(key)).toBe(true);
    expect(execFileImpl.mock.calls[1][1]).toEqual([
      'ls-tree', '-z', 'HEAD', '--', '.gitmodules', '.lfsconfig', '.gitattributes',
    ]);
  });

  it('treats no matching keys as authoritative empty and propagates command failure', async () => {
    const noMatch = vi.fn(async (_binary, args) => {
      if (args[0] === 'config') throw Object.assign(new Error('no match'), { code: 1 });
      return { stdout: Buffer.alloc(0) };
    });
    await expect(readEffectiveGitTransportRevision('/repository', { execFileImpl: noMatch }))
      .resolves.toBe(hash(Buffer.from([0])));

    const failed = vi.fn(async () => { throw Object.assign(new Error('/private/config failed'), { code: 128 }); });
    await expect(readEffectiveGitTransportRevision('/repository', { execFileImpl: failed }))
      .rejects.toMatchObject({
        code: 'STALE_CONFIG', status: 409,
        message: 'Effective Git transport configuration is unavailable',
      });
  });
});
