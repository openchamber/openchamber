import { afterEach, describe, expect, mock, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

mock.module('vscode', () => ({
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({ get: () => undefined }),
  },
}));

// Keep any import-time config materialisation out of the real OpenChamber
// config, mirroring bridge-config-runtime.test.js.
const scratchConfigRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-settings-'));
process.env.XDG_CONFIG_HOME = path.join(scratchConfigRoot, 'xdg');
process.env.OPENCODE_CONFIG_DIR = '';

const { fetchOpenCodeSkillsFromApi } = await import('./bridge-settings-runtime.ts');

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const createCtx = (workingDirectory) => ({
  manager: {
    getApiUrl: () => 'http://opencode.test',
    getWorkingDirectory: () => workingDirectory,
    getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test-token' }),
  },
});

const stubSkillListResponse = (data) => {
  const fetchMock = mock(async () =>
    new Response(JSON.stringify({ location: { directory: 'scratch' }, data }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  globalThis.fetch = fetchMock;
  return fetchMock;
};

describe('fetchOpenCodeSkillsFromApi payload mapping', () => {
  test('reads the v2 `path` field, keeps the v1 `location` fallback, and drops unlocated items', async () => {
    const projectRoot = path.join(os.tmpdir(), `oc-vscode-skills-${Date.now()}`);
    const workspaces = [
      { id: 'v2-path-skill', name: 'v2-path-skill', path: path.join(projectRoot, '.agents', 'skills', 'v2-path-skill'), description: 'v2 path', content: 'content-v2' },
      { id: 'v1-location-skill', name: 'v1-location-skill', location: path.join(projectRoot, '.agents', 'skills', 'v1-location-skill'), description: 'v1 location', content: 'content-v1' },
      { id: 'builtin-skill', name: 'builtin-skill', path: '<built-in>', description: 'built-in' },
      { id: 'opencode', name: 'OpenCode', path: '/builtin/opencode.md', description: 'v2 built-in', content: 'builtin-content' },
      { id: 'unlocated-skill', name: 'unlocated-skill', description: 'no location at all' },
    ];
    const fetchMock = stubSkillListResponse(workspaces);

    const skills = await fetchOpenCodeSkillsFromApi(createCtx(projectRoot), projectRoot);

    expect(fetchMock).toHaveBeenCalled();
    expect(skills).not.toBeNull();
    const byName = new Map(skills.map((skill) => [skill.name, skill]));

    // OpenCode v2 payload: the item carries `path` instead of `location`.
    expect(byName.get('v2-path-skill')).toEqual({
      id: 'v2-path-skill',
      name: 'v2-path-skill',
      path: path.join(projectRoot, '.agents', 'skills', 'v2-path-skill'),
      scope: 'project',
      source: 'agents',
      description: 'v2 path',
      content: 'content-v2',
    });

    // OpenCode v1 payload: `location` is still accepted as the fallback.
    expect(byName.get('v1-location-skill')).toEqual({
      id: 'v1-location-skill',
      name: 'v1-location-skill',
      path: path.join(projectRoot, '.agents', 'skills', 'v1-location-skill'),
      scope: 'project',
      source: 'agents',
      description: 'v1 location',
      content: 'content-v1',
    });

    // Built-in skills keep the opencode source and user scope.
    expect(byName.get('builtin-skill')).toEqual({
      id: 'builtin-skill',
      name: 'builtin-skill',
      path: '<built-in>',
      scope: 'user',
      source: 'opencode',
      description: 'built-in',
      content: '',
    });

    // OpenCode v2 built-ins carry a synthetic `/builtin/` path; normalize to the read-only marker.
    expect(byName.get('OpenCode')).toEqual({
      // The id OpenCode reports, not the display name.
      id: 'opencode',
      name: 'OpenCode',
      path: '<built-in>',
      scope: 'user',
      source: 'opencode',
      description: 'v2 built-in',
      content: 'builtin-content',
    });

    // Items with neither field are dropped, unchanged.
    expect(byName.has('unlocated-skill')).toBe(false);
  });

  test('returns null when the API responds with an error or a non-list payload', async () => {
    globalThis.fetch = mock(async () => new Response('boom', { status: 500 }));
    expect(await fetchOpenCodeSkillsFromApi(createCtx('dir'), 'dir')).toBeNull();

    stubSkillListResponse({ not: 'an array' });
    expect(await fetchOpenCodeSkillsFromApi(createCtx('dir'), 'dir')).toBeNull();
  });

  test('returns null when the context exposes no API url', async () => {
    expect(await fetchOpenCodeSkillsFromApi({ manager: { getApiUrl: () => null } }, 'dir')).toBeNull();
  });
});
describe('createOpenCodePolicyReader', () => {
  test('reads the OpenCode version and the directory-scoped config documents', async () => {
    const { createOpenCodePolicyReader } = await import('./bridge-settings-runtime.ts');
    const requests = [];
    globalThis.fetch = mock(async (url, init) => {
      requests.push({ path: new URL(url).pathname, directory: new Headers(init.headers).get('x-opencode-directory') });
      if (new URL(url).pathname === '/api/info') return Response.json({ version: '2.0.28', pid: 1, urls: [], paths: { tmp: '/tmp' } });
      return Response.json([
        { type: 'directory', path: '/repo/.opencode' },
        { type: 'document', path: '/repo/opencode.json', info: { experimental: { policies: [{ action: 'integration.use', resource: 'skill:x', effect: 'deny' }] } } },
      ]);
    });
    const reader = createOpenCodePolicyReader(createCtx('/repo'));

    expect(await reader.readVersion()).toBe('2.0.28');
    expect(await reader.readConfigEntries('/répo')).toHaveLength(2);
    expect(requests).toEqual([
      { path: '/api/info', directory: null },
      { path: '/api/config', directory: encodeURIComponent('/répo') },
    ]);
  });

  test('rejects when OpenCode cannot be read, so a failure never reads as no policies', async () => {
    const { createOpenCodePolicyReader } = await import('./bridge-settings-runtime.ts');
    await expect(createOpenCodePolicyReader({ manager: { getApiUrl: () => null } }).readVersion()).rejects.toThrow();
    globalThis.fetch = mock(async () => new Response('boom', { status: 500 }));
    await expect(createOpenCodePolicyReader(createCtx('/repo')).readConfigEntries('/repo')).rejects.toThrow();
    globalThis.fetch = mock(async () => Response.json({ not: 'a list' }));
    await expect(createOpenCodePolicyReader(createCtx('/repo')).readConfigEntries('/repo')).rejects.toThrow();
  });
});
