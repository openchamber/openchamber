import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// OpenCode 2 merges every opencode.json(c) and .opencode/opencode.json(c) from
// the project folder up to the filesystem root (core/src/config/discovery.ts),
// so Settings > MCP has to list and edit servers from those files too.

const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalOpenCodeConfig = process.env.OPENCODE_CONFIG;

let root;
let workspace;
let projectDir;

function write(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
  return filePath;
}

function server(url) {
  return JSON.stringify({ mcp: { servers: { docs: { type: 'remote', url } } } }, null, 2);
}

async function loadMcp() {
  vi.resetModules();
  return import('./mcp.js');
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-mcp-folders-')));
  process.env.XDG_CONFIG_HOME = path.join(root, 'xdg');
  delete process.env.OPENCODE_CONFIG;
  workspace = path.join(root, 'workspace');
  projectDir = path.join(workspace, 'packages', 'app');
  fs.mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  if (originalOpenCodeConfig === undefined) delete process.env.OPENCODE_CONFIG;
  else process.env.OPENCODE_CONFIG = originalOpenCodeConfig;
});

describe('MCP servers from parent folders', () => {
  it('lists a server from a parent folder and edits and deletes it in that file', async () => {
    const parentFile = write(path.join(workspace, 'opencode.jsonc'), [
      '{',
      '  // shared by every package',
      '  "mcp": { "servers": { "docs": { "type": "remote", "url": "https://parent.example.com/mcp" } } }',
      '}',
    ].join('\n'));
    const { listMcpConfigs, getMcpConfig, updateMcpConfig, deleteMcpConfig, createMcpConfig } = await loadMcp();

    expect(listMcpConfigs(projectDir)).toEqual([
      expect.objectContaining({ name: 'docs', url: 'https://parent.example.com/mcp', scope: 'user' }),
    ]);
    expect(() => createMcpConfig('docs', { type: 'local', command: ['x'] }, projectDir, 'project')).toThrow(/already exists/);

    expect(updateMcpConfig('docs', { disabled: true }, projectDir)).toEqual({ path: parentFile });
    expect(getMcpConfig('docs', projectDir)).toEqual(expect.objectContaining({ disabled: true }));
    expect(fs.readFileSync(parentFile, 'utf8')).toMatch(/\/\/ shared by every package/);

    expect(deleteMcpConfig('docs', projectDir)).toEqual({ path: parentFile });
    expect(listMcpConfigs(projectDir)).toEqual([]);
    expect(fs.existsSync(path.join(projectDir, '.opencode'))).toBe(false);
    expect(fs.existsSync(path.join(process.env.XDG_CONFIG_HOME, 'opencode', 'opencode.json'))).toBe(false);
  });

  it('uses the file OpenCode lets win and writes only there', async () => {
    const globalFile = write(path.join(process.env.XDG_CONFIG_HOME, 'opencode', 'opencode.json'), server('https://global.example.com'));
    const customFile = write(path.join(root, 'custom.json'), server('https://custom.example.com'));
    process.env.OPENCODE_CONFIG = customFile;
    write(path.join(workspace, 'opencode.json'), server('https://parent.example.com'));
    write(path.join(projectDir, 'opencode.json'), server('https://project-json.example.com'));
    const projectJsonc = write(path.join(projectDir, 'opencode.jsonc'), server('https://project-jsonc.example.com'));
    const { getMcpConfig, updateMcpConfig } = await loadMcp();

    // Folder files beat OPENCODE_CONFIG, nearer folders beat outer ones, and
    // opencode.jsonc beats opencode.json in the same folder.
    expect(getMcpConfig('docs', projectDir)).toEqual(expect.objectContaining({ url: 'https://project-jsonc.example.com', scope: 'project' }));

    // Any .opencode/ folder on the way beats every plain opencode.json(c).
    const parentDotOpencode = write(path.join(workspace, '.opencode', 'opencode.json'), server('https://parent-dot.example.com'));
    expect(getMcpConfig('docs', projectDir)).toEqual(expect.objectContaining({ url: 'https://parent-dot.example.com', scope: 'user' }));

    expect(updateMcpConfig('docs', { disabled: true }, projectDir)).toEqual({ path: parentDotOpencode });
    for (const untouched of [globalFile, customFile, projectJsonc]) {
      expect(JSON.parse(fs.readFileSync(untouched, 'utf8')).mcp.servers.docs.disabled).toBeUndefined();
    }
  });

  it('skips a broken parent file and still lists the rest', async () => {
    write(path.join(workspace, 'opencode.json'), '{ "mcp": ');
    write(path.join(projectDir, '.opencode', 'opencode.json'), server('https://project.example.com'));
    const { listMcpConfigs } = await loadMcp();

    expect(listMcpConfigs(projectDir).map(({ name, url }) => [name, url])).toEqual([['docs', 'https://project.example.com']]);
  });

  it('does not read the global config twice when the project sits in the config folder', async () => {
    const configDir = path.join(process.env.XDG_CONFIG_HOME, 'opencode');
    write(path.join(configDir, 'opencode.json'), server('https://global.example.com'));
    const { listMcpConfigs } = await loadMcp();

    expect(listMcpConfigs(configDir)).toEqual([expect.objectContaining({ name: 'docs', scope: 'user' })]);
    expect(listMcpConfigs(path.join(configDir, 'nested'))).toEqual([expect.objectContaining({ name: 'docs', scope: 'user' })]);
  });
});
