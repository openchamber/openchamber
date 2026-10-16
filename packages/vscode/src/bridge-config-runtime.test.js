import { afterEach, describe, expect, mock, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';

mock.module('vscode', () => ({
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({ get: () => undefined }),
  },
}));

// Point the user-level OpenCode config at a scratch directory BEFORE importing:
// the bridge writes agents, commands and plugins there, and a built-in agent
// such as `build` is materialised as a user-level file. Nothing here may touch
// the real ~/.config/opencode.
const scratchConfigRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-bridge-config-'));
process.env.XDG_CONFIG_HOME = path.join(scratchConfigRoot, 'xdg');
process.env.OPENCODE_CONFIG_DIR = '';

const { handleConfigBridgeMessage } = await import('./bridge-config-runtime.ts');

const tempRoots = [];
const originalOpencodeConfig = process.env.OPENCODE_CONFIG;

const createCtx = (workingDirectory, restartImpl = async () => undefined) => {
  const restart = mock(restartImpl);
  return {
    restart,
    manager: {
      getWorkingDirectory: () => workingDirectory,
      restart,
    },
  };
};

const deps = {
  readSettings: () => ({}),
  persistSettings: async (changes) => changes,
  readMagicPromptOverrides: () => ({ version: 1, overrides: {} }),
  saveMagicPromptOverride: async () => ({ version: 1, overrides: {} }),
  resetMagicPromptOverride: async () => ({ version: 1, overrides: {} }),
  resetAllMagicPromptOverrides: async () => ({ version: 1, overrides: {} }),
  fetchOpenCodeSkillsFromApi: async () => null,
  createOpenCodePolicyReader: () => ({
    readVersion: async () => { throw new Error('OpenCode is not running'); },
    readConfigEntries: async () => { throw new Error('OpenCode is not running'); },
  }),
  clientReloadDelayMs: 800,
};

afterEach(() => {
  if (originalOpencodeConfig === undefined) {
    delete process.env.OPENCODE_CONFIG;
  } else {
    process.env.OPENCODE_CONFIG = originalOpencodeConfig;
  }

  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));
// A `skillPolicy` answer's entries by id.
const byId = (skillPolicy) => new Map(skillPolicy.skills.map(({ id, ...entry }) => [id, entry]));

describe('VS Code config bridge plugin parity', () => {
  test('explicit config reload restarts OpenCode', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-reload-'));
    tempRoots.push(root);
    const ctx = createCtx(root);

    const reloaded = await handleConfigBridgeMessage({
      id: 'reload',
      type: 'api:config/reload',
    }, ctx, deps);

    expect(reloaded).toEqual({
      id: 'reload',
      type: 'api:config/reload',
      success: true,
      data: { restarted: true },
    });
    expect(ctx.restart).toHaveBeenCalledTimes(1);
  });

  test('removes agent fields when update payload sends null', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-agent-null-'));
    tempRoots.push(root);
    const ctx = createCtx(root);
    const configDir = path.join(root, '.opencode');
    const configPath = path.join(configDir, 'opencode.json');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      agent: {
        build: {
          variant: 'fast',
          temperature: 0.3,
          top_p: 0.8,
          mode: 'subagent',
        },
      },
    }, null, 2), 'utf8');

    const updated = await handleConfigBridgeMessage({
      id: 'update-agent-null-fields',
      type: 'api:config/agents',
      payload: {
        method: 'PATCH',
        name: 'build',
        directory: root,
        body: { variant: null, temperature: null, top_p: null },
      },
    }, ctx, deps);

    expect(updated?.success).toBe(true);
    // The v1 `agent` entry is rewritten in place as a v2 `agents` entry, and the
    // cleared v1 fields are removed from where v2 keeps them: `variant` off the
    // model reference, `temperature`/`top_p` out of `request.body`.
    const agentConfig = readJson(configPath);
    expect(agentConfig.agent).toBeUndefined();
    expect(agentConfig.agents.build).toEqual({ mode: 'subagent' });
  });

  test('creates, lists, updates, and deletes project plugin entries', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-plugins-'));
    tempRoots.push(root);
    const ctx = createCtx(root);

    const created = await handleConfigBridgeMessage({
      id: 'create',
      type: 'api:config/plugins',
      payload: {
        method: 'POST',
        target: 'entry',
        directory: root,
        body: { scope: 'project', spec: 'plugin-a', options: { enabled: true } },
      },
    }, ctx, deps);

    expect(created?.success).toBe(true);
    expect(created?.data).toMatchObject({
      success: true,
      message: 'Plugin entry changed.',
    });
    expect(ctx.restart).not.toHaveBeenCalled();

    const listed = await handleConfigBridgeMessage({
      id: 'list',
      type: 'api:config/plugins',
      payload: { method: 'GET', target: 'list', directory: root },
    }, ctx, deps);
    const entries = listed?.data?.entries || [];
    const entry = entries.find((candidate) => candidate.spec === 'plugin-a');
    expect(entry?.scope).toBe('project');

    const updated = await handleConfigBridgeMessage({
      id: 'update',
      type: 'api:config/plugins',
      payload: {
        method: 'PATCH',
        target: 'entry',
        directory: root,
        pluginId: entry?.id,
        body: { spec: 'plugin-b' },
      },
    }, ctx, deps);
    expect(updated?.success).toBe(true);

    const config = JSON.parse(fs.readFileSync(path.join(root, '.opencode', 'opencode.json'), 'utf8'));
    expect(config.plugin).toBeUndefined();
    expect(config.plugins).toEqual([{ package: 'plugin-b', options: { enabled: true } }]);

    const relisted = await handleConfigBridgeMessage({
      id: 'relist',
      type: 'api:config/plugins',
      payload: { method: 'GET', target: 'list', directory: root },
    }, ctx, deps);
    const updatedEntry = (relisted?.data?.entries || []).find((candidate) => candidate.spec === 'plugin-b');

    const deleted = await handleConfigBridgeMessage({
      id: 'delete',
      type: 'api:config/plugins',
      payload: { method: 'DELETE', target: 'entry', directory: root, pluginId: updatedEntry?.id },
    }, ctx, deps);
    expect(deleted?.success).toBe(true);
  });

  test('creates and reads project plugin files', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-plugin-files-'));
    tempRoots.push(root);
    const ctx = createCtx(root);

    const created = await handleConfigBridgeMessage({
      id: 'create-file',
      type: 'api:config/plugins',
      payload: {
        method: 'POST',
        target: 'file',
        directory: root,
        body: { scope: 'project', fileName: 'demo-plugin.ts', content: 'export default {}' },
      },
    }, ctx, deps);
    expect(created?.success).toBe(true);

    const listed = await handleConfigBridgeMessage({
      id: 'list',
      type: 'api:config/plugins',
      payload: { method: 'GET', target: 'list', directory: root },
    }, ctx, deps);
    const files = listed?.data?.files || [];
    const file = files.find((candidate) => candidate.fileName === 'demo-plugin.ts');
    expect(file?.scope).toBe('project');

    const read = await handleConfigBridgeMessage({
      id: 'read-file',
      type: 'api:config/plugins',
      payload: { method: 'GET', target: 'file', directory: root, pluginId: file?.id },
    }, ctx, deps);
    expect(read?.data).toEqual({ fileName: 'demo-plugin.ts', scope: 'project', content: 'export default {}' });
  });

  test('updates and deletes user plugin entries from OPENCODE_CONFIG source', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-custom-config-'));
    tempRoots.push(root);
    const configDir = path.join(root, 'custom-config');
    const configPath = path.join(configDir, 'opencode.json');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ plugin: ['custom-plugin'] }, null, 2), 'utf8');
    process.env.OPENCODE_CONFIG = configPath;
    const ctx = createCtx(root);

    const listed = await handleConfigBridgeMessage({
      id: 'list-custom',
      type: 'api:config/plugins',
      payload: { method: 'GET', target: 'list', directory: root },
    }, ctx, deps);
    const entry = (listed?.data?.entries || []).find((candidate) => candidate.spec === 'custom-plugin');
    expect(entry?.scope).toBe('user');

    const updated = await handleConfigBridgeMessage({
      id: 'update-custom',
      type: 'api:config/plugins',
      payload: {
        method: 'PATCH',
        target: 'entry',
        directory: root,
        pluginId: entry?.id,
        body: { spec: 'custom-plugin-next' },
      },
    }, ctx, deps);
    expect(updated?.success).toBe(true);
    // Touching one entry migrates the whole v1 `plugin` array into v2 `plugins`.
    expect(readJson(configPath).plugin).toBeUndefined();
    expect(readJson(configPath).plugins).toEqual(['custom-plugin-next']);

    const relisted = await handleConfigBridgeMessage({
      id: 'relist-custom',
      type: 'api:config/plugins',
      payload: { method: 'GET', target: 'list', directory: root },
    }, ctx, deps);
    const updatedEntry = (relisted?.data?.entries || []).find((candidate) => candidate.spec === 'custom-plugin-next');

    const deleted = await handleConfigBridgeMessage({
      id: 'delete-custom',
      type: 'api:config/plugins',
      payload: { method: 'DELETE', target: 'entry', directory: root, pluginId: updatedEntry?.id },
    }, ctx, deps);
    expect(deleted?.success).toBe(true);
    expect(readJson(configPath).plugin).toBeUndefined();
    expect(readJson(configPath).plugins).toBeUndefined();
  });

  test('writes user plugin files next to OPENCODE_CONFIG', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-custom-files-'));
    tempRoots.push(root);
    const configDir = path.join(root, 'custom-config');
    const configPath = path.join(configDir, 'opencode.json');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, '{}', 'utf8');
    process.env.OPENCODE_CONFIG = configPath;
    const ctx = createCtx(root);

    const created = await handleConfigBridgeMessage({
      id: 'create-custom-file',
      type: 'api:config/plugins',
      payload: {
        method: 'POST',
        target: 'file',
        directory: root,
        body: { scope: 'user', fileName: 'demo-plugin.ts', content: 'export default {}' },
      },
    }, ctx, deps);

    expect(created?.success).toBe(true);
    expect(fs.readFileSync(path.join(configDir, 'plugins', 'demo-plugin.ts'), 'utf8')).toBe('export default {}');
  });

  // OpenCode 2 watches its config sources, so a write is live as soon as it
  // lands: there is no restart to defer and no restart that can fail. The
  // mutation just reports where it wrote.
  test('creates an MCP server under mcp.servers without restarting OpenCode', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-mcp-create-'));
    tempRoots.push(root);
    const ctx = createCtx(root, async () => {
      throw new Error('restart failed');
    });
    const configPath = path.join(root, '.opencode', 'opencode.json');

    const created = await handleConfigBridgeMessage({
      id: 'create-mcp',
      type: 'api:config/mcp',
      payload: {
        method: 'POST',
        name: 'mcp-server',
        directory: root,
        body: { scope: 'project', type: 'local', command: ['node', 'server.js'], enabled: false },
      },
    }, ctx, deps);

    expect(created?.success).toBe(true);
    expect(created?.data).toMatchObject({
      success: true,
      message: 'MCP server "mcp-server" created.',
      path: configPath,
    });
    expect(ctx.restart).not.toHaveBeenCalled();

    const written = readJson(configPath);
    expect(written.mcp['mcp-server']).toBeUndefined();
    expect(written.mcp.servers['mcp-server']).toEqual({
      type: 'local',
      command: ['node', 'server.js'],
      // v1 `enabled: false` becomes the inverse v2 `disabled: true`.
      disabled: true,
    });
  });
});

describe('VS Code skill policy parity', () => {
  const globalConfigPath = path.join(process.env.XDG_CONFIG_HOME, 'opencode', 'opencode.json');

  const writeSkill = (root, id, name) => {
    const skillFile = path.join(root, '.opencode', 'skills', id, 'SKILL.md');
    fs.mkdirSync(path.dirname(skillFile), { recursive: true });
    fs.writeFileSync(skillFile, `---\nname: ${name}\ndescription: ${id}\n---\nBody\n`);
  };

  // OpenCode serves statements without the provenance key (measured on 2.0.25, 2.0.28, 2.0.29 and 2.0.30).
  const served = (info) => {
    const copy = { ...info };
    if (copy.policies) copy.policies = copy.policies.map(({ action, resource, effect }) => ({ action, resource, effect }));
    return copy;
  };

  // `hostDirectory` is the host's working directory; the requests name `root`.
  const setup = ({ hostDirectory = null, openCodeSkills = null } = {}) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-skill-policy-')));
    tempRoots.push(root);
    fs.mkdirSync(path.join(root, '.git'));
    writeSkill(root, 'alpha-skill', 'Alpha Display');
    const projectConfigPath = path.join(root, '.opencode', 'opencode.json');
    // A watching OpenCode: it serves whatever the config files hold now.
    const policyDeps = {
      ...deps,
      fetchOpenCodeSkillsFromApi: async () => openCodeSkills,
      createOpenCodePolicyReader: () => ({
        readVersion: async () => '2.0.29',
        // A file OpenCode cannot parse is left out of what it serves.
        readConfigEntries: async () => [globalConfigPath, projectConfigPath]
          .filter((file) => fs.existsSync(file))
          .flatMap((file) => {
            const errors = [];
            const info = parseJsonc(fs.readFileSync(file, 'utf8'), errors, { allowTrailingComma: true });
            return errors.length > 0 ? [] : [{ type: 'document', path: file, info: served(info) }];
          }),
      }),
    };
    const ctx = createCtx(hostDirectory ?? root);
    const send = (payload) => handleConfigBridgeMessage({ id: 'policy', type: 'api:config/skill-policy', payload }, ctx, policyDeps);
    const list = (directory) => handleConfigBridgeMessage({ id: 'list', type: 'api:config/skills', payload: { method: 'GET', directory } }, ctx, policyDeps);
    const rename = (name, renameTo, skillId) => handleConfigBridgeMessage({
      id: 'rename', type: 'api:config/skills', payload: { method: 'PATCH', name, skillId, directory: root, body: { renameTo } },
    }, ctx, policyDeps);
    return { root, projectConfigPath, send, list, rename };
  };

  afterEach(() => {
    fs.rmSync(globalConfigPath, { force: true });
  });

  test('switches a skill off and on in the project config by its OpenCode id', async () => {
    const { root, projectConfigPath, send, list } = setup();

    const byName = await send({ directory: root, body: { id: 'Alpha Display', scope: 'project', enabled: false } });
    expect(byName.data).toMatchObject({ status: 404, body: { ok: false, error: { code: 'unknown_skill' } } });

    const off = await send({ directory: root, body: { id: 'alpha-skill', scope: 'project', enabled: false } });
    expect(off.data).toMatchObject({
      status: 200,
      body: {
        ok: true,
        id: 'alpha-skill',
        confirmed: true,
        saved: { scope: 'project', path: projectConfigPath, disabled: true, changed: true },
        policy: { effective: 'disabled', decidedBy: { scope: 'project', owned: true } },
      },
    });
    expect(readJson(projectConfigPath)).toEqual({
      policies: [{ action: 'integration.use', resource: 'skill:alpha-skill', effect: 'deny', openchamber: 'skill-switch' }],
    });
    expect(fs.existsSync(globalConfigPath)).toBe(false);

    const listed = await list(root);
    expect(listed.data.skills.find((skill) => skill.id === 'alpha-skill')).toMatchObject({ name: 'Alpha Display' });
    expect(byId(listed.data.skillPolicy).get('alpha-skill')).toMatchObject({ disabledIn: { project: true }, effective: 'disabled' });

    const on = await send({ directory: root, body: { id: 'alpha-skill', scope: 'project', enabled: true } });
    expect(on.data).toMatchObject({ status: 200, body: { ok: true, saved: { changed: true }, policy: { effective: 'enabled' } } });
    expect(readJson(projectConfigPath)).toEqual({ policies: [] });
  });

  test('reports a switched-off skill as unknown while its project file cannot be parsed, as the web runtime does', async () => {
    const { root, projectConfigPath, send, list } = setup();
    expect((await send({ directory: root, body: { id: 'alpha-skill', scope: 'project', enabled: false } })).data.status).toBe(200);
    const validText = fs.readFileSync(projectConfigPath, 'utf8');

    fs.writeFileSync(projectConfigPath, `${validText.trimEnd().slice(0, -1)} oops }`);
    const broken = (await list(root)).data.skillPolicy;
    expect(broken.effectiveAvailable).toBe(true);
    expect(broken.scopes.project.error).toBeTruthy();
    expect(byId(broken).get('alpha-skill')).toEqual({ disabledIn: { global: false, project: null }, effective: 'unknown', decidedBy: null });

    fs.writeFileSync(projectConfigPath, validText);
    expect(byId((await list(root)).data.skillPolicy).get('alpha-skill')).toMatchObject({ disabledIn: { project: true }, effective: 'disabled' });
  });

  test('gives back the project JSONC byte for byte after a switch goes off and on again', async () => {
    const { root, projectConfigPath, send } = setup();
    const text = '{\n  // project rules\n  "policies": [\n    { "action": "integration.use", "resource": "skill:wild-*", "effect": "deny" }, // keep\n  ],\n}\n';
    fs.writeFileSync(projectConfigPath, text);
    const readJsonc = () => fs.readFileSync(projectConfigPath, 'utf8');
    expect((await send({ directory: root, body: { id: 'alpha-skill', scope: 'project', enabled: false } })).data.status).toBe(200);
    expect(readJsonc()).toContain('// keep');
    expect(readJsonc()).toContain('skill:alpha-skill');
    expect((await send({ directory: root, body: { id: 'alpha-skill', scope: 'project', enabled: true } })).data.status).toBe(200);
    expect(readJsonc()).toBe(text);
  });

  test('lists the skills of the directory the webview names, not the host working directory', async () => {
    const hostDirectory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-host-cwd-')));
    tempRoots.push(hostDirectory);
    writeSkill(hostDirectory, 'host-only', 'Host Only');
    const { root, projectConfigPath, send, list } = setup({ hostDirectory });

    const fromRoot = await list(root);
    expect(fromRoot.data.skills.map((skill) => skill.id)).toContain('alpha-skill');
    expect(fromRoot.data.skills.map((skill) => skill.id)).not.toContain('host-only');
    expect(fromRoot.data.skillPolicy.scopes.project.path).toBe(projectConfigPath);

    const fromHost = await list(undefined);
    expect(fromHost.data.skills.map((skill) => skill.id)).toContain('host-only');

    expect((await send({ directory: root, body: { id: 'alpha-skill', scope: 'project', enabled: false } })).data.status).toBe(200);
    expect(byId((await list(root)).data.skillPolicy).get('alpha-skill')).toMatchObject({ disabledIn: { project: true }, effective: 'disabled' });
  });

  test('keeps two switched-off ids that share a display name listed and switchable when OpenCode lists none', async () => {
    const { root, projectConfigPath, send, list } = setup({ openCodeSkills: [] });
    writeSkill(root, 'beta-one', 'Same Name');
    writeSkill(root, 'beta-two', 'Same Name');
    for (const id of ['beta-one', 'beta-two']) {
      expect((await send({ directory: root, body: { id, scope: 'project', enabled: false } })).data.status).toBe(200);
    }

    const listed = await list(root);
    expect(listed.data.skills.filter((skill) => skill.name === 'Same Name').map((skill) => skill.id).sort()).toEqual(['beta-one', 'beta-two']);
    expect(byId(listed.data.skillPolicy).get('beta-one')).toMatchObject({ disabledIn: { project: true }, effective: 'disabled' });
    expect(byId(listed.data.skillPolicy).get('beta-two')).toMatchObject({ disabledIn: { project: true }, effective: 'disabled' });

    for (const id of ['beta-one', 'beta-two']) {
      expect((await send({ directory: root, body: { id, scope: 'project', enabled: true } })).data.body).toMatchObject({ ok: true, saved: { changed: true } });
    }
    expect(readJson(projectConfigPath)).toEqual({ policies: [] });
  });

  test('keeps a user exact deny through off and on, like the web server', async () => {
    const { root, projectConfigPath, send } = setup();
    const text = JSON.stringify({ policies: [{ action: 'integration.use', resource: 'skill:alpha-skill', effect: 'deny' }] }, null, 2);
    fs.writeFileSync(projectConfigPath, text);
    const off = await send({ directory: root, body: { id: 'alpha-skill', scope: 'project', enabled: false } });
    expect(off.data.body).toMatchObject({ saved: { disabled: false, changed: false }, policy: { effective: 'disabled', decidedBy: { owned: false } } });
    const on = await send({ directory: root, body: { id: 'alpha-skill', scope: 'project', enabled: true } });
    expect(on.data.body).toMatchObject({ saved: { changed: false }, policy: { effective: 'disabled', decidedBy: { owned: false } } });
    expect(fs.readFileSync(projectConfigPath, 'utf8')).toBe(text);
  });

  describe('renaming a switched-off skill keeps it off, like the web server', () => {
    const ownedDeny = (id) => ({ action: 'integration.use', resource: `skill:${id}`, effect: 'deny', openchamber: 'skill-switch' });
    const userDeny = (resource) => ({ action: 'integration.use', resource, effect: 'deny' });

    test('moves the project switch to the new id and leaves user rules alone', async () => {
      const { root, projectConfigPath, send, list, rename } = setup();
      // User rules the switch must not touch: an unrelated wildcard and another skill's exact deny.
      fs.writeFileSync(projectConfigPath, JSON.stringify({ policies: [userDeny('skill:zz-*'), userDeny('skill:other')] }, null, 2));
      expect((await send({ directory: root, body: { id: 'alpha-skill', scope: 'project', enabled: false } })).data.status).toBe(200);

      const renamed = await rename('Alpha Display', 'alpha-renamed', 'alpha-skill');
      expect(renamed.data).toMatchObject({
        id: 'alpha-renamed',
        switches: { carried: [{ scope: 'project', path: projectConfigPath }], oldRuleRemoved: [{ scope: 'project' }] },
      });
      expect(readJson(projectConfigPath)).toEqual({ policies: [userDeny('skill:zz-*'), userDeny('skill:other'), ownedDeny('alpha-renamed')] });
      expect(byId((await list(root)).data.skillPolicy).get('alpha-renamed')).toMatchObject({ disabledIn: { project: true }, effective: 'disabled' });
    });

    test('keeps the old switch while another copy of the old id stays installed', async () => {
      const { root, projectConfigPath, send, rename } = setup();
      const copy = path.join(root, '.claude', 'skills', 'alpha-skill', 'SKILL.md');
      fs.mkdirSync(path.dirname(copy), { recursive: true });
      fs.writeFileSync(copy, '---\nname: Alpha Copy\ndescription: copy\n---\nBody\n');
      expect((await send({ directory: root, body: { id: 'alpha-skill', scope: 'project', enabled: false } })).data.status).toBe(200);

      const renamed = await rename('Alpha Display', 'alpha-renamed', 'alpha-skill');
      expect(renamed.data.switches).toMatchObject({ oldRuleRemoved: [], oldRuleKept: [{ scope: 'project' }] });
      expect(readJson(projectConfigPath)).toEqual({ policies: [ownedDeny('alpha-skill'), ownedDeny('alpha-renamed')] });
    });

    test('refuses the rename, moving nothing, when a scope file cannot be read', async () => {
      const { root, projectConfigPath, send, rename } = setup();
      expect((await send({ directory: root, body: { id: 'alpha-skill', scope: 'project', enabled: false } })).data.status).toBe(200);
      fs.writeFileSync(globalConfigPath, '{ broken');

      const renamed = await rename('Alpha Display', 'alpha-renamed', 'alpha-skill');
      expect(renamed).toMatchObject({ success: false });
      expect(renamed.error).toMatch(/not renamed/);
      expect(fs.existsSync(path.join(root, '.opencode', 'skills', 'alpha-skill', 'SKILL.md'))).toBe(true);
      expect(readJson(projectConfigPath)).toEqual({ policies: [ownedDeny('alpha-skill')] });
    });

    test.skipIf(process.getuid?.() === 0)('takes the carried switch out again when the folder cannot be moved', async () => {
      const { root, projectConfigPath, send, rename } = setup();
      expect((await send({ directory: root, body: { id: 'alpha-skill', scope: 'project', enabled: false } })).data.status).toBe(200);
      const before = fs.readFileSync(projectConfigPath, 'utf8');
      const skillsDir = path.join(root, '.opencode', 'skills');
      fs.chmodSync(skillsDir, 0o555);
      try {
        const renamed = await rename('Alpha Display', 'alpha-renamed', 'alpha-skill');
        expect(renamed).toMatchObject({ success: false });
      } finally {
        fs.chmodSync(skillsDir, 0o755);
      }
      expect(fs.existsSync(path.join(skillsDir, 'alpha-skill', 'SKILL.md'))).toBe(true);
      expect(fs.readFileSync(projectConfigPath, 'utf8')).toBe(before);
    });
  });

  test('writes the global switch to the user config and reports it over the project one', async () => {
    const { root, send } = setup();
    expect((await send({ directory: root, body: { id: 'alpha-skill', scope: 'global', enabled: false } })).data.status).toBe(200);
    expect(readJson(globalConfigPath)).toEqual({
      policies: [{ action: 'integration.use', resource: 'skill:alpha-skill', effect: 'deny', openchamber: 'skill-switch' }],
    });
    const project = await send({ directory: root, body: { id: 'alpha-skill', scope: 'project', enabled: true } });
    expect(project.data.body).toMatchObject({ policy: { effective: 'disabled', decidedBy: { scope: 'global', owned: true } } });
  });

  test('refuses malformed requests, unknown directories and a project switch without a directory', async () => {
    const { root, send } = setup();
    expect((await send({ directory: 42 })).data).toMatchObject({ status: 400, body: { error: { code: 'invalid_request' } } });
    expect((await send({ directory: path.join(root, 'missing'), body: { id: 'alpha-skill', scope: 'global', enabled: false } })).data)
      .toMatchObject({ status: 400, body: { error: { code: 'invalid_directory' } } });
    expect((await send({ body: { id: 'alpha-skill', scope: 'project', enabled: false } })).data)
      .toMatchObject({ status: 400, body: { error: { code: 'directory_required' } } });
  });

  test('answers 503 without writing when OpenCode cannot be read', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-skill-policy-down-'));
    tempRoots.push(root);
    const result = await handleConfigBridgeMessage({
      id: 'policy',
      type: 'api:config/skill-policy',
      payload: { directory: root, body: { id: 'alpha-skill', scope: 'global', enabled: true } },
    }, createCtx(root), deps);
    expect(result.data).toMatchObject({ status: 503, body: { error: { code: 'opencode_unavailable' } } });
    expect(fs.existsSync(globalConfigPath)).toBe(false);
  });
});

describe('VS Code skill routes selected by OpenCode id', () => {
  const write = (root, relative, content) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  const skillMd = (name, body) => `---\nname: ${name}\ndescription: ${name}\n---\n${body}\n`;
  let previousDataDir;

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
    else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
  });

  // Same fixture as the web route tests: two ids share "Same Name" (one nested
  // in a group), one id differs from its display name. The host's working
  // directory is elsewhere; every request names `root`.
  const setup = () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-skill-id-')));
    const hostDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-skill-id-host-'));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-skill-id-data-'));
    tempRoots.push(root, hostDirectory, dataDir);
    previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
    process.env.OPENCHAMBER_DATA_DIR = dataDir;
    fs.mkdirSync(path.join(root, '.git'));
    const files = {
      one: write(root, '.opencode/skills/beta-one/SKILL.md', skillMd('Same Name', 'Body one')),
      oneNotes: write(root, '.opencode/skills/beta-one/notes.md', 'notes one'),
      two: write(root, '.opencode/skills/group/beta-two/SKILL.md', skillMd('Same Name', 'Body two')),
      twoNotes: write(root, '.opencode/skills/group/beta-two/notes.md', 'notes two'),
      display: write(root, '.opencode/skills/display-id/SKILL.md', skillMd('Display Name', 'Display body')),
    };
    const ctx = createCtx(hostDirectory);
    const skill = (payload) => handleConfigBridgeMessage({ id: 'skill', type: 'api:config/skills', payload: { directory: root, ...payload } }, ctx, deps);
    const file = (payload) => handleConfigBridgeMessage({ id: 'file', type: 'api:config/skills/files', payload: { directory: root, ...payload } }, ctx, deps);
    return { root, files, ctx, skill, file };
  };

  test('reads the exact skill an id names and never another with the same display name', async () => {
    const { files, skill } = setup();
    const two = await skill({ method: 'GET', name: 'Same Name', skillId: 'beta-two' });
    expect(two.data).toMatchObject({ name: 'Same Name', id: 'beta-two', path: files.two });
    expect(two.data.sources.md.instructions.trim()).toBe('Body two');
    expect((await skill({ method: 'GET', name: 'Same Name', skillId: 'beta-one' })).data.sources.md.instructions.trim()).toBe('Body one');
    expect(await skill({ method: 'GET', name: 'Same Name', skillId: 'display-id' })).toMatchObject({ success: false, error: 'Skill not found' });
    expect(await skill({ method: 'GET', name: 'Same Name', skillId: 'bad*id' })).toMatchObject({ success: false, error: 'Invalid skill id' });
    expect((await skill({ method: 'GET', name: 'Display Name' })).data).toMatchObject({ id: 'display-id', path: files.display });
  });

  test('reads, writes and deletes supporting files of the selected skill only', async () => {
    const { files, file } = setup();
    expect((await file({ method: 'GET', name: 'Same Name', skillId: 'beta-two', filePath: 'notes.md' })).data).toEqual({ content: 'notes two' });
    await file({ method: 'PUT', name: 'Same Name', skillId: 'beta-two', filePath: 'notes.md', content: 'edited two' });
    expect(fs.readFileSync(files.twoNotes, 'utf8')).toBe('edited two');
    expect(fs.readFileSync(files.oneNotes, 'utf8')).toBe('notes one');
    await file({ method: 'DELETE', name: 'Same Name', skillId: 'beta-one', filePath: 'notes.md' });
    expect(fs.existsSync(files.oneNotes)).toBe(false);
    expect(fs.existsSync(files.twoNotes)).toBe(true);
    await expect(file({ method: 'GET', name: 'Same Name', skillId: 'beta-one', filePath: '../group/beta-two/notes.md' }))
      .rejects.toThrow('Access to file denied');
    await expect(file({ method: 'PUT', name: 'Same Name', skillId: 'beta-one', filePath: '../group/beta-two/notes.md', content: 'x' }))
      .rejects.toThrow('Access to file denied');
    expect(fs.readFileSync(files.twoNotes, 'utf8')).toBe('edited two');
  });

  test('updates the selected skill only and refuses a target path that is not it', async () => {
    const { root, files, skill } = setup();
    const updated = await skill({ method: 'PATCH', name: 'Same Name', skillId: 'beta-two', body: { instructions: 'New body two' } });
    expect(updated.data).toMatchObject({ id: 'beta-two', path: files.two });
    expect(fs.readFileSync(files.two, 'utf8')).toContain('New body two');
    expect(fs.readFileSync(files.one, 'utf8')).toContain('Body one');
    expect(await skill({ method: 'PATCH', name: 'Same Name', skillId: 'beta-two', body: { instructions: 'x', targetPath: files.one } }))
      .toMatchObject({ success: false, error: 'targetPath does not match the selected skill' });
    const outside = write(root, 'elsewhere/SKILL.md', skillMd('Same Name', 'Outside'));
    expect(await skill({ method: 'PATCH', name: 'Same Name', body: { instructions: 'x', targetPath: outside } }))
      .toMatchObject({ success: false, error: 'targetPath is not a known skill file' });
    expect(fs.readFileSync(outside, 'utf8')).toContain('Outside');
    expect(fs.readFileSync(files.one, 'utf8')).toContain('Body one');
  });

  test('renames the selected nested skill, whose folder and so its id take the new name', async () => {
    const { root, files, ctx, skill } = setup();
    const renamed = await skill({ method: 'PATCH', name: 'Same Name', skillId: 'beta-two', body: { renameTo: 'beta-renamed' } });
    const newPath = path.join(root, '.opencode', 'skills', 'group', 'beta-renamed', 'SKILL.md');
    expect(renamed.data).toMatchObject({ name: 'beta-renamed', id: 'beta-renamed', path: newPath });
    expect(ctx.restart).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(newPath, 'utf8')).toContain('Body two');
    expect(fs.existsSync(files.two)).toBe(false);
    expect(fs.readFileSync(files.one, 'utf8')).toContain('name: Same Name');
    const clash = await skill({ method: 'PATCH', name: 'Display Name', skillId: 'display-id', body: { renameTo: 'beta-one' } });
    expect(clash).toMatchObject({ success: false });
    expect(clash.error).toMatch(/already exists/);
    expect(fs.existsSync(files.display)).toBe(true);
  });

  test('deletes exactly the selected skill folder, nested ones included, and its own install record', async () => {
    const { root, files, skill } = setup();
    const { appendInstalledSources, readInstalledSources } = await import('../../web/server/lib/skills-catalog/installed-sources.js');
    appendInstalledSources([
      { skillName: 'beta-one', skillDir: 'skills/beta-one', sourceId: 'acme' },
      { skillName: 'beta-two', skillDir: 'skills/beta-two', sourceId: 'acme' },
    ]);
    const removed = await skill({ method: 'DELETE', name: 'Same Name', skillId: 'beta-two' });
    expect(removed.data).toMatchObject({ id: 'beta-two', path: files.two });
    expect(fs.existsSync(path.dirname(files.two))).toBe(false);
    expect(fs.existsSync(path.join(root, '.opencode', 'skills', 'group'))).toBe(true);
    expect(fs.readFileSync(files.one, 'utf8')).toContain('Body one');
    expect([...readInstalledSources().keys()]).toEqual(['beta-one']);
    expect(await skill({ method: 'DELETE', name: 'Same Name', skillId: 'beta-two' })).toMatchObject({ success: false, error: 'Skill not found' });
  });
});

describe('VS Code located skill delete, as the web route', () => {
  const skillMd = (name) => `---\nname: ${name}\ndescription: ${name}\n---\nBody\n`;
  const userSkillsDir = path.join(process.env.XDG_CONFIG_HOME, 'opencode', 'skills');
  let previousDataDir;

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
    else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
  });

  // The catalog's shape: its copy in the user's OpenCode skills folder, whose
  // folder (the id) differs from the display name, plus a project copy of the
  // same id the user keeps.
  const setup = () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-skill-located-')));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-skill-located-data-'));
    tempRoots.push(root, dataDir);
    previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
    process.env.OPENCHAMBER_DATA_DIR = dataDir;
    fs.mkdirSync(path.join(root, '.git'));
    const userCopy = path.join(userSkillsDir, 'vendor-folder');
    const projectCopy = path.join(root, '.claude', 'skills', 'vendor-folder');
    for (const dir of [userCopy, projectCopy]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), skillMd('Vendor Skill'));
    }
    tempRoots.push(userCopy);
    const ctx = createCtx(root);
    const skill = (payload) => handleConfigBridgeMessage({ id: 'skill', type: 'api:config/skills', payload: { directory: root, ...payload } }, ctx, deps);
    return { userCopy, projectCopy, skill };
  };

  test('deletes only the located folder the id names and keeps provenance while a copy of the id remains', async () => {
    const { userCopy, projectCopy, skill } = setup();
    const { appendInstalledSources, readInstalledSources } = await import('../../web/server/lib/skills-catalog/installed-sources.js');
    appendInstalledSources([{ skillName: 'vendor-folder', skillDir: 'skills/vendor-folder', sourceId: 'acme' }]);

    const removed = await skill({ method: 'DELETE', name: 'Vendor Skill', skillId: 'vendor-folder', scope: 'user', source: 'opencode' });

    expect(removed).toMatchObject({ success: true, data: { id: 'vendor-folder' } });
    expect(fs.existsSync(userCopy)).toBe(false);
    expect(fs.existsSync(path.join(projectCopy, 'SKILL.md'))).toBe(true);
    expect([...readInstalledSources().keys()]).toEqual(['vendor-folder']);

    await skill({ method: 'DELETE', name: 'Vendor Skill', skillId: 'vendor-folder', scope: 'project', source: 'claude' });
    expect(fs.existsSync(projectCopy)).toBe(false);
    expect([...readInstalledSources().keys()]).toEqual([]);
  });

  test('refuses an invalid location or id before deleting anything', async () => {
    const { userCopy, projectCopy, skill } = setup();
    const invalid = 'scope must be user or project and source opencode, claude or agents';

    expect(await skill({ method: 'DELETE', name: 'Vendor Skill', skillId: 'vendor-folder', scope: 'user', source: 'elsewhere' }))
      .toMatchObject({ success: false, error: invalid });
    expect(await skill({ method: 'DELETE', name: 'Vendor Skill', skillId: 'vendor-folder', scope: 'project' }))
      .toMatchObject({ success: false, error: invalid });
    expect(await skill({ method: 'DELETE', name: 'Vendor Skill', skillId: 'bad*id', scope: 'user', source: 'opencode' }))
      .toMatchObject({ success: false, error: 'Invalid skill id' });
    expect(fs.existsSync(path.join(userCopy, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(projectCopy, 'SKILL.md'))).toBe(true);
  });

  test('fails without touching other copies when the location has none', async () => {
    const { userCopy, projectCopy, skill } = setup();

    await expect(skill({ method: 'DELETE', name: 'Vendor Skill', skillId: 'vendor-folder', scope: 'project', source: 'agents' }))
      .rejects.toThrow('Skill "vendor-folder" not found');
    expect(fs.existsSync(path.join(userCopy, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(projectCopy, 'SKILL.md'))).toBe(true);
  });
});

describe('VS Code skill delete through symlinks, as the web server', () => {
  const writeSkill = (dir, name) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\nBody\n`);
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'keep');
  };
  let previous;

  // A scratch home keeps the user skill roots and discovery off the real
  // ~/.claude and ~/.agents; the user OpenCode root is the scratch XDG one.
  const setup = () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-skill-link-home-')));
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-skill-link-')));
    const library = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-skill-link-library-')));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-skill-link-data-'));
    tempRoots.push(home, root, library, dataDir);
    previous = { HOME: process.env.HOME, OPENCHAMBER_DATA_DIR: process.env.OPENCHAMBER_DATA_DIR };
    process.env.HOME = home;
    process.env.OPENCHAMBER_DATA_DIR = dataDir;
    fs.mkdirSync(path.join(root, '.git'));
    const ctx = createCtx(root);
    const skill = (payload) => handleConfigBridgeMessage({ id: 'skill', type: 'api:config/skills', payload: { directory: root, ...payload } }, ctx, deps);
    return { root, library, skill };
  };

  afterEach(() => {
    if (!previous) return;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    previous = undefined;
  });

  test('refuses a listed nested skill reached through a group symlink that leads out of the root', async () => {
    const { root, library, skill } = setup();
    writeSkill(path.join(library, 'example'), 'Example');
    fs.mkdirSync(path.join(root, '.opencode', 'skills'), { recursive: true });
    fs.symlinkSync(library, path.join(root, '.opencode', 'skills', 'group'), 'dir');

    expect(await skill({ method: 'DELETE', name: 'Example', skillId: 'example' }))
      .toMatchObject({ success: false, error: 'Skill "Example" is outside managed skill directories and cannot be deleted' });
    expect(fs.readFileSync(path.join(library, 'example', 'keep.txt'), 'utf8')).toBe('keep');
  });

  test('deletes a nested skill in a real group folder and keeps its sibling', async () => {
    const { root, skill } = setup();
    writeSkill(path.join(root, '.opencode', 'skills', 'group', 'example'), 'Example');
    writeSkill(path.join(root, '.opencode', 'skills', 'group', 'sibling'), 'Sibling');

    expect(await skill({ method: 'DELETE', name: 'Example', skillId: 'example' })).toMatchObject({ success: true });
    expect(fs.existsSync(path.join(root, '.opencode', 'skills', 'group', 'example'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.opencode', 'skills', 'group', 'sibling', 'SKILL.md'))).toBe(true);
  });

  test('removes only the link of a skill folder that is itself a symlink, by id and by location', async () => {
    const { root, library, skill } = setup();
    writeSkill(path.join(library, 'linked'), 'Linked');
    writeSkill(path.join(library, 'located'), 'Located');
    fs.mkdirSync(path.join(root, '.opencode', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(root, '.claude', 'skills'), { recursive: true });
    fs.symlinkSync(path.join(library, 'linked'), path.join(root, '.opencode', 'skills', 'linked'), 'dir');
    fs.symlinkSync(path.join(library, 'located'), path.join(root, '.claude', 'skills', 'located'), 'dir');

    expect(await skill({ method: 'DELETE', name: 'Linked', skillId: 'linked' })).toMatchObject({ success: true });
    expect(await skill({ method: 'DELETE', name: 'Located', skillId: 'located', scope: 'project', source: 'claude' })).toMatchObject({ success: true });

    expect(fs.existsSync(path.join(root, '.opencode', 'skills', 'linked'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.claude', 'skills', 'located'))).toBe(false);
    expect(fs.readFileSync(path.join(library, 'linked', 'keep.txt'), 'utf8')).toBe('keep');
    expect(fs.readFileSync(path.join(library, 'located', 'keep.txt'), 'utf8')).toBe('keep');
  });

  test('treats a managed root that is itself a symlink as its target', async () => {
    const { root, library, skill } = setup();
    writeSkill(path.join(library, 'group', 'example'), 'Example');
    writeSkill(path.join(library, 'group', 'sibling'), 'Sibling');
    fs.mkdirSync(path.join(root, '.opencode'));
    fs.symlinkSync(library, path.join(root, '.opencode', 'skills'), 'dir');

    expect(await skill({ method: 'DELETE', name: 'Example', skillId: 'example' })).toMatchObject({ success: true });
    expect(fs.existsSync(path.join(library, 'group', 'example'))).toBe(false);
    expect(fs.existsSync(path.join(library, 'group', 'sibling', 'SKILL.md'))).toBe(true);
  });

  test('refuses a name that is not one folder name, located or not, as the web route', async () => {
    const { root, skill } = setup();
    writeSkill(path.join(root, '.claude', 'skills', 'example'), 'Example');

    for (const name of ['..', '.', 'a/b', 'a\\b']) {
      expect(await skill({ method: 'DELETE', name, scope: 'project', source: 'claude' })).toMatchObject({ success: false, error: 'Invalid skill name' });
      expect(await skill({ method: 'DELETE', name })).toMatchObject({ success: false, error: 'Invalid skill name' });
    }
    expect(fs.existsSync(path.join(root, '.claude', 'skills', 'example', 'keep.txt'))).toBe(true);
  });
});
