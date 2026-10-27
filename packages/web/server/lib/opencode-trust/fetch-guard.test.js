import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'os';
import path from 'path';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'fs/promises';

import { guardOpenCodeFetch } from './fetch-guard.js';
import { createOpenCodeTrust, OPENCODE_TRUST_REQUIRED } from './index.js';

describe('guardOpenCodeFetch', () => {
  let root;
  let repo;
  let sent;
  let guarded;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'opencode-trust-fetch-')));
    repo = path.join(root, 'repo');
    await mkdir(path.join(repo, '.opencode', 'plugins'), { recursive: true });
    await writeFile(path.join(repo, '.opencode', 'plugins', 'probe.js'), 'export default {}');
    sent = [];
    guarded = guardOpenCodeFetch({
      fetchImpl: async (input) => {
        const url = String(input instanceof Request ? input.url : input);
        sent.push(url);
        if (url.endsWith('/api/session/ses_repo')) return Response.json({ data: { id: 'ses_repo', location: { directory: repo } } });
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

  it('leaves requests to anywhere else alone', async () => {
    const response = await guarded('https://example.com/api/agent', { headers: { 'x-opencode-directory': repo } });
    expect(response.status).toBe(200);
    expect(sent).toEqual(['https://example.com/api/agent']);
  });
});
