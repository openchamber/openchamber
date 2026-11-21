import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { readEffectiveGitTransportRevision } from './transport-config.js';

const execFileAsync = promisify(execFile);
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

  it('ignores per-invocation trace headers and still moves on every other transport change', async () => {
    const records = (...extra) => Buffer.from([
      'global', 'file:/private/global.gitconfig', 'credential.helper\nsecret-helper',
      ...extra,
    ].join('\0') + '\0');
    const trace = (id) => [
      'command', 'command line:', `http.extraheader\ntraceparent: 00-${id}-${'c'.repeat(16)}-01`,
      'command', 'command line:', `http.https://example.com/.extraheader\nTraceState: vendor=${id}`,
    ];
    const revisionFor = (configOutput) => readEffectiveGitTransportRevision('/repository', {
      execFileImpl: vi.fn(async (_binary, args) => ({
        stdout: args[0] === 'config' ? configOutput : Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      })),
    });

    const first = await revisionFor(records(...trace('a'.repeat(32))));
    expect(await revisionFor(records(...trace('b'.repeat(32))))).toBe(first);
    expect(first).toBe(hash(Buffer.concat([
      Buffer.from([
        'global', 'file:/private/global.gitconfig', 'credential.helper\nsecret-helper',
        'command', 'command line:', 'http.extraheader\ntraceparent:',
        'command', 'command line:', 'http.https://example.com/.extraheader\ntracestate:',
      ].join('\0') + '\0'),
      Buffer.from([0]),
    ])));
    const [globalTrace, scopedTrace] = [trace('a'.repeat(32)).slice(0, 3), trace('a'.repeat(32)).slice(3)];
    expect(await revisionFor(records(...globalTrace)), 'scoped trace entry added').not.toBe(first);
    expect(await revisionFor(records(...scopedTrace, ...globalTrace)), 'trace entries reordered').not.toBe(first);

    for (const [label, record] of [
      ['command-scope proxy', ['command', 'command line:', 'http.proxy\nhttp://proxy.example:3128']],
      ['command-scope SSH command', ['command', 'command line:', 'core.sshcommand\nssh -i other-key']],
      ['command-scope credential helper', ['command', 'command line:', 'credential.helper\nother-helper']],
      ['command-scope non-trace header', ['command', 'command line:', 'http.extraheader\nAuthorization: Bearer x']],
      ['command-scope include', ['command', 'file:/private/included.gitconfig', 'remote.origin.proxy\nhttp://proxy']],
      ['trace header in a file scope', ['local', 'file:.git/config', 'http.extraheader\ntraceparent: fixed']],
      ['trace header from a command-scope include', ['command', 'file:/private/included.gitconfig', 'http.extraheader\ntracestate: fixed']],
    ]) {
      expect(await revisionFor(records(...trace('a'.repeat(32)), ...record)), label).not.toBe(first);
    }
    const otherHelper = Buffer.from(records(...trace('a'.repeat(32))).toString().replace('secret-helper', 'other-helper'));
    expect(await revisionFor(otherHelper)).not.toBe(first);
  });

  it('reads the same revision through real Git when only a command-scope trace header changes', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-transport-config-'));
    try {
      await execFileAsync('git', ['init', '--quiet', directory]);
      const withCommandScope = (...pairs) => (file, args, options) =>
        execFileAsync(file, [...pairs.flatMap((pair) => ['-c', pair]), ...args], options);
      const read = (...pairs) => readEffectiveGitTransportRevision(directory, { execFileImpl: withCommandScope(...pairs) });

      const first = await read(`http.extraheader=traceparent: 00-${'a'.repeat(32)}-${'1'.repeat(16)}-01`);
      expect(await read(`http.extraheader=traceparent: 00-${'b'.repeat(32)}-${'2'.repeat(16)}-01`)).toBe(first);
      expect(await read(
        `http.extraheader=traceparent: 00-${'a'.repeat(32)}-${'1'.repeat(16)}-01`,
        'http.proxy=http://proxy.example:3128',
      )).not.toBe(first);

      const included = path.join(directory, 'included.gitconfig');
      await fs.writeFile(included, '[http]\n\textraheader = tracestate: vendor=1\n');
      const withInclude = await read(`include.path=${included}`);
      await fs.writeFile(included, '[http]\n\textraheader = tracestate: vendor=2\n');
      expect(await read(`include.path=${included}`)).not.toBe(withInclude);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
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
