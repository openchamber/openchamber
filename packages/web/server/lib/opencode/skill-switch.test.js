import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalOpenCodeConfig = process.env.OPENCODE_CONFIG;

let root;
let globalConfig;
let workspace;
let projectDir;

const deny = (id) => ({ action: 'integration.use', resource: `skill:${id}`, effect: 'deny' });

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
  return filePath;
}

const write = (filePath, config) => writeText(filePath, JSON.stringify(config, null, 2));

const read = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));

async function loadSkillSwitch() {
  vi.resetModules();
  return import('./skill-switch.js');
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-skill-switch-')));
  process.env.XDG_CONFIG_HOME = path.join(root, 'xdg');
  delete process.env.OPENCODE_CONFIG;
  globalConfig = path.join(root, 'xdg', 'opencode', 'opencode.json');
  workspace = path.join(root, 'workspace');
  projectDir = path.join(workspace, 'app');
  fs.mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  if (originalOpenCodeConfig === undefined) delete process.env.OPENCODE_CONFIG;
  else process.env.OPENCODE_CONFIG = originalOpenCodeConfig;
});

describe('setSkillEnabled', () => {
  it('turns a user skill off in the global config and a project skill off in the project config', async () => {
    write(globalConfig, { model: 'openai/gpt-5' });
    const { setSkillEnabled } = await loadSkillSwitch();

    expect(setSkillEnabled({ id: 'deploy', enabled: false, scope: 'user', directory: projectDir }))
      .toEqual({ changed: [globalConfig] });
    expect(read(globalConfig)).toEqual({ model: 'openai/gpt-5', policies: [deny('deploy')] });

    const projectConfig = path.join(projectDir, '.opencode', 'opencode.json');
    expect(setSkillEnabled({ id: 'review', enabled: false, scope: 'project', directory: projectDir }))
      .toEqual({ changed: [projectConfig] });
    expect(read(projectConfig)).toEqual({ policies: [deny('review')] });
    expect(read(globalConfig).policies).toEqual([deny('deploy')]);
  });

  it('turns a skill on by removing its exact deny from every file OpenCode reads, wildcards stay', async () => {
    const wildcard = { action: 'integration.use', resource: 'skill:internal-*', effect: 'deny' };
    write(globalConfig, { policies: [deny('deploy')] });
    const parent = write(path.join(workspace, 'opencode.json'), { policies: [deny('deploy'), wildcard] });
    const project = write(path.join(projectDir, '.opencode', 'opencode.json'), { policies: [deny('other')] });
    const { setSkillEnabled } = await loadSkillSwitch();

    const result = setSkillEnabled({ id: 'deploy', enabled: true, scope: 'project', directory: projectDir });

    expect(result.changed.sort()).toEqual([globalConfig, parent].sort());
    expect(read(globalConfig)).toEqual({});
    expect(read(parent)).toEqual({ policies: [wildcard] });
    expect(read(project)).toEqual({ policies: [deny('other')] });
  });

  it('skips a file it cannot parse when turning on, and refuses to write over it when turning off', async () => {
    writeText(globalConfig, '{ "policies": [');
    const project = write(path.join(projectDir, 'opencode.json'), { policies: [deny('deploy')] });
    const { setSkillEnabled } = await loadSkillSwitch();

    expect(setSkillEnabled({ id: 'deploy', enabled: true, scope: 'user', directory: projectDir }))
      .toEqual({ changed: [project] });
    expect(fs.readFileSync(globalConfig, 'utf8')).toBe('{ "policies": [');
    expect(() => setSkillEnabled({ id: 'deploy', enabled: false, scope: 'user', directory: projectDir })).toThrow();
    expect(fs.readFileSync(globalConfig, 'utf8')).toBe('{ "policies": [');
  });
});
