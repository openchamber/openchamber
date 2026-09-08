import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalOpenCodeConfig = process.env.OPENCODE_CONFIG;

afterEach(() => {
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  if (originalOpenCodeConfig === undefined) delete process.env.OPENCODE_CONFIG;
  else process.env.OPENCODE_CONFIG = originalOpenCodeConfig;
  vi.resetModules();
});

async function loadOpenCodeModules() {
  vi.resetModules();
  return Promise.all([
    import('./shared.js'),
    import('./agents.js'),
    import('./commands.js'),
    import('./skills.js'),
    import('./snippets.js'),
    import('./plugins.js'),
    import('./routes.js'),
  ]);
}

describe('OpenCode global config paths', () => {
  it('derives all shared constants from a non-empty XDG_CONFIG_HOME', async () => {
    const xdgConfigHome = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-xdg-'));
    process.env.XDG_CONFIG_HOME = xdgConfigHome;

    const [{ OPENCODE_CONFIG_DIR, AGENT_DIR, COMMAND_DIR, SKILL_DIR, CONFIG_FILE }] = await loadOpenCodeModules();
    const configDir = path.join(xdgConfigHome, 'opencode');
    expect(OPENCODE_CONFIG_DIR).toBe(configDir);
    expect(AGENT_DIR).toBe(path.join(configDir, 'agents'));
    expect(COMMAND_DIR).toBe(path.join(configDir, 'commands'));
    expect(SKILL_DIR).toBe(path.join(configDir, 'skills'));
    expect(CONFIG_FILE).toBe(path.join(configDir, 'config.json'));

    fs.rmSync(xdgConfigHome, { recursive: true, force: true });
  });

  it.each([undefined, '  '])('falls back to ~/.config/opencode when XDG_CONFIG_HOME is %s', async (xdgConfigHome) => {
    if (xdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = xdgConfigHome;

    const [{ OPENCODE_CONFIG_DIR }] = await loadOpenCodeModules();
    expect(OPENCODE_CONFIG_DIR).toBe(path.join(os.homedir(), '.config', 'opencode'));
  });

  it('keeps global CRUD below XDG_CONFIG_HOME while project files stay in the project', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-config-paths-'));
    const xdgConfigHome = path.join(root, 'xdg');
    const projectDir = path.join(root, 'project');
    process.env.XDG_CONFIG_HOME = xdgConfigHome;
    delete process.env.OPENCODE_CONFIG;

    const [, agents, commands, skills, snippets, plugins] = await loadOpenCodeModules();
    agents.createAgent('global-agent', { description: 'Global', prompt: 'Global prompt' }, projectDir, 'user');
    commands.createCommand('global-command', { description: 'Global', template: 'Global template' }, projectDir, 'user');
    skills.createSkill('global-skill', { description: 'Global', instructions: 'Global instructions' }, projectDir, 'user');
    snippets.createSnippet('global-snippet', { content: 'Global snippet' }, projectDir, 'global');
    plugins.createPluginEntry({ spec: 'global-plugin', scope: 'user' }, projectDir);

    const configDir = path.join(xdgConfigHome, 'opencode');
    expect(fs.existsSync(path.join(configDir, 'agents', 'global-agent.md'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, 'commands', 'global-command.md'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, 'skills', 'global-skill', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, 'snippet', 'global-snippet.md'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8')).plugin).toEqual(['global-plugin']);

    agents.createAgent('project-agent', { description: 'Project', prompt: 'Project prompt' }, projectDir, 'project');
    commands.createCommand('project-command', { description: 'Project', template: 'Project template' }, projectDir, 'project');
    skills.createSkill('project-skill', { description: 'Project', instructions: 'Project instructions' }, projectDir, 'project');

    expect(fs.existsSync(path.join(projectDir, '.opencode', 'agents', 'project-agent.md'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, '.opencode', 'commands', 'project-command.md'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, '.opencode', 'skills', 'project-skill', 'SKILL.md'))).toBe(true);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('writes global AGENTS.md below XDG_CONFIG_HOME', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-agents-md-'));
    process.env.XDG_CONFIG_HOME = path.join(root, 'xdg');
    delete process.env.OPENCODE_CONFIG;

    const [, , , , , , routes] = await loadOpenCodeModules();
    const handlers = new Map();
    const app = {
      get(route, ...callbacks) { handlers.set(`GET ${route}`, callbacks.at(-1)); },
      put(route, ...callbacks) { handlers.set(`PUT ${route}`, callbacks.at(-1)); },
      post() {},
      delete() {},
    };
    routes.registerOpenCodeRoutes(app, {});

    const response = { json: vi.fn(), status: vi.fn(() => response) };
    await handlers.get('GET /api/behavior/agents-md')({}, response);
    expect(response.json).toHaveBeenLastCalledWith({
      content: '', exists: false, path: path.join(process.env.XDG_CONFIG_HOME, 'opencode', 'AGENTS.md'),
    });

    await handlers.get('PUT /api/behavior/agents-md')({ body: { content: 'Global behavior' } }, response);

    expect(fs.readFileSync(path.join(process.env.XDG_CONFIG_HOME, 'opencode', 'AGENTS.md'), 'utf8')).toBe('Global behavior');
    await handlers.get('GET /api/behavior/agents-md')({}, response);
    expect(response.json).toHaveBeenLastCalledWith({
      content: 'Global behavior', exists: true, path: path.join(process.env.XDG_CONFIG_HOME, 'opencode', 'AGENTS.md'),
    });
    fs.rmSync(root, { recursive: true, force: true });
  });
});
