import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Jev reads a pool's description from the files OpenCode reads, with the
// wiring index.js uses: `readLayeredModelRoutes(readConfigSources(directory))`.
// OpenCode merges the global files, OPENCODE_CONFIG and every opencode.json(c)
// and .opencode/opencode.json(c) from the project folder up to the root
// (core/src/config/discovery.ts), and a later file's pool replaces an earlier
// one whole (core/src/config/plugin/model-routes.ts).

const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalOpenCodeConfig = process.env.OPENCODE_CONFIG;
const originalOpenCodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
const originalHome = process.env.HOME;

let root;
let workspace;
let projectDir;

const write = (filePath, text) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
  return filePath;
};

const pools = (routes) => JSON.stringify({ experimental: { model_routes: routes } }, null, 2);

const loadPools = async () => {
  vi.resetModules();
  const { readConfigSources } = await import('../opencode/shared.js');
  const { readLayeredModelRoutes } = await import('./model-routes.js');
  return (directory) => readLayeredModelRoutes(readConfigSources(directory));
};

// The walk goes from the project folder to the filesystem root, as OpenCode's
// does, so a temp folder inside a home that has ~/.opencode/opencode.json(c)
// (TMPDIR under $HOME, as on some macOS setups) would merge the machine's real
// pools into every case. Use the first base folder with no config above it.
const hasConfigAbove = (folder) => {
  for (let current = folder; ; current = path.dirname(current)) {
    for (const dir of [current, path.join(current, '.opencode')]) {
      if (['opencode.json', 'opencode.jsonc'].some((name) => fs.existsSync(path.join(dir, name)))) return true;
    }
    if (path.dirname(current) === current) return false;
  }
};
const fixtureBase = [os.tmpdir(), '/tmp', '/var/tmp']
  .filter((candidate) => fs.existsSync(candidate))
  .map((candidate) => fs.realpathSync(candidate))
  .find((candidate) => !hasConfigAbove(candidate)) ?? os.tmpdir();

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(fixtureBase, 'openchamber-pool-folders-')));
  process.env.XDG_CONFIG_HOME = path.join(root, 'xdg');
  // shared.js prefers OPENCODE_CONFIG_DIR over XDG_CONFIG_HOME and resolves
  // it when the module loads, so pin it at the same temporary global folder
  // before loadPools re-imports the module. A developer shell that exports
  // it would otherwise point the global layer at the real config.
  process.env.OPENCODE_CONFIG_DIR = path.join(root, 'xdg', 'opencode');
  delete process.env.OPENCODE_CONFIG;
  // shared.js unconditionally adds ~/.opencode to the config sources, so
  // pin HOME inside the fixture root or the machine's real global pools
  // merge into every case (#2309).
  process.env.HOME = path.join(root, 'home');
  fs.mkdirSync(process.env.HOME, { recursive: true });
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
  if (originalOpenCodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
  else process.env.OPENCODE_CONFIG_DIR = originalOpenCodeConfigDir;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

describe('model pool descriptions from every config file OpenCode reads', () => {
  it('reads parent folders, .opencode folders, sibling json and jsonc and OPENCODE_CONFIG, the last file winning', async () => {
    write(path.join(process.env.XDG_CONFIG_HOME, 'opencode', 'opencode.json'), pools({
      strong: { targets: ['p/global'], description: 'from the global file' },
      kept: { targets: ['p/kept'], description: 'only in the global file' },
    }));
    process.env.OPENCODE_CONFIG = write(path.join(root, 'custom.json'), pools({ custom: { targets: ['p/c'], description: 'from OPENCODE_CONFIG' } }));
    // A parent folder redefines `strong` without text: the whole pool is replaced, so no description survives.
    write(path.join(workspace, 'opencode.jsonc'), `{\n  // shared\n  ${pools({ strong: { targets: ['p/parent'] } }).slice(1, -1)}\n}`);
    write(path.join(workspace, '.opencode', 'opencode.json'), pools({ cheap: { targets: ['p/cheap'], description: 'parent .opencode' } }));
    write(path.join(projectDir, 'opencode.json'), pools({
      medium: { targets: ['p/m'], description: 'project json' },
      fast: { targets: ['p/f'], description: 'project json' },
    }));
    write(path.join(projectDir, 'opencode.jsonc'), pools({ medium: { targets: ['p/m'], description: 'project jsonc' } }));
    write(path.join(projectDir, '.opencode', 'opencode.json'), pools({ fast: { targets: ['p/f'], description: 'project .opencode' } }));
    write(path.join(workspace, 'packages', 'opencode.json'), '{ "experimental": ');
    const read = await loadPools();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = read(projectDir);

    expect(result.strong).toEqual({ targets: ['p/parent'] });
    expect(result.kept.description).toBe('only in the global file');
    expect(result.custom.description).toBe('from OPENCODE_CONFIG');
    expect(result.cheap.description).toBe('parent .opencode');
    expect(result.medium.description).toBe('project jsonc');
    expect(result.fast.description).toBe('project .opencode');
    expect(Object.keys(result).sort()).toEqual(['cheap', 'custom', 'fast', 'kept', 'medium', 'strong']);
  });

  it('reads only the global files without a directory', async () => {
    write(path.join(process.env.XDG_CONFIG_HOME, 'opencode', 'opencode.json'), pools({ strong: { targets: ['p/g'], description: 'global' } }));
    write(path.join(workspace, 'opencode.json'), pools({ strong: { targets: ['p/w'], description: 'workspace' } }));
    const read = await loadPools();
    expect(read(null).strong.description).toBe('global');
  });
});
