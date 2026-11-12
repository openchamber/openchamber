import { afterEach, describe, expect, it, vi } from 'vitest';

import { createNotificationTemplateRuntime } from './template-runtime.js';

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

const setup = (readDisplayMetadata) => {
  const fetchImpl = vi.fn(async (url) => Response.json(url.includes('/message')
    ? { data: [{ id: 'msg_1', type: 'assistant', finish: 'stop', content: [{ type: 'text', text: 'Answer' }] }] }
    : { data: { id: 'ses_1', title: 'Agent session', location: { directory: '/agent/worktree' } } }));
  const resolvePrimaryWorktreeRoot = vi.fn(async () => { throw new Error('local worktree discovery is forbidden'); });
  // Local git starts by resolving its binary, so this spy also catches any local git run.
  const resolveGitBinaryForSpawn = vi.fn(() => { throw new Error('local git resolution is forbidden'); });
  const runtime = createNotificationTemplateRuntime({
    readSettingsFromDisk: async () => ({ projects: [{ id: 'active', path: '/agent/active', label: 'Active' }], activeProjectId: 'active' }),
    buildOpenCodeUrl: (route) => `http://agent${route}`,
    getOpenCodeAuthHeaders: () => ({}),
    readDisplayMetadata, fetchImpl, resolvePrimaryWorktreeRoot, resolveGitBinaryForSpawn,
  });
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('raw fetch is forbidden'); }));
  return { runtime, fetchImpl, resolvePrimaryWorktreeRoot, resolveGitBinaryForSpawn };
};

describe('notification templates delegated to the agent server', () => {
  it('uses the injected transport for titles and messages and delegates project metadata', async () => {
    const readDisplayMetadata = vi.fn(async () => ({ projectName: 'Agent project', branch: 'feature' }));
    const { runtime, fetchImpl, resolvePrimaryWorktreeRoot, resolveGitBinaryForSpawn } = setup(readDisplayMetadata);
    const variables = await runtime.buildTemplateVariables({}, 'ses_1');
    expect(variables).toMatchObject({ session_name: 'Agent session', project_name: 'Agent project', branch: 'feature', worktree: '/agent/worktree' });
    await expect(runtime.fetchLastAssistantMessageText('ses_1', 'msg_1')).resolves.toBe('Answer');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(readDisplayMetadata).toHaveBeenCalledExactlyOnceWith('/agent/worktree');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(resolvePrimaryWorktreeRoot).not.toHaveBeenCalled();
    expect(resolveGitBinaryForSpawn).not.toHaveBeenCalled();
  });

  it.each(['/agent/worktree', null])('never falls back to local git after metadata failure for %s', async (directory) => {
    const readDisplayMetadata = vi.fn(async () => { throw new Error('agent_unreachable'); });
    const { runtime, resolvePrimaryWorktreeRoot, resolveGitBinaryForSpawn } = setup(readDisplayMetadata);
    const variables = await runtime.buildTemplateVariables({ properties: { sessionTitle: 'Known', directory } }, null);
    expect(variables.branch).toBe('');
    expect(variables.project_name).toBe(directory ? 'worktree' : 'Active');
    expect(readDisplayMetadata).toHaveBeenCalledWith(directory ?? '/agent/active');
    expect(resolvePrimaryWorktreeRoot).not.toHaveBeenCalled();
    expect(resolveGitBinaryForSpawn).not.toHaveBeenCalled();
  });
});
