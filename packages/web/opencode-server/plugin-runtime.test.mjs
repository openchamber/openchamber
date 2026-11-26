import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The desktop app runs OpenCode on Electron's Node, and Node refuses to strip
// types for a file under node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING).
// An npm plugin whose entrypoint is a `.ts` file lives there, so the bundled
// server's plugin loader has to load it the way Bun did. This is a source-level import check:
// a child process registers the hooks from plugin-runtime.mjs (not the staged
// bundle) with the SDK imports stubbed, then imports a plugin entry by file URL.

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'plugin-runtime-test.fixture.mjs');
// The staged copy under resources/ is this file bundled; staging needs the
// platform packages, so the test runs the source the bundle is built from.
const loader = path.join(here, 'plugin-runtime.mjs');

// Node 26 removed the transform mode from stripTypeScriptTypes, so the loader
// can only strip there and these cases cannot pass.
const noTypeScriptTransform = (() => {
  try {
    stripTypeScriptTypes('enum Marker {}', { mode: 'transform' });
    return false;
  } catch {
    return 'This Node version removed the TypeScript transform mode';
  }
})();

// The loader ships inside the packaged app, which runs Electron as plain Node.
// The child inherits this process's environment, so with Electron's executable
// as `process.execPath` and `ELECTRON_RUN_AS_NODE=1` set, the same test runs on
// the Node the desktop app actually uses.
// `local` imports the entry the way OpenCode's loader imports a local plugin.
const runFixture = (pluginEntry, mode = 'direct') => {
  const result = spawnSync(process.execPath, [fixture, loader, pluginEntry, mode], { encoding: 'utf8', env: process.env });
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

const assertLoads = (entry, expected, mode) => {
  const outcome = runFixture(entry, mode);
  assert.equal(outcome.status, 0, `fixture failed:\n${outcome.stderr}`);
  assert.equal(JSON.parse(outcome.stdout).marker, expected);
};

test('a plugin entry under node_modules loads when it is TypeScript', () => {
  withRoot('oc-plugin-ts-', (root) => {
    const entry = installPlugin(root, 'opencode-gbuild', 'index.ts', 'export const marker: string = "loaded from a TypeScript plugin entry";\n');
    assertLoads(entry, 'loaded from a TypeScript plugin entry');
  });
});

// TypeScript packages written for Bun import their own modules without file
// extensions. Node's ESM resolver rejects such a specifier before the loader
// gets to read the file.
test('a TypeScript plugin entry resolves an extensionless relative import', () => {
  withRoot('oc-plugin-relative-', (root) => {
    const entry = installPlugin(root, 'opencode-relative', 'index.ts', "export { marker } from './nested';\n");
    writeFileSync(path.join(path.dirname(entry), 'nested.ts'), 'export const marker: string = "loaded through an extensionless import";\n');
    assertLoads(entry, 'loaded through an extensionless import');
  });
});

test('a TypeScript plugin resolves a .js import to its .ts sibling', () => {
  withRoot('oc-plugin-js-specifier-', (root) => {
    const entry = installPlugin(root, 'opencode-js-specifier', 'index.ts', "export { marker } from './v1.js';\n");
    writeFileSync(path.join(path.dirname(entry), 'v1.ts'), 'export const marker: string = "loaded through a .js specifier";\n');
    assertLoads(entry, 'loaded through a .js specifier');
  });
});

// A plugin installed as a symlink to its source checkout imports its own modules
// two levels deep, through a `.js` suffix and without an extension.
test('a symlinked plugin resolves its own TypeScript imports', () => {
  withRoot('oc-plugin-symlinked-', (root) => {
    const entry = writePackage(path.join(root, 'checkout', 'opencode-symlinked'), 'opencode-symlinked', 'module', 'index.ts', "export { marker } from './v1.js';\n");
    const source = path.dirname(entry);
    writeFileSync(path.join(source, 'v1.ts'), "import { part } from './shared';\nexport const marker: string = `loaded from a symlinked plugin ${part}`;\n");
    writeFileSync(path.join(source, 'shared.ts'), 'export const part: string = "and its extensionless import";\n');
    mkdirSync(path.join(root, 'plugins'), { recursive: true });
    const link = path.join(root, 'plugins', 'opencode-symlinked.ts');
    symlinkSync(entry, link);
    assertLoads(link, 'loaded from a symlinked plugin and its extensionless import', 'local');
  });
});

// In a checkout Bun 1.4.4 tries .mts, .ts, .mjs, .js, .cjs, .json, so a source
// file wins over the build output beside it.
test("a symlinked plugin picks the sibling and index in Bun's checkout order", () => {
  withRoot('oc-plugin-symlinked-order-', (root) => {
    const entry = writePackage(
      path.join(root, 'checkout', 'opencode-symlinked-order'),
      'opencode-symlinked-order',
      'module',
      'index.ts',
      "import { part as sibling } from './helper';\nimport { part as index } from './lib';\nexport const marker: string = `${sibling} ${index}`;\n",
    );
    const dir = path.dirname(entry);
    writeFileSync(path.join(dir, 'helper.ts'), 'export const part: string = "helper.ts";\n');
    writeFileSync(path.join(dir, 'helper.mjs'), 'export const part = "helper.mjs";\n');
    mkdirSync(path.join(dir, 'lib'));
    writeFileSync(path.join(dir, 'lib', 'index.mjs'), 'export const part = "lib/index.mjs";\n');
    writeFileSync(path.join(dir, 'lib', 'index.mts'), 'export const part: string = "lib/index.mts";\n');
    mkdirSync(path.join(root, 'plugins'), { recursive: true });
    const link = path.join(root, 'plugins', 'opencode-symlinked-order.ts');
    symlinkSync(entry, link);
    assertLoads(link, 'helper.ts lib/index.mts', 'local');
  });
});

// The fallback is for plugin modules only: any other TypeScript file the server
// imports keeps Node's resolution and its error.
test('a TypeScript import outside the plugin load path keeps Node resolution', () => {
  withRoot('oc-plugin-unrelated-', (root) => {
    const entry = writePackage(path.join(root, 'checkout', 'unrelated'), 'unrelated', 'module', 'index.ts', "export { marker } from './v1.js';\n");
    writeFileSync(path.join(path.dirname(entry), 'v1.ts'), 'export const marker: string = "resolved by the fallback";\n');
    const outcome = runFixture(entry);
    assert.notEqual(outcome.status, 0, `fixture loaded:\n${outcome.stdout}`);
    assert.match(outcome.stderr, /ERR_MODULE_NOT_FOUND/);
    assert.match(outcome.stderr, /v1\.js/);
  });
});

// path.resolve drops a trailing slash, so `./v1.js/` must not be read as `./v1.js`.
test('a directory import with a .js name never loads a .ts sibling', () => {
  withRoot('oc-plugin-js-directory-', (root) => {
    const entry = installPlugin(root, 'opencode-js-directory', 'index.ts', "export { marker } from './v1.js/';\n");
    writeFileSync(path.join(path.dirname(entry), 'v1.ts'), 'console.log("imported v1.ts");\nexport const marker: string = "v1.ts";\n');
    const outcome = runFixture(entry);
    assert.notEqual(outcome.status, 0, `fixture loaded:\n${outcome.stdout}`);
    assert.doesNotMatch(outcome.stdout, /imported v1\.ts/);
    assert.match(outcome.stderr, /ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_DIR_IMPORT/);
  });
});

// Inside node_modules Bun 1.4.4 tries .mjs, .mts, .js, .cjs, .ts, .json in
// that order, for a sibling file and for a directory's index alike.
test("an extensionless import picks the sibling and index in Bun's order", () => {
  withRoot('oc-plugin-relative-order-', (root) => {
    const entry = installPlugin(
      root,
      'opencode-relative-order',
      'index.ts',
      "import { part as js } from './helper';\nimport { part as mts } from './typed';\nimport { part as index } from './lib';\nexport const marker: string = `${js} ${mts} ${index}`;\n",
    );
    const dir = path.dirname(entry);
    writeFileSync(path.join(dir, 'helper.ts'), 'export const part: string = "helper.ts";\n');
    writeFileSync(path.join(dir, 'helper.js'), 'export const part = "helper.js";\n');
    writeFileSync(path.join(dir, 'typed.js'), 'export const part = "typed.js";\n');
    writeFileSync(path.join(dir, 'typed.mts'), 'export const part: string = "typed.mts";\n');
    mkdirSync(path.join(dir, 'lib'));
    writeFileSync(path.join(dir, 'lib', 'index.js'), 'export const part = "lib/index.js";\n');
    writeFileSync(path.join(dir, 'lib', 'index.mts'), 'export const part: string = "lib/index.mts";\n');
    assertLoads(entry, 'helper.js typed.mts lib/index.mts');
  });
});

// A trailing slash names the directory, so its index wins over a sibling file.
test('an extensionless import with a trailing slash loads the directory index', () => {
  withRoot('oc-plugin-relative-slash-', (root) => {
    const entry = installPlugin(root, 'opencode-relative-slash', 'index.ts', "export { marker } from './lib/';\n");
    const dir = path.dirname(entry);
    writeFileSync(path.join(dir, 'lib.ts'), 'export const marker: string = "lib.ts";\n');
    mkdirSync(path.join(dir, 'lib'));
    writeFileSync(path.join(dir, 'lib', 'index.ts'), 'export const marker: string = "lib/index.ts";\n');
    assertLoads(entry, 'lib/index.ts');
  });
});

// Node keys modules by their real path, so a symlinked file found by the
// fallback must be the same instance as an explicit import of its target.
test('an extensionless import of a symlink shares the module with its target', () => {
  withRoot('oc-plugin-relative-symlink-', (root) => {
    const entry = installPlugin(
      root,
      'opencode-relative-symlink',
      'index.ts',
      "import { state as viaAlias } from './alias';\nimport { state } from './real.js';\nexport const marker: string = String(viaAlias === state);\n",
    );
    const dir = path.dirname(entry);
    writeFileSync(path.join(dir, 'real.js'), 'export const state = {};\n');
    symlinkSync(path.join(dir, 'real.js'), path.join(dir, 'alias.js'));
    assertLoads(entry, 'true');
  });
});

// The resolve hook also sees `require()` calls from these files. Node already
// resolves a CommonJS `require('./helper')`, and its answer stands.
test('a require from a TypeScript plugin entry keeps Node resolution', () => {
  withRoot('oc-plugin-require-', (root) => {
    const entry = installPlugin(
      root,
      'opencode-require',
      'index.ts',
      "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nexport const marker: string = require('./helper').marker;\n",
      'commonjs',
    );
    writeFileSync(path.join(path.dirname(entry), 'helper.ts'), 'export const marker: string = "required helper.ts";\n');
    writeFileSync(path.join(path.dirname(entry), 'helper.js'), 'exports.marker = "required helper.js";\n');
    assertLoads(entry, 'required helper.js');
  });
});

// Strip mode erases types but cannot emit the code an enum or a constructor
// parameter property needs, so the loader transforms instead.
test('a TypeScript plugin entry with an enum loads', { skip: noTypeScriptTransform }, () => {
  withRoot('oc-plugin-enum-', (root) => {
    const entry = installPlugin(
      root,
      'opencode-enum',
      'index.ts',
      'export enum Marker { Loaded = "loaded from an enum" }\nexport const marker = Marker.Loaded;\n',
    );
    assertLoads(entry, 'loaded from an enum');
  });
});

test('a TypeScript plugin entry with a constructor parameter property loads', { skip: noTypeScriptTransform }, () => {
  withRoot('oc-plugin-parameter-property-', (root) => {
    const entry = installPlugin(
      root,
      'opencode-parameter-property',
      'index.ts',
      'class Plugin { constructor(private readonly text: string) {} read() { return this.text; } }\nexport const marker = new Plugin("loaded from a parameter property").read();\n',
    );
    assertLoads(entry, 'loaded from a parameter property');
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
