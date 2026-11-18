import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { findWebCheckoutRoot, getWebPackagePaths } from './web-package-paths.js';

const directories = [];
const temporaryDirectory = () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-web-package-paths-')));
  directories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const writePackage = (root, manifest) => {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
};

const webManifest = {
  name: '@openchamber/web',
  type: 'module',
  main: './server/index.js',
  bin: { openchamber: './bin/cli.js' },
};

const expectPaths = (paths, root, prefix = '') => {
  expect(paths).toEqual({
    root,
    packageJson: path.join(root, 'package.json'),
    dist: path.join(root, 'dist'),
    cliEntry: path.join(root, prefix, 'bin/cli.js'),
    serverEntry: path.join(root, prefix, 'server/index.js'),
  });
};

describe('web package paths', () => {
  it('finds and caches the named package from a nested file past another package', () => {
    const root = temporaryDirectory();
    writePackage(root, webManifest);
    const nested = path.join(root, 'server/lib/nested');
    writePackage(nested, { name: 'another-package' });
    const url = pathToFileURL(path.join(nested, 'entry.js'));
    const paths = getWebPackagePaths(url);
    expectPaths(paths, root);
    fs.unlinkSync(path.join(root, 'package.json'));
    expect(getWebPackagePaths(url)).toBe(paths);
  });

  it('resolves its own URL under node_modules and an emitted build directory', async () => {
    const root = path.join(temporaryDirectory(), 'node_modules/@openchamber/web');
    writePackage(root, {
      ...webManifest,
      main: './build/server/index.js',
      bin: { openchamber: './build/bin/cli.js' },
    });
    const modulePath = path.join(root, 'build/server/lib/web-package-paths.js');
    fs.mkdirSync(path.dirname(modulePath), { recursive: true });
    fs.writeFileSync(modulePath, stripTypeScriptTypes(fs.readFileSync(new URL('./web-package-paths.ts', import.meta.url), 'utf8')));
    const { webPackagePaths } = await import(pathToFileURL(modulePath).href);
    expectPaths(webPackagePaths, root, 'build');
    expect(findWebCheckoutRoot(root)).toBeNull();
  });

  it('reports a clear error when no matching manifest exists above the file', () => {
    const root = temporaryDirectory();
    writePackage(root, { name: 'another-package' });
    expect(() => getWebPackagePaths(pathToFileURL(path.join(root, 'nested/entry.js'))))
      .toThrow('Could not find @openchamber/web package.json above');
  });

  it('keeps Node path errors for malformed entry fields in its named manifest', () => {
    for (const fields of [{ main: 42 }, { bin: { openchamber: false } }, { bin: null }]) {
      const root = temporaryDirectory();
      writePackage(root, { ...webManifest, ...fields });
      expect(() => getWebPackagePaths(pathToFileURL(path.join(root, 'entry.js')))).toThrow(TypeError);
    }
  });

  it('recognizes only the checkout that owns this package at packages/web', () => {
    const checkout = temporaryDirectory();
    writePackage(checkout, { name: 'openchamber-monorepo', version: '1.2.3' });
    const webRoot = path.join(checkout, 'packages/web');
    writePackage(webRoot, webManifest);
    expect(findWebCheckoutRoot(webRoot)).toBe(checkout);
    const installed = path.join(checkout, 'node_modules/@openchamber/web');
    writePackage(installed, webManifest);
    expect(findWebCheckoutRoot(installed)).toBeNull();
  });
});
