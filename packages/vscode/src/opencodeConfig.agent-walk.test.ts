import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-agent-walk-'));
const xdgConfigHome = path.join(root, 'xdg');
process.env.XDG_CONFIG_HOME = xdgConfigHome;
process.env.OPENCODE_CONFIG = '';
// opencodeConfigPaths gives OPENCODE_CONFIG_DIR precedence over
// XDG_CONFIG_HOME, so an exported one would send the module under test to
// a different config directory than the scratch tree below. Clear it
// before the module loads and restore it afterwards.
const previousOpenCodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
delete process.env.OPENCODE_CONFIG_DIR;

let configModule: Promise<typeof import('./opencodeConfig')> | undefined;
const loadConfig = () => (configModule ??= import('./opencodeConfig'));

let projectDir: string;

const createChildDirectories = (directory: string, count: number): string[] => {
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    fs.mkdirSync(path.join(directory, `dir-${String(index).padStart(5, '0')}`));
  }
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
};

const writeAgent = (directory: string, childDirectory: string | null, name: string, disabled = true): string => {
  const filePath = path.join(directory, childDirectory || '', `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\ndisabled: ${disabled}\n---\n\nPrompt.\n`, 'utf8');
  return filePath;
};

const directoryAt = (directories: string[], index: number): string => {
  const directory = directories.at(index);
  if (directory === undefined) throw new Error(`Expected directory at index ${index}`);
  return directory;
};

describe('VS Code agent directory walk limits', () => {
  beforeEach(() => {
    fs.rmSync(path.join(xdgConfigHome, 'opencode'), { recursive: true, force: true });
    projectDir = fs.mkdtempSync(path.join(root, 'project-'));
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.OPENCODE_CONFIG;
    if (previousOpenCodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = previousOpenCodeConfigDir;
  });

  test('keeps in-cap agents and skips directories beyond the cap', async () => {
    const { getAgentConfig, listDisabledAgents, updateAgent } = await loadConfig();
    const userRoot = path.join(xdgConfigHome, 'opencode', 'agents');
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
    updateAgent(`${projectInCap}/project-in`, { description: 'Project agent' }, projectDir);

    assert.deepEqual(listDisabledAgents(projectDir).map((agent) => agent.name), [
      `${projectInCap}/project-in`,
      'project-second-root',
      `${userInCap}/user-in`,
      'user-second-root',
    ].sort((a, b) => a.localeCompare(b)));
    assert.equal(getAgentConfig('user-in', projectDir).path, path.join(userRoot, userInCap, 'user-in.md'));
    assert.equal(getAgentConfig('user-out', projectDir).source, 'none');
  });

  test('returns complete results when a root has exactly 5000 directories', async () => {
    const { getAgentConfig, listDisabledAgents, updateAgent } = await loadConfig();
    const userRoot = path.join(xdgConfigHome, 'opencode', 'agents');
    const projectRoot = path.join(projectDir, '.opencode', 'agents');
    const userDirectories = createChildDirectories(userRoot, 4999);
    const projectDirectories = createChildDirectories(projectRoot, 4999);
    const userLastDirectory = directoryAt(userDirectories, -1);
    const projectLastDirectory = directoryAt(projectDirectories, -1);

    writeAgent(userRoot, userLastDirectory, 'user-at-cap', false);
    writeAgent(projectRoot, projectLastDirectory, 'project-at-cap');
    writeAgent(projectRoot, null, 'cache-refresh', false);
    updateAgent('cache-refresh', { description: 'Refresh lookup index' }, projectDir);

    assert.deepEqual(listDisabledAgents(projectDir).map((agent) => agent.name), [
      `${projectLastDirectory}/project-at-cap`,
    ].sort((a, b) => a.localeCompare(b)));
    assert.equal(getAgentConfig('user-at-cap', projectDir).path, path.join(userRoot, userLastDirectory, 'user-at-cap.md'));
  });

  test('still finds agents in ordinary nested group layouts', async () => {
    const { getAgentConfig, listDisabledAgents, updateAgent } = await loadConfig();
    const userRoot = path.join(xdgConfigHome, 'opencode', 'agents');
    const projectRoot = path.join(projectDir, '.opencode', 'agents');
    const userPath = writeAgent(userRoot, 'business/operations', 'user-oncall');
    writeAgent(projectRoot, 'ops/oncall', 'project-incident');
    writeAgent(projectRoot, null, 'cache-refresh', false);
    updateAgent('cache-refresh', { description: 'Refresh lookup index' }, projectDir);

    assert.equal(getAgentConfig('user-oncall', projectDir).path, userPath);
    assert.deepEqual(listDisabledAgents(projectDir).map((agent) => agent.name), [
      'business/operations/user-oncall',
      'ops/oncall/project-incident',
    ].sort((a, b) => a.localeCompare(b)));
  });
});

describe('agent walk ceiling agreement', () => {
  test('web and VS Code keep the same per-root directory cap', () => {
    const vscodeSource = fs.readFileSync(new URL('./opencodeConfig.ts', import.meta.url), 'utf8');
    const webSource = fs.readFileSync(new URL('../../web/server/lib/opencode/agents.js', import.meta.url), 'utf8');
    const capFromSource = (source: string): number => Number(source.match(/const AGENT_WALK_MAX_DIRS = (\d+);/)?.[1]);

    assert.equal(capFromSource(webSource), 5000);
    assert.equal(capFromSource(vscodeSource), capFromSource(webSource));
  });
});
