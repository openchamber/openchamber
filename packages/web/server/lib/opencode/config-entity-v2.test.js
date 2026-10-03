import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// The path constants are frozen when the modules load, so point
// XDG_CONFIG_HOME at a scratch directory BEFORE importing them. Nothing in this
// file may touch the real ~/.config/opencode.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-entity-v2-'));
process.env.XDG_CONFIG_HOME = path.join(root, 'xdg');
delete process.env.OPENCODE_CONFIG;

const { parseMdFile } = await import('./shared.js');
const { getAgentConfig, getAgentPermissions, updateAgent, createAgent } = await import('./agents.js');
const { getCommandConfig, updateCommand } = await import('./commands.js');
const { getMcpConfig, listMcpConfigs, updateMcpConfig } = await import('./mcp.js');

let projectDir;

function write(relativePath, content) {
  const filePath = path.join(projectDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

describe('entity modules speak OpenCode 2 shapes', () => {
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(root, 'project-'));
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.XDG_CONFIG_HOME;
  });

  it('reads a v1 agent markdown file and answers the v2 shape', () => {
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
    expect(result.source).toBe('md');
    expect(result.legacy).toBe(true);
    expect(result.config).toEqual({
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

  it('rewrites a v1 agent file in place, at its own path, in v2 shape', () => {
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
    expect(result.path).toBe(agentPath);
    expect(fs.existsSync(path.join(projectDir, '.opencode', 'agents', 'reviewer.md'))).toBe(false);

    const parsed = parseMdFile(agentPath);
    expect(parsed.frontmatter).toEqual({
      description: 'Careful reviewer',
      request: { body: { temperature: 0.4 } },
      permissions: [{ action: 'shell', resource: '*', effect: 'ask' }],
    });
    expect(parsed.body).toBe('Old prompt.');
  });

  it('writes the permission rule array when the client sends a v1 map', () => {
    write('.opencode/agents/reviewer.md', '---\ndescription: Reviewer\n---\n\nPrompt.\n');

    updateAgent('reviewer', { permission: { task: 'deny', write: 'allow' } }, projectDir);

    const parsed = parseMdFile(path.join(projectDir, '.opencode', 'agents', 'reviewer.md'));
    expect(parsed.frontmatter.permissions).toEqual([
      { action: 'subagent', resource: '*', effect: 'deny' },
      { action: 'edit', resource: '*', effect: 'allow' },
    ]);
    expect(parsed.frontmatter.permission).toBeUndefined();
  });

  it('creates a new agent in the v2 agents directory', () => {
    createAgent('fresh', { description: 'Fresh', system: 'Do the thing.' }, projectDir, 'project');

    const created = path.join(projectDir, '.opencode', 'agents', 'fresh.md');
    expect(fs.existsSync(created)).toBe(true);
    expect(parseMdFile(created)).toEqual({
      frontmatter: { description: 'Fresh' },
      body: 'Do the thing.',
    });
  });

  it('moves a v1 JSON agent entry into the agents section of the same file', () => {
    const configPath = write('opencode.json', JSON.stringify({
      agent: {
        reviewer: { prompt: 'Old', permission: { bash: 'ask' } },
        other: { prompt: 'Untouched' },
      },
    }, null, 2));

    updateAgent('reviewer', { system: 'New' }, projectDir);

    const written = readJson(configPath);
    expect(written.agent).toEqual({ other: { prompt: 'Untouched' } });
    expect(written.agents.reviewer).toEqual({
      system: 'New',
      permissions: [{ action: 'shell', resource: '*', effect: 'ask' }],
    });
  });

  it('clears v1 fields at the v2 location they moved to', () => {
    const configPath = write('opencode.json', JSON.stringify({
      agent: { build: { variant: 'fast', temperature: 0.3, top_p: 0.8, mode: 'subagent' } },
    }, null, 2));

    // The client still names the v1 fields, but on a v2 entity `variant` is the
    // `#` suffix on `model` and `temperature`/`top_p` live in `request.body`.
    updateAgent('build', { variant: null, temperature: null, top_p: null }, projectDir);

    const written = readJson(configPath);
    expect(written.agent).toBeUndefined();
    expect(written.agents.build).toEqual({ mode: 'subagent' });
  });

  it('drops only the variant when a model is set', () => {
    write('.opencode/agents/reviewer.md', '---\nmodel: anthropic/claude-sonnet-4-5#high\n---\n\nPrompt.\n');

    updateAgent('reviewer', { variant: null }, projectDir);

    const parsed = parseMdFile(path.join(projectDir, '.opencode', 'agents', 'reviewer.md'));
    expect(parsed.frontmatter.model).toBe('anthropic/claude-sonnet-4-5');
  });

  it('reports global and agent rules in evaluation order', () => {
    write('opencode.json', JSON.stringify({
      permission: { edit: 'allow' },
      tools: { websearch: false },
    }, null, 2));
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
    expect(result.agent).toEqual([{ action: 'edit', resource: '*', effect: 'deny' }]);
    expect(result.effective).toEqual([
      { action: 'websearch', resource: '*', effect: 'deny', source: 'global' },
      { action: 'edit', resource: '*', effect: 'allow', source: 'global' },
      { action: 'edit', resource: '*', effect: 'deny', source: 'agent' },
    ]);
  });

  it('reads a v1 command file and rewrites it in place as subagent', () => {
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

    expect(getCommandConfig('review', projectDir).config).toEqual({
      description: 'Review',
      model: 'anthropic/claude-sonnet-4-5#high',
      subagent: true,
      template: 'Review the current changes.',
    });

    const result = updateCommand('review', { description: 'Review changes' }, projectDir);
    expect(result.path).toBe(commandPath);
    expect(parseMdFile(commandPath).frontmatter).toEqual({
      description: 'Review changes',
      model: 'anthropic/claude-sonnet-4-5#high',
      subagent: true,
    });
  });

  it('rewrites a v1 theme color as the hex OpenCode migrates it to', () => {
    const agentPath = write('.opencode/agent/tinted.md', [
      '---',
      'description: Tinted',
      'color: primary',
      '---',
      '',
      'Prompt.',
    ].join('\n'));

    updateAgent('tinted', { description: 'Still tinted' }, projectDir);

    // `primary` is not a v2 color; the native decoder would skip the whole file.
    expect(parseMdFile(agentPath).frontmatter).toEqual({ description: 'Still tinted', color: '#aaaaaa' });
  });

  it('answers the project v1 override when the user file already holds the v2 spelling', () => {
    const userConfigPath = path.join(process.env.XDG_CONFIG_HOME, 'opencode', 'opencode.json');
    fs.mkdirSync(path.dirname(userConfigPath), { recursive: true });
    fs.writeFileSync(userConfigPath, JSON.stringify({
      mcp: { servers: { docs: { type: 'remote', url: 'https://global.example.com/mcp' } } },
    }, null, 2), 'utf8');
    const projectConfigPath = write('.opencode/opencode.json', JSON.stringify({
      mcp: { docs: { type: 'remote', url: 'https://project.example.com/mcp', timeout: 5000 } },
    }, null, 2));

    try {
      expect(getMcpConfig('docs', projectDir)).toEqual(expect.objectContaining({
        url: 'https://project.example.com/mcp',
        scope: 'project',
        legacy: true,
      }));
      expect(listMcpConfigs(projectDir).find((entry) => entry.name === 'docs').url).toBe('https://project.example.com/mcp');

      updateMcpConfig('docs', { timeout: { catalog: 9000, execution: 9000 } }, projectDir);

      expect(readJson(projectConfigPath).mcp).toEqual({
        servers: { docs: { type: 'remote', url: 'https://project.example.com/mcp', timeout: { catalog: 9000, execution: 9000 } } },
      });
      expect(readJson(userConfigPath).mcp.servers.docs.url).toBe('https://global.example.com/mcp');
    } finally {
      fs.rmSync(userConfigPath, { force: true });
    }
  });

  it('lists servers from a global opencode.jsonc next to opencode.json and edits them in place', () => {
    const configDir = path.join(process.env.XDG_CONFIG_HOME, 'opencode');
    const jsonPath = path.join(configDir, 'opencode.json');
    const jsoncPath = path.join(configDir, 'opencode.jsonc');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify({ autoupdate: true }, null, 2), 'utf8');
    fs.writeFileSync(jsoncPath, [
      '{',
      '  // servers live only in the jsonc file',
      '  "mcp": { "servers": { "docs": { "type": "remote", "url": "https://docs.example.com/mcp" } } }',
      '}',
    ].join('\n'), 'utf8');

    try {
      expect(listMcpConfigs(projectDir).map((entry) => entry.name)).toContain('docs');
      expect(getMcpConfig('docs', projectDir)).toEqual(expect.objectContaining({ scope: 'user' }));

      updateMcpConfig('docs', { disabled: true }, projectDir);

      expect(getMcpConfig('docs', projectDir)).toEqual(expect.objectContaining({ disabled: true }));
      expect(readJson(jsonPath)).toEqual({ autoupdate: true });
    } finally {
      fs.rmSync(jsonPath, { force: true });
      fs.rmSync(jsoncPath, { force: true });
    }
  });

  it('reads a v1 mcp entry and rewrites it under mcp.servers in the same file', () => {
    const configPath = write('opencode.json', JSON.stringify({
      mcp: {
        playwright: { type: 'local', command: ['npx', '@playwright/mcp'], enabled: true, timeout: 30000 },
      },
    }, null, 2));

    expect(getMcpConfig('playwright', projectDir)).toEqual(expect.objectContaining({
      name: 'playwright',
      type: 'local',
      disabled: false,
      timeout: { catalog: 30000, execution: 30000 },
      legacy: true,
    }));

    updateMcpConfig('playwright', { disabled: true }, projectDir);

    const written = readJson(configPath);
    expect(written.mcp.playwright).toBeUndefined();
    expect(written.mcp.servers.playwright).toEqual({
      type: 'local',
      command: ['npx', '@playwright/mcp'],
      disabled: true,
      timeout: { catalog: 30000, execution: 30000 },
    });
  });
});
