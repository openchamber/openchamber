import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  findPackagedWorkspacePlugins,
  verifyPackagedWorkspacePlugins,
  verifyWorkspacePluginPayload,
} from './verify-workspace-plugin.mjs';

const createPlugin = (root) => {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'runtime-image'), { recursive: true });
  fs.mkdirSync(path.join(root, 'egress-image'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: '@openchamber/opencode-container-workspace',
    version: '1.2.3',
    main: './src/plugin.js',
    exports: { '.': './src/plugin.js', './policy': './src/policy.js' },
  }));
  fs.writeFileSync(path.join(root, 'README.md'), 'readme');
  fs.writeFileSync(path.join(root, 'LICENSE'), 'license');
  fs.writeFileSync(path.join(root, 'src/plugin.js'), 'export default {}');
  fs.writeFileSync(path.join(root, 'src/policy.js'), 'export const policy = {}');
  fs.writeFileSync(path.join(root, 'src/plugin.test.js'), 'not packaged');
  fs.writeFileSync(path.join(root, 'runtime-image/Dockerfile'), 'FROM scratch');
  fs.writeFileSync(path.join(root, 'egress-image/Dockerfile'), 'FROM scratch');
};

const copyReleasePayload = (source, destination) => {
  fs.cpSync(source, destination, {
    recursive: true,
    filter: (entry) => !entry.endsWith('.test.js'),
  });
};

test('verifies an exact staged workspace plugin payload', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-plugin-test-'));
  try {
    const installedRoot = path.join(root, 'installed');
    const payloadRoot = path.join(root, 'staged');
    createPlugin(installedRoot);
    copyReleasePayload(installedRoot, payloadRoot);
    assert.deepEqual(verifyWorkspacePluginPayload({ installedRoot, payloadRoot, label: 'Staged' }), { fileCount: 7 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects missing, modified, and extra staged files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-plugin-test-'));
  try {
    const installedRoot = path.join(root, 'installed');
    const payloadRoot = path.join(root, 'staged');
    createPlugin(installedRoot);
    copyReleasePayload(installedRoot, payloadRoot);

    fs.rmSync(path.join(payloadRoot, 'src/policy.js'));
    assert.throws(() => verifyWorkspacePluginPayload({ installedRoot, payloadRoot, label: 'Staged' }), /missing: src\/policy\.js/);
    copyReleasePayload(installedRoot, payloadRoot);
    fs.writeFileSync(path.join(payloadRoot, 'src/plugin.js'), 'modified');
    assert.throws(() => verifyWorkspacePluginPayload({ installedRoot, payloadRoot, label: 'Staged' }), /content mismatch: src\/plugin\.js/);
    copyReleasePayload(installedRoot, payloadRoot);
    fs.writeFileSync(path.join(payloadRoot, 'src/unexpected.js'), 'unexpected');
    assert.throws(() => verifyWorkspacePluginPayload({ installedRoot, payloadRoot, label: 'Staged' }), /extra: src\/unexpected\.js/);
    fs.rmSync(path.join(payloadRoot, 'src/unexpected.js'));
    fs.writeFileSync(path.join(payloadRoot, 'src/leaked.test.js'), 'test');
    assert.throws(() => verifyWorkspacePluginPayload({ installedRoot, payloadRoot, label: 'Staged' }), /extra: src\/leaked\.test\.js/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('finds and verifies final workspace plugin resources', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-plugin-test-'));
  try {
    const installedRoot = path.join(root, 'installed');
    const electronRoot = path.join(root, 'electron');
    const macPayload = path.join(electronRoot, 'dist/mac/OpenChamber.app/Contents/Resources/opencode-container-workspace');
    const windowsPayload = path.join(electronRoot, 'dist/win-unpacked/resources/opencode-container-workspace');
    createPlugin(installedRoot);
    copyReleasePayload(installedRoot, macPayload);
    copyReleasePayload(installedRoot, windowsPayload);

    assert.deepEqual(findPackagedWorkspacePlugins(path.join(electronRoot, 'dist')), [macPayload, windowsPayload]);
    assert.deepEqual(verifyPackagedWorkspacePlugins({ electronRoot, installedRoot }), { payloadCount: 2 });
    fs.writeFileSync(path.join(windowsPayload, 'egress-image/Dockerfile'), 'FROM changed');
    assert.throws(() => verifyPackagedWorkspacePlugins({ electronRoot, installedRoot }), /content mismatch: egress-image\/Dockerfile/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects absent final workspace plugin resources', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-plugin-test-'));
  try {
    const installedRoot = path.join(root, 'installed');
    const electronRoot = path.join(root, 'electron');
    createPlugin(installedRoot);
    assert.throws(() => verifyPackagedWorkspacePlugins({ electronRoot, installedRoot }), /No packaged workspace plugin found/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
