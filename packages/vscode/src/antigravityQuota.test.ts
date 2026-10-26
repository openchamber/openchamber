import { after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The accounts file path is resolved when the module loads, so point it at a
// scratch directory before importing the providers.
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-vscode-antigravity-'));
process.env.OPENCODE_CONFIG_DIR = configDir;
fs.writeFileSync(path.join(configDir, 'antigravity-accounts.json'), JSON.stringify({
  accounts: [{ refreshToken: 'test-refresh', projectId: 'test-project', email: 'test@example.com' }],
}));

const { fetchQuotaForProvider } = await import('./quotaProviders');
const { antigravityUserAgent } = await import('../../web/server/lib/quota/providers/antigravity/client.js');

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

after(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
});

const bucket = (window: string, remainingFraction: number) => ({
  bucketId: window,
  window,
  resetTime: '2026-10-25T10:00:00Z',
  remainingFraction,
});

// Mirrors the gating measured in #5138: a 1.x client gets no Gemini group.
const stubGoogle = () => {
  const userAgents: Array<{ url: string; userAgent: string | null }> = [];
  globalThis.fetch = async (url, options) => {
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      return Response.json({ access_token: 'test-access' });
    }
    const userAgent = new Headers(options?.headers).get('User-Agent');
    userAgents.push({ url: String(url), userAgent });
    assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer test-access');

    if (String(url).endsWith(':retrieveUserQuotaSummary')) {
      const thirdParty = { displayName: 'Claude and GPT models', buckets: [bucket('5h', 0.8), bucket('weekly', 0.5)] };
      const gemini = { displayName: 'Gemini Models', buckets: [bucket('5h', 0.9), bucket('weekly', 0.6)] };
      const isCurrentClient = /^antigravity\/([2-9]|\d{2,})\./.test(userAgent ?? '');
      return Response.json({ groups: isCurrentClient ? [gemini, thirdParty] : [thirdParty] });
    }
    return Response.json({
      models: {
        'gemini-3.8-flash': { quotaInfo: { remainingFraction: 0.9 } },
        'claude-sonnet-5-5': { quotaInfo: { remainingFraction: 0.8 } },
      },
    });
  };
  return userAgents;
};

describe('VS Code Antigravity quota', () => {
  it('identifies as the current Antigravity client and shows Gemini and Claude 5-hour and weekly limits', async () => {
    const userAgents = stubGoogle();

    const result = await fetchQuotaForProvider('antigravity');

    assert.equal(result.ok, true);
    assert.deepEqual(userAgents.map((entry) => entry.userAgent), [antigravityUserAgent(), antigravityUserAgent()]);
    const models = result.usage?.models ?? {};
    assert.equal(models['gemini-3.8-flash']?.windows['5h']?.remainingPercent, 90);
    assert.equal(models['gemini-3.8-flash']?.windows.weekly?.remainingPercent, 60);
    assert.equal(models['claude-sonnet-5-5']?.windows['5h']?.remainingPercent, 80);
    assert.equal(models['claude-sonnet-5-5']?.windows.weekly?.remainingPercent, 50);
    assert.ok(!JSON.stringify(result).includes('test-access'));
  });
});
