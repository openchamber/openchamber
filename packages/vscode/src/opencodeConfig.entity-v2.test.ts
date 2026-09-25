import { after, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'yaml';

// Path constants freeze when the module loads, so point XDG_CONFIG_HOME at a
// scratch directory BEFORE importing. Nothing here may touch the real
// ~/.config/opencode.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-entity-v2-'));
process.env.XDG_CONFIG_HOME = path.join(root, 'xdg');
process.env.OPENCODE_CONFIG = '';

// Deferred so the env above is in place first; tsx compiles this file to CJS,
// where top-level await is unavailable.
let configModule: Promise<typeof import('./opencodeConfig')> | undefined;
const loadConfig = () => (configModule ??= import('./opencodeConfig'));

let projectDir: string;

const write = (relativePath: string, content: string) => {
  const filePath = path.join(projectDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
};

const readJson = (filePath: string) => JSON.parse(fs.readFileSync(filePath, 'utf8'));

const readMd = (filePath: string) => {
  const content = fs.readFileSync(filePath, 'utf8');
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content.trim() };
  return { frontmatter: yaml.parse(match[1]) || {}, body: match[2].trim() };
};

describe('VS Code entity modules speak OpenCode 2 shapes', () => {
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(root, 'project-'));
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.OPENCODE_CONFIG;
  });

  test('reads a v1 agent markdown file and answers the v2 shape', async () => {
    const { getAgentConfig } = await loadConfig();
    write('.opencode/agent/reviewer.md', [
      '---',
      'description: Reviewer',
      'model: anthropic/claude-sonnet-4-5',
      'variant: high',
      'temperature: 0.4',
      'maxSteps: 9',
      'permission:',
      '  bash:',
      '    "git push *": ask',
      '  edit: deny',
      '---',
      '',
      'Review for correctness.',
    ].join('\n'));

    const result = getAgentConfig('reviewer', projectDir);
    assert.equal(result.source, 'md');
    assert.equal(result.legacy, true);
    assert.deepEqual(result.config, {
      description: 'Reviewer',
      model: 'anthropic/claude-sonnet-4-5#high',
      steps: 9,
      system: 'Review for correctness.',
      request: { body: { temperature: 0.4 } },
      permissions: [
        { action: 'shell', resource: 'git push *', effect: 'ask' },
        { action: 'edit', resource: '*', effect: 'deny' },
      ],
    });
  });

  test('rewrites a v1 agent file in place, at its own path, in v2 shape', async () => {
    const { updateAgent } = await loadConfig();
    const agentPath = write('.opencode/agent/reviewer.md', [
      '---',
      'description: Reviewer',
      'temperature: 0.4',
      'permission:',
      '  bash: ask',
      '---',
      '',
      'Old prompt.',
    ].join('\n'));

    const result = updateAgent('reviewer', { description: 'Careful reviewer' }, projectDir);

    // Same file: OpenChamber never moves an entity between directories.
    assert.equal(result.path, agentPath);
    assert.equal(fs.existsSync(path.join(projectDir, '.opencode', 'agents', 'reviewer.md')), false);

    const parsed = readMd(agentPath);
    assert.deepEqual(parsed.frontmatter, {
      description: 'Careful reviewer',
      request: { body: { temperature: 0.4 } },
      permissions: [{ action: 'shell', resource: '*', effect: 'ask' }],
    });
    assert.equal(parsed.body, 'Old prompt.');
  });

  test('writes the permission rule array when the client sends a v1 map', async () => {
    const { updateAgent } = await loadConfig();
    write('.opencode/agents/reviewer.md', '---\ndescription: Reviewer\n---\n\nPrompt.\n');

    updateAgent('reviewer', { permission: { task: 'deny', write: 'allow' } }, projectDir);

    const parsed = readMd(path.join(projectDir, '.opencode', 'agents', 'reviewer.md'));
    assert.deepEqual(parsed.frontmatter.permissions, [
      { action: 'subagent', resource: '*', effect: 'deny' },
      { action: 'edit', resource: '*', effect: 'allow' },
    ]);
    assert.equal(parsed.frontmatter.permission, undefined);
  });

  test('creates a new agent in the v2 agents directory', async () => {
    const { createAgent } = await loadConfig();
    createAgent('fresh', { description: 'Fresh', system: 'Do the thing.' }, projectDir, 'project');

    const created = path.join(projectDir, '.opencode', 'agents', 'fresh.md');
    assert.equal(fs.existsSync(created), true);
    assert.deepEqual(readMd(created), { frontmatter: { description: 'Fresh' }, body: 'Do the thing.' });
  });

  test('moves a v1 JSON agent entry into the agents section of the same file', async () => {
    const { updateAgent } = await loadConfig();
    const configPath = write('opencode.json', JSON.stringify({
      agent: {
        reviewer: { prompt: 'Old', permission: { bash: 'ask' } },
        other: { prompt: 'Untouched' },
      },
    }, null, 2));

    updateAgent('reviewer', { system: 'New' }, projectDir);

    const written = readJson(configPath);
    assert.deepEqual(written.agent, { other: { prompt: 'Untouched' } });
    assert.deepEqual(written.agents.reviewer, {
      system: 'New',
      permissions: [{ action: 'shell', resource: '*', effect: 'ask' }],
    });
  });

  test('clears v1 fields at the v2 location they moved to', async () => {
    const { updateAgent } = await loadConfig();
    const configPath = write('opencode.json', JSON.stringify({
      agent: { build: { variant: 'fast', temperature: 0.3, top_p: 0.8, mode: 'subagent' } },
    }, null, 2));

    // The client still names the v1 fields, but on a v2 entity `variant` is the
    // `#` suffix on `model` and `temperature`/`top_p` live in `request.body`.
    updateAgent('build', { variant: null, temperature: null, top_p: null }, projectDir);

    const written = readJson(configPath);
    assert.equal(written.agent, undefined);
    assert.deepEqual(written.agents.build, { mode: 'subagent' });
  });

  test('drops only the variant when a model is set', async () => {
    const { updateAgent } = await loadConfig();
    write('.opencode/agents/reviewer.md', '---\nmodel: anthropic/claude-sonnet-4-5#high\n---\n\nPrompt.\n');

    updateAgent('reviewer', { variant: null }, projectDir);

    const parsed = readMd(path.join(projectDir, '.opencode', 'agents', 'reviewer.md'));
    assert.equal(parsed.frontmatter.model, 'anthropic/claude-sonnet-4-5');
  });

  test('reports global and agent rules in evaluation order', async () => {
    const { getAgentPermissions } = await loadConfig();
    write('opencode.json', JSON.stringify({ permission: { edit: 'allow' }, tools: { websearch: false } }, null, 2));
    write('.opencode/agents/reviewer.md', [
      '---',
      'permissions:',
      '  - action: edit',
      '    resource: "*"',
      '    effect: deny',
      '---',
      '',
      'Prompt.',
    ].join('\n'));

    const result = getAgentPermissions('reviewer', projectDir);
    assert.deepEqual(result.agent, [{ action: 'edit', resource: '*', effect: 'deny' }]);
    assert.deepEqual(result.effective, [
      { action: 'websearch', resource: '*', effect: 'deny', source: 'global' },
      { action: 'edit', resource: '*', effect: 'allow', source: 'global' },
      { action: 'edit', resource: '*', effect: 'deny', source: 'agent' },
    ]);
  });

  test('reads a v1 command file and rewrites it in place as subagent', async () => {
    const { getCommandConfig, updateCommand } = await loadConfig();
    const commandPath = write('.opencode/command/review.md', [
      '---',
      'description: Review',
      'model: anthropic/claude-sonnet-4-5',
      'variant: high',
      'subtask: true',
      '---',
      '',
      'Review the current changes.',
    ].join('\n'));

    assert.deepEqual(getCommandConfig('review', projectDir).config, {
      description: 'Review',
      model: 'anthropic/claude-sonnet-4-5#high',
      subagent: true,
      template: 'Review the current changes.',
    });

    const result = updateCommand('review', { description: 'Review changes' }, projectDir);
    assert.equal(result.path, commandPath);
    assert.deepEqual(readMd(commandPath).frontmatter, {
      description: 'Review changes',
      model: 'anthropic/claude-sonnet-4-5#high',
      subagent: true,
    });
  });

  test('rewrites a v1 theme color as the hex OpenCode migrates it to', async () => {
    const { updateAgent } = await loadConfig();
    const agentPath = write('.opencode/agent/tinted.md', [
      '---',
      'description: Tinted',
      'color: primary',
      '---',
      '',
      'Prompt.',
    ].join('\n'));

    updateAgent('tinted', { description: 'Still tinted' }, projectDir);

    assert.deepEqual(readMd(agentPath).frontmatter, { description: 'Still tinted', color: '#aaaaaa' });
  });

  test('answers the project v1 override when the user file already holds the v2 spelling', async () => {
    const { getMcpConfig, listMcpConfigs, updateMcpConfig } = await loadConfig();
    const userConfigPath = path.join(process.env.XDG_CONFIG_HOME as string, 'opencode', 'opencode.json');
    fs.mkdirSync(path.dirname(userConfigPath), { recursive: true });
    fs.writeFileSync(userConfigPath, JSON.stringify({
      mcp: { servers: { docs: { type: 'remote', url: 'https://global.example.com/mcp' } } },
    }, null, 2), 'utf8');
    const projectConfigPath = write('.opencode/opencode.json', JSON.stringify({
      mcp: { docs: { type: 'remote', url: 'https://project.example.com/mcp', timeout: 5000 } },
    }, null, 2));

    try {
      const entry = getMcpConfig('docs', projectDir);
      assert.equal(entry?.type === 'remote' ? entry.url : null, 'https://project.example.com/mcp');
      assert.equal(entry?.scope, 'project');
      assert.equal(entry?.legacy, true);
      const listed = listMcpConfigs(projectDir).find((item) => item.name === 'docs');
      assert.equal(listed?.type === 'remote' ? listed.url : null, 'https://project.example.com/mcp');

      updateMcpConfig('docs', { timeout: { catalog: 9000, execution: 9000 } }, projectDir);

      assert.deepEqual(readJson(projectConfigPath).mcp, {
        servers: { docs: { type: 'remote', url: 'https://project.example.com/mcp', timeout: { catalog: 9000, execution: 9000 } } },
      });
      assert.equal(readJson(userConfigPath).mcp.servers.docs.url, 'https://global.example.com/mcp');
    } finally {
      fs.rmSync(userConfigPath, { force: true });
    }
  });

  test('reads a v1 mcp entry and rewrites it under mcp.servers in the same file', async () => {
    const { getMcpConfig, updateMcpConfig } = await loadConfig();
    const configPath = write('opencode.json', JSON.stringify({
      mcp: { playwright: { type: 'local', command: ['npx', '@playwright/mcp'], enabled: true, timeout: 30000 } },
    }, null, 2));

    const entry = getMcpConfig('playwright', projectDir);
    assert.equal(entry?.type, 'local');
    assert.equal(entry?.disabled, false);
    assert.deepEqual(entry?.timeout, { catalog: 30000, execution: 30000 });
    assert.equal(entry?.legacy, true);

    updateMcpConfig('playwright', { disabled: true }, projectDir);

    const written = readJson(configPath);
    assert.equal(written.mcp.playwright, undefined);
    assert.deepEqual(written.mcp.servers.playwright, {
      type: 'local',
      command: ['npx', '@playwright/mcp'],
      disabled: true,
      timeout: { catalog: 30000, execution: 30000 },
    });
  });
});
