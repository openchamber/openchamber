import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The desktop app runs OpenCode on Electron's Node, and Node refuses to strip
// types for a file under node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING).
// An npm plugin whose entrypoint is a `.ts` file lives there, so the bundled
// server's plugin loader has to strip it. This is a source-level import check:
// a child process registers the hooks from plugin-runtime.mjs (not the staged
// bundle) with the SDK imports stubbed, then imports a plugin entry by file URL.

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'plugin-runtime-test.fixture.mjs');
// The staged copy under resources/ is this file bundled; staging needs the
// platform packages, so the test runs the source the bundle is built from.
const loader = path.join(here, 'plugin-runtime.mjs');

// The loader ships inside the packaged app, which runs Electron as plain Node.
// The child inherits this process's environment, so with Electron's executable
// as `process.execPath` and `ELECTRON_RUN_AS_NODE=1` set, the same test runs on
// the Node the desktop app actually uses.
const runFixture = (pluginEntry) => {
  const result = spawnSync(process.execPath, [fixture, loader, pluginEntry], { encoding: 'utf8', env: process.env });
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
};

const writePackage = (dir, name, type, entry, source) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', type, exports: { '.': `./${entry}` } }));
  writeFileSync(path.join(dir, entry), source);
  return path.join(dir, entry);
};

// Writes a package whose entry is `entry` inside a temporary node_modules.
const installPlugin = (root, name, entry, source, type = 'module') => {
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'host', type: 'module' }));
  return writePackage(path.join(root, 'node_modules', name), name, type, entry, source);
};

const withRoot = (prefix, run) => {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const assertLoads = (entry, expected) => {
  const outcome = runFixture(entry);
  assert.equal(outcome.status, 0, `fixture failed:\n${outcome.stderr}`);
  assert.equal(JSON.parse(outcome.stdout).marker, expected);
};

test('a plugin entry under node_modules loads when it is TypeScript', () => {
  withRoot('oc-plugin-ts-', (root) => {
    const entry = installPlugin(root, 'opencode-gbuild', 'index.ts', 'export const marker: string = "loaded from a TypeScript plugin entry";\n');
    assertLoads(entry, 'loaded from a TypeScript plugin entry');
  });
});

test('an .mts plugin entry under node_modules loads as a module', () => {
  withRoot('oc-plugin-mts-', (root) => {
    const entry = installPlugin(root, 'opencode-mts', 'index.mts', 'export const marker: string = "loaded from an .mts entry";\n');
    assertLoads(entry, 'loaded from an .mts entry');
  });
});

// A CommonJS entry only loads through Node's own format detection; forcing it
// to load as an ES module would leave `exports` undefined.
test('a JavaScript plugin entry is left to Node', () => {
  withRoot('oc-plugin-js-', (root) => {
    const entry = installPlugin(root, 'opencode-plain', 'index.js', 'exports.marker = "loaded from a CommonJS JavaScript entry";\n', 'commonjs');
    assertLoads(entry, 'loaded from a CommonJS JavaScript entry');
  });
});

test('a local TypeScript plugin outside node_modules keeps its package format', () => {
  withRoot('oc-plugin-local-cjs-', (root) => {
    const entry = writePackage(path.join(root, 'local-plugin'), 'local-plugin', 'commonjs', 'index.ts', 'const marker: string = "loaded from a local CommonJS TypeScript plugin";\nexports.marker = marker;\n');
    assertLoads(entry, 'loaded from a local CommonJS TypeScript plugin');
  });
});
