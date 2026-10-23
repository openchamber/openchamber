import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createMcpToolsRuntime } from './runtime.js';
import { registerMcpToolRoutes } from './routes.js';

const setup = () => {
  const list = vi.fn(async ({ location }) => ({ location, data: [{ name: 'my.server', status: { status: 'connected' } }] }));
  const resolveProjectDirectory = vi.fn(async (id) => ({ a: '/a', b: '/b' })[id]);
  let external = false;
  const runtime = createMcpToolsRuntime({
    resolveProjectDirectory,
    createClient: () => ({ mcp: { list } }),
    isExternalOpenCode: () => external,
  });
  const app = express();
  registerMcpToolRoutes(app, { mcpToolsRuntime: runtime });
  return { runtime, app, list, resolveProjectDirectory, external: () => { external = true; } };
};

describe('project MCP catalog', () => {
  it('isolates reports and scopes a single SDK read to the requested project', async () => {
    const { runtime, app, list, resolveProjectDirectory } = setup();
    runtime.report({ directory: '/a', tools: [{ namespace: 'my.server', name: 'find.issue', description: 'Find issues', ignored: true }, { namespace: 'other', name: 'ignored', description: '' }] });
    const a = await request(app).get('/api/projects/a/mcp-tools').expect(200);
    expect(a.body).toEqual({ status: 'ready', servers: [{ name: 'my.server', status: 'connected', tools: [{ name: 'find.issue', description: 'Find issues' }] }] });
    expect(list).toHaveBeenCalledExactlyOnceWith({ location: { directory: '/a' } });
    expect(resolveProjectDirectory).toHaveBeenCalledExactlyOnceWith('a');
    const b = await request(app).get('/api/projects/b/mcp-tools').expect(200);
    expect(b.body).toEqual({ status: 'loading', servers: [{ name: 'my.server', status: 'connected', tools: [] }] });
    runtime.report({ directory: '/b', tools: [] });
    expect((await request(app).get('/api/projects/b/mcp-tools')).body.status).toBe('ready');
  });

  it('preserves ready empty, current server statuses and external manual-name mode', async () => {
    const { runtime, app, list, external } = setup();
    list.mockResolvedValueOnce({ location: { directory: '/a' }, data: [] });
    expect((await request(app).get('/api/projects/a/mcp-tools')).body).toEqual({ status: 'loading', servers: [] });
    runtime.report({ directory: '/a', tools: [] });
    list.mockResolvedValueOnce({ location: { directory: '/a' }, data: [] });
    expect((await request(app).get('/api/projects/a/mcp-tools')).body).toEqual({ status: 'ready', servers: [] });
    list.mockResolvedValueOnce({ location: { directory: '/a' }, data: [{ name: 'my.server', status: { status: 'failed', error: 'unavailable' } }] });
    expect((await request(app).get('/api/projects/a/mcp-tools')).body.servers[0].status).toBe('failed');
    runtime.report({ directory: '/a', tools: [{ namespace: 'my_server', name: 'find', description: '' }] });
    external();
    expect((await request(app).get('/api/projects/a/mcp-tools')).body).toEqual({ status: 'external', servers: [{ name: 'my.server', status: 'connected', tools: [] }] });
  });

  it('returns failures without erasing authoritative reports or accepting malformed SDK success', async () => {
    const { runtime, app, list } = setup();
    const report = { directory: '/a', tools: [{ namespace: 'my_server', name: 'find', description: 'Known' }] };
    runtime.report(report);
    for (const tools of [null, [{}], [{ ...report.tools[0], description: 'x'.repeat(16_385) }], Array(10_001).fill(report.tools[0])]) {
      expect(() => runtime.report({ directory: '/a', tools })).toThrow();
    }
    expect(() => runtime.report({ directory: 'relative', tools: [] })).toThrow();
    list.mockRejectedValueOnce(new Error('Offline'));
    await request(app).get('/api/projects/a/mcp-tools').expect(502);
    list.mockResolvedValueOnce({ location: { directory: '/b' }, data: [] });
    await request(app).get('/api/projects/a/mcp-tools').expect(502);
    list.mockResolvedValueOnce({ location: { directory: '/a' }, data: null });
    await request(app).get('/api/projects/a/mcp-tools').expect(502);
    const recovered = await request(app).get('/api/projects/a/mcp-tools').expect(200);
    expect(recovered.body.servers[0].tools).toEqual([{ name: 'find', description: 'Known' }]);
    await request(app).get('/api/projects/missing/mcp-tools').expect(404);
  });
});
