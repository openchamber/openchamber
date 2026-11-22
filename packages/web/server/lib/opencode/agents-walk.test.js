import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-agent-walk-'));
process.env.XDG_CONFIG_HOME = path.join(root, 'xdg');
delete process.env.OPENCODE_CONFIG;

const { getAgentConfig, listDisabledAgents } = await import('./agents.js');

let projectDir;

function createChildDirectories(directory, count) {
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    fs.mkdirSync(path.join(directory, `dir-${String(index).padStart(5, '0')}`));
  }
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function directoryAt(directories, index) {
  const directory = directories.at(index);
  if (directory === undefined) throw new Error(`Expected directory at index ${index}`);
  return directory;
}

function writeAgent(directory, childDirectory, name, disabled = true) {
  const filePath = path.join(directory, childDirectory || '', `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\ndisabled: ${disabled}\n---\n\nPrompt.\n`, 'utf8');
  return filePath;
}

function listNames(directory) {
  return listDisabledAgents(directory).map((agent) => agent.name);
}

describe('agent directory walk limits', () => {
  beforeEach(() => {
    fs.rmSync(path.join(process.env.XDG_CONFIG_HOME, 'opencode'), { recursive: true, force: true });
    projectDir = fs.mkdtempSync(path.join(root, 'project-'));
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.XDG_CONFIG_HOME;
  });

  it('keeps in-cap agents and skips directories beyond the cap', () => {
    const userRoot = path.join(process.env.XDG_CONFIG_HOME, 'opencode', 'agents');
    const projectRoot = path.join(projectDir, '.opencode', 'agents');
    const userDirectories = createChildDirectories(userRoot, 5000);
    const projectDirectories = createChildDirectories(projectRoot, 5000);
    const userOverCap = directoryAt([...userDirectories].sort((a, b) => a.localeCompare(b)), -1);
    const userInCap = directoryAt(userDirectories, userDirectories[0] === userOverCap ? 1 : 0);
    const projectInCap = directoryAt(projectDirectories, 0);
    const projectOverCap = directoryAt(projectDirectories, -1);

    writeAgent(userRoot, userInCap, 'user-in');
    writeAgent(userRoot, userOverCap, 'user-out', false);
    writeAgent(path.join(path.dirname(userRoot), 'agent'), null, 'user-second-root');
    writeAgent(projectRoot, projectInCap, 'project-in');
    writeAgent(projectRoot, projectOverCap, 'project-out');
    writeAgent(path.join(projectDir, '.opencode', 'agent'), null, 'project-second-root');

    expect(listNames(projectDir)).toEqual([
      `${projectInCap}/project-in`,
      'project-second-root',
      'user-in',
      'user-second-root',
    ].sort((a, b) => a.localeCompare(b)));
    expect(getAgentConfig('user-in', projectDir).path).toBe(path.join(userRoot, userInCap, 'user-in.md'));
    expect(getAgentConfig('user-out', projectDir).source).toBe('none');
  });

  it('returns complete results when a root has exactly 5000 directories', () => {
    const userRoot = path.join(process.env.XDG_CONFIG_HOME, 'opencode', 'agents');
    const projectRoot = path.join(projectDir, '.opencode', 'agents');
    const userDirectories = createChildDirectories(userRoot, 4999).sort((a, b) => a.localeCompare(b));
    const projectDirectories = createChildDirectories(projectRoot, 4999);
    const userLastDirectory = directoryAt(userDirectories, -1);
    const projectLastDirectory = directoryAt(projectDirectories, -1);

    writeAgent(userRoot, userLastDirectory, 'user-at-cap', false);
    writeAgent(projectRoot, projectLastDirectory, 'project-at-cap');

    expect(listNames(projectDir)).toEqual([
      `${projectLastDirectory}/project-at-cap`,
    ].sort((a, b) => a.localeCompare(b)));
    expect(getAgentConfig('user-at-cap', projectDir).path)
      .toBe(path.join(userRoot, userLastDirectory, 'user-at-cap.md'));
  });

  it('still finds agents in ordinary nested group layouts', () => {
    const userRoot = path.join(process.env.XDG_CONFIG_HOME, 'opencode', 'agents');
    const projectRoot = path.join(projectDir, '.opencode', 'agents');
    const userPath = writeAgent(userRoot, 'business/operations', 'user-oncall');
    writeAgent(projectRoot, 'ops/oncall', 'project-incident');

    expect(getAgentConfig('user-oncall', projectDir).path).toBe(userPath);
    expect(listNames(projectDir)).toEqual(['ops/oncall/project-incident', 'user-oncall']);
  });
});
