import { afterEach, describe, expect, test } from 'bun:test';
import { configureRuntimeUrlResolver } from '@/lib/runtime-url';
import { fetchUserEnvironment } from './environmentApi';

const originalFetch = globalThis.fetch;

describe('environment API', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    configureRuntimeUrlResolver({ apiBaseUrl: '' });
  });

  // What `/api/environment` answers; `references` and `vault` arrived in 2026-10.
  type ServerAnswer = {
    names: string[];
    references?: Record<string, string>;
    vault?: Record<string, { state: string; reason?: string; at?: number }>;
  };
  const serve = (body: ServerAnswer) => {
    configureRuntimeUrlResolver({ apiBaseUrl: 'http://environment.test' });
    globalThis.fetch = async () => Response.json(body);
  };

  test('reads vault references and their last read', async () => {
    serve({
      names: ['GITHUB_TOKEN'],
      references: { GITHUB_TOKEN: 'op://Vertex SRE/github_token/credential' },
      vault: { GITHUB_TOKEN: { state: 'failed', reason: 'op-not-installed', at: 2 } },
    });
    expect(await fetchUserEnvironment()).toEqual({
      names: ['GITHUB_TOKEN'],
      references: { GITHUB_TOKEN: 'op://Vertex SRE/github_token/credential' },
      vault: { GITHUB_TOKEN: { state: 'failed', reason: 'op-not-installed' } },
      secrets: [],
    });
  });

  // A server from before 2026-10 answers names only.
  test('an older server reads as no references', async () => {
    serve({ names: ['API_TOKEN'] });
    expect(await fetchUserEnvironment()).toEqual({ names: ['API_TOKEN'], references: {}, vault: {}, secrets: [] });
  });
});
