import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// The path constants are frozen when the modules load, so point
// XDG_CONFIG_HOME and OPENCODE_SYSTEM_CONFIG_DIR at scratch directories BEFORE
// importing them. Nothing in this file may touch the real ~/.config/opencode
// or the real /etc/opencode.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-entity-system-'));
process.env.XDG_CONFIG_HOME = path.join(root, 'xdg');
process.env.OPENCODE_SYSTEM_CONFIG_DIR = path.join(root, 'system');
delete process.env.OPENCODE_CONFIG;

const { getAgentConfig, getAgentSources, getAgentPermissions, updateAgent, createAgent, deleteAgent, listDisabledAgents } = await import('./agents.js');

let projectDir;

function write(absoluteDir, relativePath, content) {
  const filePath = path.join(absoluteDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

function writeProject(relativePath, content) {
  return write(projectDir, relativePath, content);
}

function writeSystem(relativePath, content) {
  return write(path.join(root, 'system'), relativePath, content);
}

function writeUser(relativePath, content) {
  return write(path.join(root, 'xdg', 'opencode'), relativePath, content);
}

function exists(targetPath) {
  return fs.existsSync(targetPath);
}

describe('agents module reads the system configuration layer', () => {
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(root, 'project-'));
    fs.rmSync(path.join(root, 'system'), { recursive: true, force: true });
    fs.rmSync(path.join(root, 'xdg'), { recursive: true, force: true });
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.OPENCODE_SYSTEM_CONFIG_DIR;
  });

  it('resolves a system markdown agent with scope system', () => {
    const agentPath = writeSystem('agents/reviewer.md', [
      '---',
      'description: Reviewer',
      'model: anthropic/claude-sonnet-4-5',
      '---',
      '',
      'Review for correctness.',
    ].join('\n'));

    const result = getAgentConfig('reviewer', projectDir);
    expect(result.source).toBe('md');
    expect(result.scope).toBe('system');
    expect(result.path).toBe(agentPath);
    expect(result.config.description).toBe('Reviewer');
    expect(result.config.system).toBe('Review for correctness.');
  });

  it('resolves a system opencode.json agents entry with scope system', () => {
    const configPath = writeSystem('opencode.json', JSON.stringify({
      agents: {
        reviewer: { model: 'anthropic/claude-sonnet-4-5', mode: 'all' },
      },
    }));

    const result = getAgentConfig('reviewer', projectDir);
    expect(result.source).toBe('json');
    expect(result.scope).toBe('system');
    expect(result.path).toBe(configPath);
    expect(result.config.model).toBe('anthropic/claude-sonnet-4-5');
    expect(result.config.mode).toBe('all');
  });

  it('merges a system JSON entry under the system markdown of the same name', () => {
    // OpenCode applies a layer's opencode.json(c) agents section before its
    // markdown files, so the markdown wins per field.
    writeSystem('opencode.json', JSON.stringify({
      agents: {
        reviewer: {
          model: 'anthropic/claude-sonnet-4-5',
          permissions: [{ action: 'shell', resource: 'git push *', effect: 'ask' }],
        },
      },
    }));
    writeSystem('agents/reviewer.md', [
      '---',
      'description: Reviewer',
      '---',
      '',
      'Review for correctness.',
    ].join('\n'));

    const result = getAgentConfig('reviewer', projectDir);
    expect(result.source).toBe('md');
    expect(result.scope).toBe('system');
    expect(result.config.model).toBe('anthropic/claude-sonnet-4-5');
    expect(result.config.description).toBe('Reviewer');
    expect(result.config.system).toBe('Review for correctness.');
    // Both layers' permission lists apply at runtime, so the editor sees both.
    expect(result.config.permissions).toEqual([
      { action: 'shell', resource: 'git push *', effect: 'ask' },
    ]);
  });

  it('lets the system layer outrank the project layer', () => {
    writeProject('.opencode/agents/reviewer.md', [
      '---',
      'description: Project reviewer',
      '---',
      '',
      'Project review.',
    ].join('\n'));
    const systemPath = writeSystem('agents/reviewer.md', [
      '---',
      'description: System reviewer',
      '---',
      '',
      'System review.',
    ].join('\n'));

    const result = getAgentConfig('reviewer', projectDir);
    expect(result.scope).toBe('system');
    expect(result.path).toBe(systemPath);
    expect(result.config.description).toBe('System reviewer');
  });

  it('lets the system JSON entry outrank a project markdown file', () => {
    writeProject('.opencode/agents/reviewer.md', [
      '---',
      'description: Project reviewer',
      '---',
      '',
      'Project review.',
    ].join('\n'));
    writeSystem('opencode.json', JSON.stringify({
      agents: { reviewer: { model: 'anthropic/claude-sonnet-4-5' } },
    }));

    const result = getAgentConfig('reviewer', projectDir);
    expect(result.scope).toBe('system');
    expect(result.source).toBe('json');
    expect(result.config.model).toBe('anthropic/claude-sonnet-4-5');
  });

  it('answers sources with scope, read-only flag and system JSON fields', () => {
    writeSystem('opencode.json', JSON.stringify({
      agents: { reviewer: { model: 'anthropic/claude-sonnet-4-5' } },
    }));

    const sources = getAgentSources('reviewer', projectDir);
    expect(sources.scope).toBe('system');
    expect(sources.readOnly).toBe(true);
    expect(sources.systemJson.exists).toBe(true);
    expect(sources.systemJson.scope).toBe('system');
    expect(sources.md.exists).toBe(false);
    expect(sources.json.exists).toBe(false);
  });

  it('rejects an update of a system-defined agent and writes nothing', () => {
    const systemPath = writeSystem('agents/reviewer.md', [
      '---',
      'description: Reviewer',
      '---',
      '',
      'Review for correctness.',
    ].join('\n'));
    const before = fs.readFileSync(systemPath, 'utf8');

    expect(() => updateAgent('reviewer', { description: 'Changed' }, projectDir))
      .toThrow(/system configuration.*read-only/i);
    expect(fs.readFileSync(systemPath, 'utf8')).toBe(before);
    // The old bug materialized a user-level copy; none may appear now.
    expect(exists(path.join(root, 'xdg', 'opencode', 'agents', 'reviewer.md'))).toBe(false);
  });

  it('rejects a delete of a system-defined agent and keeps a same-name user file', () => {
    writeSystem('opencode.json', JSON.stringify({
      agents: { reviewer: { model: 'anthropic/claude-sonnet-4-5' } },
    }));
    const userPath = writeUser('agents/reviewer.md', [
      '---',
      'description: My reviewer',
      '---',
      '',
      'My own review.',
    ].join('\n'));
    const before = fs.readFileSync(userPath, 'utf8');

    expect(() => deleteAgent('reviewer', projectDir, 'user'))
      .toThrow(/system configuration.*read-only/i);
    expect(fs.readFileSync(userPath, 'utf8')).toBe(before);
  });

  it('rejects creating an agent that would shadow a system definition', () => {
    writeSystem('agents/reviewer.md', [
      '---',
      'description: Reviewer',
      '---',
      '',
      'Review for correctness.',
    ].join('\n'));

    expect(() => createAgent('reviewer', { description: 'Mine' }, projectDir, 'user'))
      .toThrow(/system configuration \(read-only\)/);
    expect(exists(path.join(root, 'xdg', 'opencode', 'agents', 'reviewer.md'))).toBe(false);
  });

  it('skips system-scoped agents in the disabled list', () => {
    writeSystem('agents/reviewer.md', [
      '---',
      'description: Reviewer',
      'disabled: true',
      '---',
      '',
      'Review for correctness.',
    ].join('\n'));
    writeUser('agents/helper.md', [
      '---',
      'description: Helper',
      'disabled: true',
      '---',
      '',
      'Helping.',
    ].join('\n'));

    const disabled = listDisabledAgents(projectDir);
    expect(disabled.map((agent) => agent.name)).toEqual(['helper']);
  });

  it('counts the system layer among global permission rule sources', () => {
    writeSystem('opencode.json', JSON.stringify({
      permission: { shell: { 'git push *': 'ask' } },
    }));

    const permissions = getAgentPermissions('anything', projectDir);
    expect(permissions.global).toEqual([
      { action: 'shell', resource: 'git push *', effect: 'ask' },
    ]);
  });
});