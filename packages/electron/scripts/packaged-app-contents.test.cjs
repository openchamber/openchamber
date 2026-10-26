const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { readAsarFiles, findPackagedAppContentProblems } = require('./packaged-app-contents.cjs');

const web = 'node_modules/@openchamber/web';
const helpers = [
  `${web}/server/lib/git/credential-helper.js`,
  `${web}/server/lib/git/ssh-wrapper.js`,
  `${web}/server/lib/git/repository-credential-helper.js`,
];

const completeApp = () => [
  ...['dist-bundle/entry.mjs', 'dist-bundle/main.mjs', 'dist-bundle/early-startup.mjs', 'preload.mjs', 'browser-panel-preload.cjs', 'package.json'],
  `${web}/package.json`,
  `${web}/server/index.js`,
].map((filePath) => ({ path: filePath, unpacked: false }))
  .concat(helpers.map((filePath) => ({ path: filePath, unpacked: true })));

const writeAsar = (directory, header) => {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(json.length + 8, 4);
  prefix.writeUInt32LE(json.length + 4, 8);
  prefix.writeUInt32LE(json.length, 12);
  const asarPath = path.join(directory, 'app.asar');
  fs.writeFileSync(asarPath, Buffer.concat([prefix, json]));
  return asarPath;
};

test('a complete app has no problems', () => {
  assert.deepEqual(findPackagedAppContentProblems(completeApp()), []);
});

test('the web build output inside the archive is rejected', () => {
  const files = [...completeApp(), { path: `${web}/dist/assets/index.js`, unpacked: false }];
  assert.deepEqual(findPackagedAppContentProblems(files), [`${web}/dist must not be packaged (1 files found)`]);
});

test('ripgrep platform packages inside the archive are rejected', () => {
  const files = [...completeApp(), { path: 'node_modules/@vscode/ripgrep-darwin-arm64/bin/rg', unpacked: false }];
  assert.deepEqual(findPackagedAppContentProblems(files), [
    '@vscode/ripgrep platform packages must not be packaged (1 files found); the binary ships in Resources/ripgrep',
  ]);
  assert.deepEqual(findPackagedAppContentProblems([...completeApp(), { path: 'node_modules/@vscode/ripgrep/lib/index.js', unpacked: false }]), []);
});

test('files copied from outside the allowlist are rejected', () => {
  const files = [...completeApp(), ...['main.mjs', '.cache/opencode-cli/opencode'].map((filePath) => ({ path: filePath, unpacked: false }))];
  assert.deepEqual(findPackagedAppContentProblems(files), ['2 unexpected files outside node_modules (main.mjs, .cache/opencode-cli/opencode)']);
});

test('a missing server entry or a packed git helper is reported', () => {
  const files = completeApp()
    .filter((file) => file.path !== `${web}/server/index.js`)
    .map((file) => (file.path === helpers[0] ? { ...file, unpacked: false } : file));
  assert.deepEqual(findPackagedAppContentProblems(files), [
    `${web}/server/index.js is missing`,
    `${helpers[0]} must be unpacked from the asar`,
  ]);
});

test('reads nested files and the unpacked flag from an asar header', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-asar-'));
  try {
    const asarPath = writeAsar(directory, {
      files: {
        'preload.mjs': { size: 1, offset: '0' },
        node_modules: { files: { pkg: { files: { 'index.js': { size: 1, unpacked: true } } } } },
      },
    });
    assert.deepEqual(readAsarFiles(asarPath), [
      { path: 'preload.mjs', unpacked: false },
      { path: 'node_modules/pkg/index.js', unpacked: true },
    ]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
