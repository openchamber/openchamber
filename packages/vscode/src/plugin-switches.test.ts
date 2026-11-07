import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { pluginPolicyResource, pluginSwitchState } from '../../web/server/lib/opencode/plugin-switches.js';
import { applyPluginSwitchPolicies, readPluginSwitches, setPluginSwitch } from './plugin-switches';

const directories: string[] = [];
const temporaryDirectory = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-plugin-switch-'));
  directories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('plugin switch resources', () => {
  test('maps npm, scoped, path and file specs to the resource OpenCode denies', () => {
    assert.equal(pluginPolicyResource('opencode-wakatime'), 'plugin:opencode-wakatime');
    assert.equal(pluginPolicyResource('@acme/plugin@1.2.3', '/config/opencode.json'), 'plugin:@acme/plugin');
    assert.equal(pluginPolicyResource('./plugins/team-notes', '/config/opencode.json'), `plugin:${path.resolve('/config/plugins/team-notes')}`);
    assert.equal(pluginPolicyResource('file:///tmp/plugin.js', '/config/opencode.json'), 'plugin:/tmp/plugin.js');
  });

  test('leaves control entries and malformed file URLs without a switch', () => {
    assert.equal(pluginPolicyResource('-opencode.browser'), null);
    assert.equal(pluginPolicyResource('file:/tmp/plugin.js'), null);
  });
});

describe('plugin switch state', () => {
  test('records a switch and reports off, on, or unavailable', () => {
    const directory = temporaryDirectory();
    assert.equal(pluginSwitchState(readPluginSwitches(directory), 'plugin:opencode-wakatime', []), 'on');

    setPluginSwitch(directory, 'plugin:opencode-wakatime', false);
    assert.equal(pluginSwitchState(readPluginSwitches(directory), 'plugin:opencode-wakatime', []), 'off');

    setPluginSwitch(directory, 'plugin:opencode-wakatime', true);
    assert.equal(pluginSwitchState(readPluginSwitches(directory), 'plugin:opencode-wakatime', []), 'on');
    assert.equal(pluginSwitchState({ ok: false, error: new Error('unreadable') }, 'plugin:opencode-wakatime', []), 'unreadable');
  });
});

describe('managed OpenCode layer', () => {
  test('writes its own layer when the user does not own OPENCODE_CONFIG', () => {
    const directory = temporaryDirectory();
    setPluginSwitch(directory, 'plugin:opencode-wakatime', false);

    const env: NodeJS.ProcessEnv = {};
    assert.deepEqual(applyPluginSwitchPolicies(env, directory, { userOwnsConfig: false }), { updated: true, requiresManualRestart: false });
    assert.equal(env.OPENCODE_CONFIG, path.join(directory, 'opencode.managed.json'));
    const configPath = env.OPENCODE_CONFIG;
    assert.ok(configPath);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), {
      policies: [{ action: 'integration.use', resource: 'plugin:opencode-wakatime', effect: 'deny' }],
    });
  });

  test('rewrites its own managed file even after it set OPENCODE_CONFIG', () => {
    const directory = temporaryDirectory();
    setPluginSwitch(directory, 'plugin:opencode-wakatime', false);

    const env: NodeJS.ProcessEnv = { OPENCODE_CONFIG: path.join(directory, 'opencode.managed.json') };
    assert.deepEqual(applyPluginSwitchPolicies(env, directory, { userOwnsConfig: false }), { updated: true, requiresManualRestart: false });
    assert.equal(env.OPENCODE_CONFIG_CONTENT, undefined);
    const configPath = env.OPENCODE_CONFIG;
    assert.ok(configPath);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), {
      policies: [{ action: 'integration.use', resource: 'plugin:opencode-wakatime', effect: 'deny' }],
    });
  });

  test('merges into OPENCODE_CONFIG_CONTENT when the user owns OPENCODE_CONFIG', () => {
    const directory = temporaryDirectory();
    setPluginSwitch(directory, 'plugin:opencode-wakatime', false);

    const env: NodeJS.ProcessEnv = {
      OPENCODE_CONFIG: '/user/opencode.json',
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ theme: 'openchamber' }),
    };
    assert.deepEqual(applyPluginSwitchPolicies(env, directory, { userOwnsConfig: true }), { updated: false, requiresManualRestart: true });
    assert.equal(env.OPENCODE_CONFIG, '/user/opencode.json');
    const content = env.OPENCODE_CONFIG_CONTENT;
    assert.ok(content);
    assert.deepEqual(JSON.parse(content), {
      theme: 'openchamber',
      policies: [{ action: 'integration.use', resource: 'plugin:opencode-wakatime', effect: 'deny' }],
    });
  });

  test('keeps the published denials when the store cannot be read', () => {
    const directory = temporaryDirectory();
    setPluginSwitch(directory, 'plugin:opencode-wakatime', false);
    const env: NodeJS.ProcessEnv = {};
    applyPluginSwitchPolicies(env, directory, { userOwnsConfig: false });
    const managedFile = path.join(directory, 'opencode.managed.json');
    const published = fs.readFileSync(managedFile, 'utf8');

    fs.writeFileSync(path.join(directory, 'plugin-switches.json'), '{not json', 'utf8');

    applyPluginSwitchPolicies(env, directory, { userOwnsConfig: false });
    assert.equal(fs.readFileSync(managedFile, 'utf8'), published);
  });

  test('a fresh launch on an unreadable store starts without denials', () => {
    const directory = temporaryDirectory();
    fs.writeFileSync(path.join(directory, 'plugin-switches.json'), JSON.stringify({ disabled: 'nope' }), 'utf8');

    const env: NodeJS.ProcessEnv = {};
    applyPluginSwitchPolicies(env, directory, { userOwnsConfig: false });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'opencode.managed.json'), 'utf8')), { policies: [] });
    assert.equal(env.OPENCODE_CONFIG, path.join(directory, 'opencode.managed.json'));
  });

  test('fails a launch when denials cannot merge into OPENCODE_CONFIG_CONTENT, and leaves it alone without denials', () => {
    const directory = temporaryDirectory();
    const env: NodeJS.ProcessEnv = { OPENCODE_CONFIG_CONTENT: 'not json' };
    assert.deepEqual(applyPluginSwitchPolicies(env, directory, { userOwnsConfig: true }), { updated: false, requiresManualRestart: true });
    assert.equal(env.OPENCODE_CONFIG_CONTENT, 'not json');

    setPluginSwitch(directory, 'plugin:opencode-wakatime', false);
    assert.throws(() => applyPluginSwitchPolicies(env, directory, { userOwnsConfig: true }));
  });
});
