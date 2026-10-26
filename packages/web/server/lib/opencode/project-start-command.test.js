import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';

import { configureProjectStartCommandSource, openCodeProjectStartCommandSource, readProjectStartCommand } from './project-start-command.js';

describe('readProjectStartCommand from the running OpenCode', () => {
  let server;
  let requests;
  let projects;
  let failing;

  beforeEach(async () => {
    requests = [];
    failing = false;
    // OpenCode 2.x names the project by its origin remote, so the record the
    // checkout resolves to carries an ID unrelated to the root commit.
    projects = [
      { id: 'other-project', canonical: '/work/other', commands: { start: 'echo other' }, time: { created: 1, updated: 1, active: 1 }, sandboxes: [] },
      { id: 'remote-hash', canonical: '/work/my repo', commands: { start: '  bun install  ' }, time: { created: 1, updated: 1, active: 1 }, sandboxes: [] },
    ];
    server = http.createServer((req, res) => {
      requests.push({ url: req.url, directory: req.headers['x-opencode-directory'] ?? null, authorization: req.headers.authorization });
      res.setHeader('content-type', 'application/json');
      if (failing) {
        res.statusCode = 500;
        res.end(JSON.stringify({ name: 'UnknownError', message: 'boom' }));
        return;
      }
      if (req.url.startsWith('/api/location')) {
        res.end(JSON.stringify({ directory: '/work/my repo', project: { id: 'remote-hash', directory: '/work/my repo', canonical: '/work/my repo' } }));
        return;
      }
      if (req.url.startsWith('/api/project')) {
        res.end(JSON.stringify(projects));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    configureProjectStartCommandSource(openCodeProjectStartCommandSource({
      buildOpenCodeUrl: (path) => `http://127.0.0.1:${port}${path}`,
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic test' }),
    }));
  });

  afterEach(async () => {
    configureProjectStartCommandSource(null);
    vi.restoreAllMocks();
    await new Promise((resolve) => server.close(resolve));
  });

  it('answers the command of the project the checkout resolves to, asked in that checkout', async () => {
    await expect(readProjectStartCommand('/work/my repo')).resolves.toBe('bun install');
    expect(requests.map(({ url }) => url.split('?')[0]).sort()).toEqual(['/api/location', '/api/project']);
    for (const request of requests) {
      expect(request.directory).toBe(encodeURIComponent('/work/my repo'));
      expect(request.authorization).toBe('Basic test');
    }
  });

  it('answers nothing for a project without a start command', async () => {
    delete projects[1].commands;
    await expect(readProjectStartCommand('/work/my repo')).resolves.toBe('');
  });

  it('runs nothing and logs when OpenCode cannot answer', async () => {
    failing = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(readProjectStartCommand('/work/my repo')).resolves.toBe('');
    expect(warn).toHaveBeenCalledWith('Failed to read the project start command from OpenCode:', expect.any(String));
  });

  it('runs nothing before a source is wired', async () => {
    configureProjectStartCommandSource(null);
    await expect(readProjectStartCommand('/work/my repo')).resolves.toBe('');
    expect(requests).toEqual([]);
  });
});
