import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { packLocalTools } from './tools-pack.js';

const CHECKOUT = path.resolve('/checkout');
const OUT = path.resolve('/out');

/** A stand-in for bun. `pack` is what `bun pm pack --quiet` prints for a package. */
const fakeBun = ({ pack = (name) => `${path.join(OUT, `openchamber-${name}-1.24.2.tgz`)}\n`, failAt = () => false } = {}) => {
  const calls = [];
  const runCommand = async (file, args, options) => {
    calls.push({ file, args, cwd: options.cwd, timeoutMs: options.timeoutMs });
    if (failAt(args, options.cwd)) return { code: 1, stdout: '', stderr: 'error: Script not found "build"\n' };
    return { code: 0, stdout: args[0] === 'pm' ? pack(path.basename(options.cwd)) : '', stderr: '' };
  };
  return { runCommand, calls };
};

describe('packLocalTools', () => {
  it('builds the sdk, then packs the sdk and web from their own directories', async () => {
    const bun = fakeBun();
    const result = await packLocalTools({ runCommand: bun.runCommand, bunPath: '/opt/bun', checkoutRoot: CHECKOUT, outputDirectory: OUT });

    expect(result).toEqual({
      sdkTarballPath: path.join(OUT, 'openchamber-sdk-1.24.2.tgz'),
      webTarballPath: path.join(OUT, 'openchamber-web-1.24.2.tgz'),
    });
    expect(bun.calls.map((call) => [call.file, call.args.join(' '), call.cwd])).toEqual([
      ['/opt/bun', 'run build', path.join(CHECKOUT, 'packages', 'sdk')],
      ['/opt/bun', `pm pack --destination ${OUT} --quiet`, path.join(CHECKOUT, 'packages', 'sdk')],
      ['/opt/bun', `pm pack --destination ${OUT} --quiet`, path.join(CHECKOUT, 'packages', 'web')],
    ]);
    for (const call of bun.calls) expect(call.timeoutMs).toBeGreaterThan(0);
  });

  it('takes the last line as the tarball, because the prepack script prints before it', async () => {
    const bun = fakeBun({ pack: (name) => `Built 0 built-in extension(s).\n${path.join(OUT, `openchamber-${name}-1.24.2.tgz`)}\n\n` });
    const result = await packLocalTools({ runCommand: bun.runCommand, checkoutRoot: CHECKOUT, outputDirectory: OUT });
    expect(result.webTarballPath).toBe(path.join(OUT, 'openchamber-web-1.24.2.tgz'));
  });

  it('says which step failed and what to do', async () => {
    const bun = fakeBun({ failAt: (args) => args[0] === 'run' });
    await expect(packLocalTools({ runCommand: bun.runCommand, checkoutRoot: CHECKOUT, outputDirectory: OUT })).rejects.toMatchObject({
      code: 'tools_pack_failed',
      message: expect.stringMatching(/build the sdk package.*Script not found.*bun install/s),
    });
    expect(bun.calls).toHaveLength(1);
  });

  it('rejects when bun does not name a tarball', async () => {
    const bun = fakeBun({ pack: () => 'Done\n' });
    await expect(packLocalTools({ runCommand: bun.runCommand, checkoutRoot: CHECKOUT, outputDirectory: OUT })).rejects.toMatchObject({ code: 'tools_pack_failed' });
  });
});
