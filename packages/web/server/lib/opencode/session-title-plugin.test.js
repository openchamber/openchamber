import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { materializeSessionTitlePlugin } from './session-title-plugin.js';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

/** Load the written plugin and run its agent transform over the given agents. */
const runTransform = async (agents) => {
  const instanceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-session-title-'));
  temporaryDirectories.push(instanceDir);
  const directory = await materializeSessionTitlePlugin({ fsPromises: fs, path, instanceDir });
  const { default: plugin } = await import(pathToFileURL(path.join(directory, 'index.js')).href);
  const transforms = [];
  await plugin.setup({ agent: { transform: async (callback) => { transforms.push(callback); } } });
  const editor = {
    get: (id) => agents.get(id),
    update: (id, update) => update(agents.get(id)),
  };
  for (const transform of transforms) transform(editor);
  return { directory, plugin };
};

describe('session title plugin', () => {
  it('is a loadable plugin directory', async () => {
    const { directory, plugin } = await runTransform(new Map());

    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
    expect(manifest.exports).toEqual({ '.': './index.js' });
    expect(plugin.id).toBe('openchamber-session-title');
  });

  it('replaces the title agent prompt and leaves other agents alone', async () => {
    const title = { id: 'title', system: 'OpenCode title prompt' };
    const build = { id: 'build', system: 'Build prompt' };

    await runTransform(new Map([['title', title], ['build', build]]));

    expect(title.system).toContain('labels a folder');
    expect(build.system).toBe('Build prompt');
  });

  it('does nothing when there is no title agent', async () => {
    const agents = new Map();

    await runTransform(agents);

    expect(agents.size).toBe(0);
  });
});
