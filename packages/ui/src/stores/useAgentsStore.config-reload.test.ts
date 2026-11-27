import { describe, expect, test } from 'bun:test';
import { directoryEnvironment } from './test-support/directoryEnvironment';

const ACTIVE = '/workspace/active';
const OTHER = '/workspace/other';
const environment = directoryEnvironment({ home: '/workspace', lastDirectory: ACTIVE, fakeTimers: false });
const reads: Array<{ path: string; directory: string }> = [];
environment.respond(async (url, init) => {
  const directory = url.searchParams.get('directory')
    ?? decodeURIComponent(new Headers(init?.headers).get('x-opencode-directory') ?? '');
  reads.push({ path: url.pathname, directory });
  if (url.pathname === '/api/config/reload') return Response.json({ success: true, requiresReload: true, reloadDelayMs: 0 });
  if (url.pathname === '/api/opencode/health') return Response.json({ healthy: true });
  if (url.pathname === '/api/model') return Response.json({ data: [{
    id: 'test/model', modelID: 'model', providerID: 'test', name: 'Model',
    capabilities: { tools: true, input: ['text'], output: ['text'] },
    variants: [], time: { released: 0 }, cost: [], status: 'active', enabled: true,
    limit: { context: 1000, output: 100 },
  }] });
  if (url.pathname === '/api/plugin') return Response.json({ data: [{ source: { type: 'builtin' }, features: {}, state: { status: 'active' } }] });
  if (url.pathname === '/api/model/default') return Response.json({ data: { providerID: 'test', modelID: 'model' } });
  if (url.pathname === '/api/provider') return Response.json({ data: [{ id: 'test', name: 'Test', activation: 'enabled', package: 'test' }] });
  if (url.pathname === '/api/agent') return Response.json({ data: [{
    id: 'build', name: 'Build', mode: 'primary', hidden: false,
    request: { settings: {}, headers: {}, body: {} }, permissions: [],
  }] });
  if (url.pathname === '/api/command') return Response.json({ data: [{ name: 'review' }] });
  if (url.pathname === '/api/config') return Response.json([]);
  if (url.pathname === '/api/config/disabled-agents') return Response.json({ disabledAgents: [] });
  if (url.pathname === '/api/config/agents/build') return Response.json({ scope: 'project', config: {} });
  if (url.pathname === '/api/config/command-configs') return Response.json({ commands: [] });
  if (url.pathname === '/api/config/skills') return Response.json({ skills: [] });
  if (url.pathname === '/api/config/skills/catalog') return Response.json({ sources: [] });
  if (url.pathname === '/api/fs/home') return Response.json({ home: '/workspace', chatsRoot: '/workspace/chats' });
  if (url.pathname === '/api/fs/directory-stats') return Response.json({ results: [{ path: ACTIVE, isDirectory: true }] });
  if (url.pathname === '/api/location' || url.pathname === '/api/session') return Response.json({}, { status: 401 });
  throw new Error(`Unexpected request: ${url}`);
});

const { opencodeClient } = await import('@/lib/opencode/client');
const { useProjectsStore } = await import('./useProjectsStore');
const { useConfigStore } = await import('./useConfigStore');
const { useCommandsStore } = await import('./useCommandsStore');
const { reloadOpenCodeConfiguration, useAgentsStore } = await import('./useAgentsStore');

describe('configuration reload refresh scope', () => {
  test('reads only the active directory and retires every other catalog', async () => {
    await environment.settle();
    useProjectsStore.setState({
      activeProjectId: 'active',
      projects: [{ id: 'active', path: ACTIVE }, { id: 'other', path: OTHER }],
    });
    opencodeClient.setDirectory(ACTIVE);
    for (const directory of [OTHER, ACTIVE]) {
      await useConfigStore.getState().loadProviders({ directory });
      await useConfigStore.getState().loadAgents({ directory });
      await useAgentsStore.getState().loadAgents(directory);
      await useCommandsStore.getState().loadCommands(directory);
    }
    reads.length = 0;

    await reloadOpenCodeConfiguration();

    for (const path of ['/api/model', '/api/provider', '/api/agent', '/api/command']) {
      expect(reads.filter((read) => read.path === path).map((read) => read.directory)).toEqual([ACTIVE]);
    }
    expect(useConfigStore.getState().providers.map((provider) => provider.id)).toEqual(['test']);
    expect(useConfigStore.getState().agents.map((agent) => agent.name)).toEqual(['build']);
    expect(useAgentsStore.getState().agents.map((agent) => agent.name)).toEqual(['build']);
    expect(useCommandsStore.getState().commands.map((command) => command.name)).toEqual(['review']);
    expect(reads.some((read) => read.directory === OTHER)).toBe(false);

    reads.length = 0;
    await useConfigStore.getState().loadProviders({ directory: OTHER });
    await useConfigStore.getState().loadAgents({ directory: OTHER });
    await useAgentsStore.getState().loadAgents(OTHER);
    expect(reads.some((read) => read.path === '/api/provider' && read.directory === OTHER)).toBe(true);
    expect(reads.some((read) => read.path === '/api/agent' && read.directory === OTHER)).toBe(true);
  });
});
