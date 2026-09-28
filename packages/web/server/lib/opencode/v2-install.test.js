import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installOpenCodeV2 } from './v2-install.js';
import { readOpenCodeCliVersion } from './compatibility.js';

let homeDirectory;
let binary;
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const cli = (version) => '#!/bin/sh\nprintf "%s\\n" "opencode v' + version + '"\n';
const run = (script, version = '2.0.15') => installOpenCodeV2({
  homeDirectory,
  fetchImpl: async (url) => url.includes('registry.npmjs.org')
    ? Response.json({ version })
    : new Response(script),
});

beforeEach(async () => {
  homeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-install-test-'));
  binary = path.join(homeDirectory, '.opencode/bin/opencode');
  await fs.mkdir(path.dirname(binary), { recursive: true });
  await fs.writeFile(binary, cli('1.18.30'), { mode: 0o755 });
});
afterEach(async () => { await fs.rm(homeDirectory, { recursive: true, force: true }); });

describe('OpenCode v2 installation', () => {
  it('passes the validated release and verifies the actual executable', async () => {
    const script = `#!/bin/bash
set -eu
test "$1" = "--version"
test "$2" = "2.0.15"
test "$3" = "--no-modify-path"
printf %s ${quote(cli('2.0.15'))} > ${quote(binary)}
chmod 755 ${quote(binary)}
`;
    expect(await run(script)).toBe(binary);
    expect(await readOpenCodeCliVersion({ binary, args: [] })).toBe('2.0.15');
    await expect(fs.stat(path.join(path.dirname(binary), '.openchamber-install'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('restores the binary and shim when an installer exits zero but leaves v1', async () => {
    const shim = path.join(path.dirname(binary), 'opencode2');
    await fs.symlink('opencode', shim);
    const script = `printf %s broken > ${quote(shim)}\nexit 0\n`;
    await expect(run(script)).rejects.toThrow();
    expect(await readOpenCodeCliVersion({ binary, args: [] })).toBe('1.18.30');
    expect(await fs.readlink(shim)).toBe('opencode');
  });

  it('restores v1 after a partial installer failure, and permits a retry', async () => {
    const script = `printf %s broken > ${quote(binary)}\nexit 1\n`;
    await expect(run(script)).rejects.toThrow('installation failed');
    expect(await readOpenCodeCliVersion({ binary, args: [] })).toBe('1.18.30');
    await expect(run(script)).rejects.toThrow('installation failed');
  });

  it('rejects a non-v2 registry release before running the installer', async () => {
    await expect(run(`rm ${quote(binary)}`, '3.0.0')).rejects.toThrow();
    expect(await readOpenCodeCliVersion({ binary, args: [] })).toBe('1.18.30');
  });

  describe('on Windows', () => {
    const tarballOf = (name) => `https://registry.npmjs.org/@opencode/${name}/-/${name}-2.0.15.tgz`;
    let exe;
    const integrityOf = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    // The platform package keeps its binary at package/bin/opencode.exe. Here it is a
    // shell script, so the version check runs it on the Linux/macOS test host.
    const pack = async (version) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-package-'));
      await fs.mkdir(path.join(root, 'package/bin'), { recursive: true });
      await fs.writeFile(path.join(root, 'package/bin/opencode.exe'), cli(version), { mode: 0o755 });
      execFileSync('tar', ['-czf', path.join(root, 'package.tgz'), '-C', root, 'package']);
      const bytes = await fs.readFile(path.join(root, 'package.tgz'));
      await fs.rm(root, { recursive: true, force: true });
      return bytes;
    };
    const PACKAGE_BY_ARCH = { x64: 'cli-windows-x64-baseline', arm64: 'cli-windows-arm64' };
    const runWindows = (archive, integrity = integrityOf(archive), arch = 'x64') => installOpenCodeV2({
      homeDirectory,
      platform: 'win32',
      arch,
      tarCommand: 'tar',
      fetchImpl: async (url) => {
        const name = PACKAGE_BY_ARCH[arch];
        if (url.endsWith('/@opencode%2Fcli/latest')) return Response.json({ version: '2.0.15' });
        if (url.endsWith(`/@opencode%2F${name}/2.0.15`)) return Response.json({ dist: { tarball: tarballOf(name), integrity } });
        if (url === tarballOf(name)) return new Response(archive);
        return new Response(null, { status: 404 });
      },
    });

    beforeEach(async () => {
      exe = path.join(homeDirectory, '.opencode/bin/opencode.exe');
      await fs.writeFile(exe, cli('1.18.30'), { mode: 0o755 });
    });

    it('installs the verified platform package without the bash installer', async () => {
      expect(await runWindows(await pack('2.0.15'))).toBe(exe);
      expect(await readOpenCodeCliVersion({ binary: exe, args: [] })).toBe('2.0.15');
      expect(await readOpenCodeCliVersion({ binary, args: [] })).toBe('1.18.30');
      await expect(fs.stat(path.join(path.dirname(exe), '.openchamber-install'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('installs the native arm64 package on Windows ARM64', async () => {
      const archive = await pack('2.0.15');
      expect(await runWindows(archive, integrityOf(archive), 'arm64')).toBe(exe);
      expect(await readOpenCodeCliVersion({ binary: exe, args: [] })).toBe('2.0.15');
    });

    it('rejects a package that does not match its published integrity before touching the binary', async () => {
      const archive = await pack('2.0.15');
      await expect(runWindows(archive, integrityOf(Buffer.from('other')))).rejects.toThrow('integrity');
      expect(await readOpenCodeCliVersion({ binary: exe, args: [] })).toBe('1.18.30');
      await expect(fs.stat(path.join(path.dirname(exe), '.openchamber-install'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('restores the previous binary when the package holds another release', async () => {
      await expect(runWindows(await pack('2.0.14'))).rejects.toThrow();
      expect(await readOpenCodeCliVersion({ binary: exe, args: [] })).toBe('1.18.30');
    });
  });

  it('does not overwrite an installation owned by another process', async () => {
    const lock = path.join(path.dirname(binary), '.openchamber-install');
    await fs.mkdir(lock);
    await expect(run('exit 0')).rejects.toThrow('already in progress');
    expect((await fs.stat(lock)).isDirectory()).toBe(true);
    expect(await readOpenCodeCliVersion({ binary, args: [] })).toBe('1.18.30');
  });
});
