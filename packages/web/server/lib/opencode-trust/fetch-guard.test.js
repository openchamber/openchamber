import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'os';
import path from 'path';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'fs/promises';

import { guardOpenCodeFetch } from './fetch-guard.js';
import { createOpenCodeTrust, OPENCODE_TRUST_REQUIRED } from './index.js';

describe('guardOpenCodeFetch', () => {
  let root;
  let repo;
  let plain;
  let sent;
  let guarded;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'opencode-trust-fetch-')));
    repo = path.join(root, 'repo');
    await mkdir(path.join(repo, '.opencode', 'plugins'), { recursive: true });
    await writeFile(path.join(repo, '.opencode', 'plugins', 'probe.js'), 'export default {}');
    plain = path.join(root, 'plain');
    await mkdir(plain);
    sent = [];
    guarded = guardOpenCodeFetch({
      fetchImpl: async (input) => {
        const url = String(input instanceof Request ? input.url : input);
        sent.push(url);
        if (url.endsWith('/api/session/ses_repo')) return Response.json({ data: { id: 'ses_repo', location: { directory: repo } } });
        if (url.endsWith('/api/session/ses_plain')) return Response.json({ data: { id: 'ses_plain', location: { directory: plain } } });
        return Response.json({ ok: true });
      },
      openCodeTrust: createOpenCodeTrust({ storePath: path.join(root, 'trust.json'), homeDirectory: path.join(root, 'home') }),
      buildOpenCodeUrl: (requestPath) => `http://127.0.0.1:4096${requestPath}`,
      getOpenCodeAuthHeaders: () => ({}),
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('refuses what the server sends OpenCode for an untrusted folder', async () => {
    const response = await guarded('http://127.0.0.1:4096/api/agent/title', {
      headers: { 'x-opencode-directory': encodeURIComponent(repo) },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: OPENCODE_TRUST_REQUIRED });
    expect(sent).toEqual([]);
  });

  it('checks the folder of the session a request acts on', async () => {
    const response = await guarded(new Request('http://127.0.0.1:4096/api/session/ses_repo/prompt', { method: 'POST', body: '{}' }));
    expect(response.status).toBe(403);
    expect(sent).toEqual(['http://127.0.0.1:4096/api/session/ses_repo']);
  });

  it('checks the folder a session moves into, from a string or a Request body', async () => {
    const url = 'http://127.0.0.1:4096/api/session/ses_plain/move';
    const intoRepo = await guarded(url, { method: 'POST', body: JSON.stringify({ directory: repo }) });
    expect(intoRepo.status).toBe(403);
    expect(await intoRepo.json()).toMatchObject({ code: OPENCODE_TRUST_REQUIRED, directory: repo });
    const asRequest = await guarded(new Request(url, { method: 'POST', body: JSON.stringify({ directory: repo }) }));
    expect(asRequest.status).toBe(403);
    expect(sent.filter((sentUrl) => sentUrl === url)).toEqual([]);

    const request = new Request(url, { method: 'POST', body: JSON.stringify({ directory: plain }) });
    expect((await guarded(request)).status).toBe(200);
    expect(sent.at(-1)).toBe(url);
    expect(request.bodyUsed).toBe(false);
  });

  it('resolves a relative move against where the session is now', async () => {
    const next = path.join(root, 'next');
    await mkdir(path.join(next, 'evil', '.opencode', 'plugins'), { recursive: true });
    await writeFile(path.join(next, 'evil', '.opencode', 'plugins', 'probe.js'), 'export default {}');
    let location = plain;
    const moving = guardOpenCodeFetch({
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (url.endsWith('/api/session/ses_moving')) return Response.json({ data: { id: 'ses_moving', location: { directory: location } } });
        location = path.resolve(location, JSON.parse(init.body).directory);
        return new Response(null, { status: 204 });
      },
      openCodeTrust: createOpenCodeTrust({ storePath: path.join(root, 'trust-moving.json'), homeDirectory: path.join(root, 'home') }),
      buildOpenCodeUrl: (requestPath) => `http://127.0.0.1:4096${requestPath}`,
      getOpenCodeAuthHeaders: () => ({}),
    });
    const move = (directory) => moving('http://127.0.0.1:4096/api/session/ses_moving/move', {
      method: 'POST',
      body: JSON.stringify({ directory }),
    });

    expect((await move(next)).status).toBe(204);
    const relative = await move('evil');
    expect(relative.status).toBe(403);
    expect(await relative.json()).toMatchObject({ directory: path.join(next, 'evil') });
    expect(location).toBe(next);
  });

  it('leaves requests to anywhere else alone', async () => {
    const response = await guarded('https://example.com/api/agent', { headers: { 'x-opencode-directory': repo } });
    expect(response.status).toBe(200);
    expect(sent).toEqual(['https://example.com/api/agent']);
  });
});
