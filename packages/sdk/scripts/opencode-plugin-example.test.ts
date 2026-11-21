import { describe, expect, test } from 'bun:test';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseManifestJson } from '../src/schemas';

// Runs the checked-in plugin bundle the way OpenCode does: a default export
// `{ id, setup }`, and `setup` adding its tool through `ctx.tool.transform`.

type Tool = {
  name: string;
  description: string;
  options?: { codemode: boolean };
  input: { type: 'object'; properties: object; additionalProperties: false };
  execute: () => Promise<{ content: string }>;
};

type Plugin = {
  id: string;
  setup: (ctx: { tool: { transform: (edit: (tools: { add: (tool: Tool) => void }) => void) => Promise<void> } }) => Promise<void>;
};

const example = new URL('../examples/opencode-plugin/', import.meta.url);

describe('the opencode-plugin example', () => {
  test('its manifest names the plugin folder, with the built entry at its root', async () => {
    const manifest = parseManifestJson(await readFile(new URL('package.json', example), 'utf8'));
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    expect(manifest.manifest.contributes.opencodePlugin).toBe('plugin');
    // SAFETY: the file is the example's own checked-in package.json; the assertion below checks the two fields read.
    const plugin = JSON.parse(await readFile(new URL('plugin/package.json', example), 'utf8')) as { type?: string };
    expect(plugin).toMatchObject({ type: 'module' });
    // Only built files ship. Load outside the monorepo so its node_modules
    // cannot hide an accidentally unbundled dependency.
    const installed = await mkdtemp(join(tmpdir(), 'openchamber-plugin-example-'));
    try {
      await copyFile(new URL('plugin/package.json', example), join(installed, 'package.json'));
      await copyFile(new URL('plugin/index.js', example), join(installed, 'index.js'));
      const child = Bun.spawn(['node', '--input-type=module', '-e', `
        const { default: plugin } = await import(${JSON.stringify(pathToFileURL(join(installed, 'index.js')).href)});
        if (plugin.id !== 'teapot-tools' || typeof plugin.setup !== 'function') {
          throw new Error('The installed entry must export the plugin');
        }
      `], { cwd: installed, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_PATH: '' } });
      const error = await new Response(child.stderr).text();
      expect(await child.exited, error).toBe(0);
    } finally {
      await rm(installed, { recursive: true, force: true });
    }
  });

  test('setup registers teapot_status, which answers without input', async () => {
    // SAFETY: the bundle is the example's own checked-in plugin; the assertions below check the id, the setup and the tool it adds.
    const { default: plugin } = await import(new URL('plugin/index.js', example).href) as { default: Plugin };
    expect(plugin.id).toBe('teapot-tools');
    const tools: Tool[] = [];
    await plugin.setup({ tool: { transform: async (edit) => edit({ add: (tool) => tools.push(tool) }) } });
    expect(tools.map((tool) => tool.name)).toEqual(['teapot_status']);
    const [status] = tools;
    expect(status.options).toEqual({ codemode: false });
    expect(status.input).toEqual({ type: 'object', properties: {}, additionalProperties: false });
    // Text content and no `output`: a tool without an output schema may not carry one, and OpenCode refuses a bare string.
    const answer = await status.execute();
    expect(Object.keys(answer)).toEqual(['content']);
    expect(answer.content).toContain('teapot');
  });
});
