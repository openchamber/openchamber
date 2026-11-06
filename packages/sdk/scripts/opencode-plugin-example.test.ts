import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

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
  test('its manifest names the plugin folder, whose package.json names the built entry', async () => {
    const manifest = parseManifestJson(await readFile(new URL('package.json', example), 'utf8'));
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    expect(manifest.manifest.contributes.opencodePlugin).toBe('plugin');
    // SAFETY: the file is the example's own checked-in package.json; the assertion below checks the two fields read.
    const plugin = JSON.parse(await readFile(new URL('plugin/package.json', example), 'utf8')) as { main?: string; type?: string };
    expect(plugin).toMatchObject({ type: 'module', main: 'index.js' });
    // OpenCode imports the entry from a folder where nothing is installed.
    expect(await readFile(new URL('plugin/index.js', example), 'utf8')).not.toMatch(/^\s*import\s/m);
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
