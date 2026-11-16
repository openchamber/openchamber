import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { localMcpStore, withLocalMcpPlugin } from './local-mcp-runtime';
import { applyPluginSwitchPolicies, setPluginSwitch } from './plugin-switches';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-vscode-local-mcp-launch-'));
const previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
process.env.OPENCHAMBER_DATA_DIR = path.join(root, 'data');
after(() => {
  if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
  else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
  fs.rmSync(root, { recursive: true, force: true });
});

test('injects a usable local plugin when the store is empty and preserves inherited config', async () => {
  // Given an empty private store and inherited JSONC configuration.
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const env = { OPENCODE_CONFIG: '/user/opencode.json', OPENCODE_CONFIG_CONTENT: '{ /* user */ "plugins": ["user-plugin"], "warming": false }' };

  // When preparing an owned server launch.
  const launch = await withLocalMcpPlugin(env);

  // Then the generated package loads and reads the same private store as CRUD.
  const config = JSON.parse(launch.OPENCODE_CONFIG_CONTENT || 'null');
  assert.equal(config.warming, false);
  assert.equal(config.plugins[0], 'user-plugin');
  const directory = config.plugins[1];
  assert.equal(path.isAbsolute(directory), true);
  assert.equal(fs.existsSync(path.join(directory, 'package.json')), true);
  assert.equal(launch.OPENCODE_CONFIG, env.OPENCODE_CONFIG);
  assert.match(env.OPENCODE_CONFIG_CONTENT, /\/\* user \*\//);
  const snapshot = localMcpStore().read(project);
  assert.equal(snapshot.path.startsWith(path.join(root, 'data') + path.sep), true);
  assert.deepEqual(snapshot.servers, {});
});

test('refuses malformed inherited configuration before launching', async () => {
  // Given malformed config supplied by the extension host environment.
  const env = { OPENCODE_CONFIG_CONTENT: '{"plugins":' };
  // When preparing the launch, then the error reaches the manager.
  await assert.rejects(withLocalMcpPlugin(env), /valid JSON object/);
});

test('keeps one managed plugin registration when preparing a later launch', async () => {
  // Given launch content that already contains the managed plugin.
  const first = await withLocalMcpPlugin({ OPENCODE_CONFIG_CONTENT: '{"plugins":["user-plugin"]}' });
  // When preparing another owned launch with that content.
  const second = await withLocalMcpPlugin(first);
  // Then the user's plugin and one managed registration survive.
  assert.deepEqual(JSON.parse(second.OPENCODE_CONFIG_CONTENT || 'null').plugins,
    JSON.parse(first.OPENCODE_CONFIG_CONTENT || 'null').plugins);
});

for (const userOwnsConfig of [false, true]) {
  test(`keeps local MCP injection alongside plugin denials with user-owned config ${userOwnsConfig}`, async () => {
    // Given a disabled plugin and inherited plugins in a managed launch.
    const directory = fs.mkdtempSync(path.join(root, 'switches-'));
    setPluginSwitch(directory, 'plugin:disabled-plugin', false);
    const env = { OPENCODE_CONFIG: userOwnsConfig ? '/user/opencode.json' : undefined,
      OPENCODE_CONFIG_CONTENT: '{"plugins":["user-plugin"]}' };

    // When the launch composes local MCP injection with the upstream switch layer.
    const launch = await withLocalMcpPlugin(env);
    applyPluginSwitchPolicies(launch, directory, { userOwnsConfig });

    // Then both the user's plugin and the managed MCP plugin remain available,
    // and the disabled plugin stays denied in the correct configuration layer.
    const content = JSON.parse(launch.OPENCODE_CONFIG_CONTENT || 'null');
    assert.deepEqual(content.plugins, ['user-plugin', path.join(root, 'data', 'mcp-project-local', 'plugin')]);
    const configPath = launch.OPENCODE_CONFIG;
    assert.ok(configPath);
    const policies = userOwnsConfig ? content.policies : JSON.parse(fs.readFileSync(configPath, 'utf8')).policies;
    assert.deepEqual(policies, [{ action: 'integration.use', resource: 'plugin:disabled-plugin', effect: 'deny' }]);
  });
}
