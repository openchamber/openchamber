import { describe, expect, test } from 'bun:test';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseManifestJson } from '../src/schemas';
import { z } from 'zod';

const examples = new URL('../examples/', import.meta.url);

describe('checked-in SDK examples', () => {
  test('Tool Gallery MCP fixture speaks JSON-RPC and returns labeled sample tables', () => {
    const requests = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'findings', arguments: { scope: 'Sample' } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'checks', arguments: { project: 'Sample' } } },
    ];
    const result = spawnSync('node', [fileURLToPath(new URL('tools-only/mcp.js', examples))], { cwd: fileURLToPath(examples), env: { ...process.env }, input: requests.map((request) => JSON.stringify(request)).join('\n') + '\n', encoding: 'utf8' });
    expect(result.status).toBe(0);
    const replies = z.array(z.object({ jsonrpc: z.literal('2.0'), id: z.number(), result: z.object({
      tools: z.array(z.object({ name: z.string() })).optional(), content: z.array(z.object({ type: z.literal('text'), text: z.string() })).optional(),
    }) })).parse(result.stdout.trim().split('\n').map((line) => JSON.parse(line)));
    expect(replies.map((reply) => reply.id)).toEqual([1, 2, 3, 4]);
    expect(replies[1].result.tools?.map((tool) => tool.name)).toEqual(['findings', 'checks']);
    expect(replies[2].result.content?.[0].text).toContain('no files inspected');
    expect(replies[3].result.content?.[0].text).toContain('no commands run');
  });

  test('all manifests remain valid', async () => {
    for (const entry of await readdir(examples, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = parseManifestJson(await readFile(new URL(`${entry.name}/package.json`, examples), 'utf8'));
      expect(manifest.ok).toBe(true);
    }
  });

  test('all shipped bundles match their source and current SDK', async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'oc-example-bundles-'));
    try {
    for (const entry of ['hello-kit/panel/main', 'github-token/panel/main', 'config-editor/panel/main', 'service-echo/panel/main',
      'service-echo/service/main', 'tools-only/mcp', 'tasks-demo/panel/main', 'tasks-demo/panel/attach', 'tasks-demo/panel/page']) {
      const node = entry.includes('/service/') || entry === 'tools-only/mcp';
      const output = path.join(temporary, 'bundle.js');
      const result = spawnSync('bun', [fileURLToPath(new URL('./bundle-guest.ts', import.meta.url)), ...(node ? ['--node'] : []), fileURLToPath(new URL(`${entry}.ts`, examples)), output], {
        cwd: fileURLToPath(new URL('../../../', import.meta.url)), env: { ...process.env }, encoding: 'utf8',
      });
      if (result.status !== 0) throw new Error(`${entry}: ${result.stderr}`);
      // Bun's unminified source comments are relative to the command's working directory.
      const normalize = (source: string) => source.replace(/^\/\/ (?:packages\/sdk\/)?examples\//gm, '// examples/');
      expect(Bun.hash(normalize(await readFile(output, 'utf8')))).toBe(Bun.hash(normalize(await readFile(new URL(`${entry}.js`, examples), 'utf8'))));
    }
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });
});
