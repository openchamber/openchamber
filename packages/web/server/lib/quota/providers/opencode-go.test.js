import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const previousDataDirectory = process.env.OPENCHAMBER_DATA_DIR;
const temporaryDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-opencode-go-'));
process.env.OPENCHAMBER_DATA_DIR = temporaryDataDirectory;

vi.mock('../../opencode/auth.js', () => ({
  readAuthFile: () => ({ 'opencode-go': { key: 'test-key' } }),
}));

import { fetchOpenCodeGoUsage, fetchQuota, parseOpenCodeGoUsage } from './opencode-go.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  if (previousDataDirectory === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
  else process.env.OPENCHAMBER_DATA_DIR = previousDataDirectory;
  fs.rmSync(temporaryDataDirectory, { recursive: true, force: true });
});

describe('OpenCode Go quota provider', () => {
  it('parses partial API usage windows', () => {
    const windows = parseOpenCodeGoUsage({ usage: { rolling: { percent: 25, resetsAt: '2026-08-12T12:00:00.000Z' }, weekly: { percent: 40, resetsAt: '2026-08-19T12:00:00.000Z' } } });
    expect(windows['5h'].usedPercent).toBe(25);
    expect(windows['5h'].resetAt).toBe('2026-08-12T12:00:00.000Z');
    expect(windows.weekly.usedPercent).toBe(40);
    expect(windows.monthly).toBeUndefined();
  });

  it('does not expose credentials in authentication errors', async () => {
    await expect(fetchOpenCodeGoUsage('secret', async () => new Response('', { status: 403 }))).rejects.toThrow('authentication failed');
  });

  it('uses the Go usage API with bearer authentication', async () => {
    let request;
    const usage = await fetchOpenCodeGoUsage('secret', async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ usage: { rolling: { percent: 25, resetsAt: '2026-08-12T12:00:00.000Z' } } }));
    });
    expect(request.url).toBe('https://opencode.ai/zen/go/v1/usage');
    expect(request.options.headers).toMatchObject({ Accept: 'application/json', Authorization: 'Bearer secret' });
    expect(request.options.headers.Cookie).toBeUndefined();
    expect(usage['5h'].usedPercent).toBe(25);
  });

  it('reads the API key from the OpenCode auth file', async () => {
    const legacyPath = path.join(temporaryDataDirectory, 'quota', 'opencode-go.json');
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, '{not valid json', { mode: 0o600 });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ usage: { rolling: { percent: 25, resetsAt: '2026-08-12T12:00:00.000Z' } } })));
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchQuota();
    expect(result).toMatchObject({ providerId: 'opencode-go', ok: true, configured: true });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer test-key');
    expect(fs.existsSync(legacyPath)).toBe(false);
  });
});
