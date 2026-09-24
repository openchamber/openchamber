import { afterEach, describe, expect, mock, test } from 'bun:test';
import http from 'node:http';

mock.module('vscode', () => ({
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({ get: () => undefined }),
  },
}));

const { fetchOpenCodeSkillsFromApi } = await import('./bridge-settings-runtime.ts');

const startOpenCodeSkillFixture = (skills) => new Promise((resolve, reject) => {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url?.startsWith('/api/skill')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: skills }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    resolve({
      baseUrl: `http://127.0.0.1:${port}`,
      close: () => new Promise((closeResolve, closeReject) => {
        server.close((error) => (error ? closeReject(error) : closeResolve()));
      }),
    });
  });
});

describe('fetchOpenCodeSkillsFromApi', () => {
  /** @type {{ close: () => Promise<void> } | null} */
  let fixture = null;

  afterEach(async () => {
    if (fixture) {
      await fixture.close();
      fixture = null;
    }
  });

  test('parses OpenCode 2.x skill.list records that use path', async () => {
    const pluginSkillPath = '/home/user/.config/opencode/node_modules/example-plugin/skills/deploy/SKILL.md';
    fixture = await startOpenCodeSkillFixture([
      {
        name: 'deploy',
        path: pluginSkillPath,
        description: 'Deploy skill',
        content: '# Deploy',
      },
      {
        name: 'legacy-location-only',
        location: '/home/user/.config/opencode/skills/legacy-location-only/SKILL.md',
        description: 'Must not appear without path',
      },
    ]);

    const skills = await fetchOpenCodeSkillsFromApi({
      manager: {
        getApiUrl: () => fixture.baseUrl,
        getOpenCodeAuthHeaders: () => ({}),
      },
    });

    expect(skills).not.toBeNull();
    expect(skills?.map((skill) => skill.name)).toContain('deploy');
    const deploy = skills?.find((skill) => skill.name === 'deploy');
    expect(deploy?.path).toBe(pluginSkillPath);
    expect(deploy?.description).toBe('Deploy skill');
    expect(deploy?.content).toBe('# Deploy');
    expect(skills?.some((skill) => skill.name === 'legacy-location-only')).toBe(false);
  });
});
