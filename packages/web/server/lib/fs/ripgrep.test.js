import fs from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRipgrepResolver } from './ripgrep.js';

const binaryName = process.platform === 'win32' ? 'rg.exe' : 'rg';

describe('ripgrep resolver', () => {
  let root;
  const executable = async (relative) => {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '#!/bin/sh\n');
    await fs.promises.chmod(file, 0o755);
    return file;
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'oc-ripgrep-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('prefers the staged desktop binary, then the package, then the PATH', async () => {
    const staged = await executable(path.join('resources', 'ripgrep', binaryName));
    const packaged = await executable(path.join('pkg', 'bin', binaryName));
    const onPath = await executable(path.join('bin', binaryName));
    const options = {
      fs,
      path,
      resourcesPath: path.join(root, 'resources'),
      buildSearchPath: () => [path.join(root, 'nowhere'), path.join(root, 'bin')].join(path.delimiter),
      loadPackagedBinaryPath: async () => packaged,
    };

    expect(await createRipgrepResolver(options).resolveRipgrepBinary()).toBe(staged);
    await rm(staged);
    expect(await createRipgrepResolver(options).resolveRipgrepBinary()).toBe(packaged);
    await rm(packaged);
    expect(await createRipgrepResolver(options).resolveRipgrepBinary()).toBe(onPath);
    await rm(onPath);
    expect(await createRipgrepResolver(options).resolveRipgrepBinary()).toBeNull();
  });

  it('survives a package whose platform binary is missing', async () => {
    const resolver = createRipgrepResolver({
      fs,
      path,
      resourcesPath: undefined,
      buildSearchPath: () => '',
      loadPackagedBinaryPath: async () => { throw new Error('Could not find @vscode/ripgrep-linux-x64'); },
    });
    expect(await resolver.resolveRipgrepBinary()).toBeNull();
  });

  it('keeps a found binary and keeps looking after a miss', async () => {
    const load = vi.fn(async () => { throw new Error('missing'); });
    const resolver = createRipgrepResolver({ fs, path, resourcesPath: undefined, buildSearchPath: () => path.join(root, 'bin'), loadPackagedBinaryPath: load });
    expect(await resolver.resolveRipgrepBinary()).toBeNull();
    const onPath = await executable(path.join('bin', binaryName));
    expect(await resolver.resolveRipgrepBinary()).toBe(onPath);
    await rm(onPath);
    expect(await resolver.resolveRipgrepBinary()).toBe(onPath);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
