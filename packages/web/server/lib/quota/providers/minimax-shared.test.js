import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureOpenCodeCredentials } from '../../opencode/auth.js';
import { createMiniMaxCodingPlanProvider } from './minimax-shared.js';

let credentialEntries = [{ active: true, integrationID: 'minimax-test', value: { type: 'key', key: 'test-key' } }];

beforeEach(() => {
  configureOpenCodeCredentials({ list: async () => credentialEntries });
});

const TOKEN_URL = 'https://token.example/remains';
const CODING_URL = 'https://coding.example/remains';

const provider = createMiniMaxCodingPlanProvider({
  providerId: 'minimax-test',
  providerName: 'MiniMax Test',
  aliases: ['minimax-test'],
  tokenPlanUrl: TOKEN_URL,
  codingPlanUrl: CODING_URL,
});

afterEach(() => {
  vi.unstubAllGlobals();
  configureOpenCodeCredentials(null);
  credentialEntries = [{ active: true, integrationID: 'minimax-test', value: { type: 'key', key: 'test-key' } }];
});

const okPayload = (modelRemains) => ({
  base_resp: { status_code: 0 },
  model_remains: modelRemains,
});

// fetch stub keyed by URL: values are payloads, or null for an HTTP failure.
const stubFetchByUrl = (byUrl) => {
  const calls = [];
  const fetchMock = vi.fn(async (url) => {
    calls.push(url);
    const payload = byUrl[url];
    if (!payload) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => payload };
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
};

const model = (overrides) => ({ model_name: 'other', ...overrides });

describe('MiniMax shared provider', () => {
  it('reports not configured when no credential exists', async () => {
    credentialEntries = [];
    const result = await provider.fetchQuota();
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(false);
    expect(result.error).toBe('Not configured');
  });

  it('prefers a MiniMax-M model with a positive total over a text model listed first', async () => {
    stubFetchByUrl({
      [TOKEN_URL]: okPayload([
        model({ model_name: 'general', current_interval_remaining_percent: 50 }),
        model({ model_name: 'MiniMax-M2', current_interval_total_count: 100, current_interval_remaining_percent: 80 }),
      ]),
    });
    const result = await provider.fetchQuota();
    expect(result.ok).toBe(true);
    expect(result.usage.windows['5h'].usedPercent).toBe(20);
  });

  it('prefers a text model over a plain percent candidate listed first', async () => {
    stubFetchByUrl({
      [TOKEN_URL]: okPayload([
        model({ model_name: 'other', current_interval_remaining_percent: 10 }),
        model({ model_name: 'chat', current_interval_remaining_percent: 50 }),
      ]),
    });
    const result = await provider.fetchQuota();
    expect(result.usage.windows['5h'].usedPercent).toBe(50);
  });

  it('falls back to the first numeric-percent model when no name matches', async () => {
    stubFetchByUrl({
      [TOKEN_URL]: okPayload([
        model({ model_name: 'other', remains_time: 3_600_000 }),
        model({ model_name: 'another', current_interval_remaining_percent: 10, remains_time: 7_200_000 }),
      ]),
    });
    const result = await provider.fetchQuota();
    expect(result.usage.windows['5h'].usedPercent).toBe(90);
    expect(result.usage.windows['5h'].windowSeconds).toBeNull();
  });

  it('falls back to the first entry when nothing else matches', async () => {
    stubFetchByUrl({
      [TOKEN_URL]: okPayload([
        model({ model_name: 'other', remains_time: 3_600_000 }),
        model({ model_name: 'another', remains_time: 7_200_000 }),
      ]),
    });
    const result = await provider.fetchQuota();
    expect(result.ok).toBe(true);
    expect(result.usage.windows['5h'].windowSeconds).toBeNull();
  });

  it('inverts the usage count for the token-plan endpoint (total - usage)', async () => {
    stubFetchByUrl({
      [TOKEN_URL]: okPayload([
        model({ current_interval_total_count: 100, current_interval_usage_count: 25 }),
      ]),
    });
    const result = await provider.fetchQuota();
    expect(result.usage.windows['5h'].usedPercent).toBe(75);
  });

  it('uses the usage count directly for the coding-plan endpoint', async () => {
    stubFetchByUrl({
      [TOKEN_URL]: { base_resp: { status_code: 1 }, model_remains: [] },
      [CODING_URL]: okPayload([
        model({ current_interval_total_count: 100, current_interval_usage_count: 25 }),
      ]),
    });
    const result = await provider.fetchQuota();
    expect(result.usage.windows['5h'].usedPercent).toBe(25);
  });

  it('falls back to the coding-plan endpoint when the token-plan payload is unusable, in order', async () => {
    const calls = stubFetchByUrl({
      [TOKEN_URL]: { base_resp: { status_code: 0 }, model_remains: [] },
      [CODING_URL]: okPayload([model({ current_interval_remaining_percent: 60 })]),
    });
    const result = await provider.fetchQuota();
    expect(result.ok).toBe(true);
    expect(calls).toEqual([TOKEN_URL, CODING_URL]);
    expect(result.usage.windows['5h'].usedPercent).toBe(40);
  });

  it('does not call the coding-plan endpoint when the token-plan payload is usable', async () => {
    const calls = stubFetchByUrl({
      [TOKEN_URL]: okPayload([model({ current_interval_remaining_percent: 60 })]),
      [CODING_URL]: okPayload([model({ current_interval_remaining_percent: 1 })]),
    });
    await provider.fetchQuota();
    expect(calls).toEqual([TOKEN_URL]);
  });

  it('fails when both endpoints return unusable payloads', async () => {
    stubFetchByUrl({
      [TOKEN_URL]: { base_resp: { status_code: 2 }, model_remains: [] },
      [CODING_URL]: null,
    });
    const result = await provider.fetchQuota();
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe('API returned no usable quota data');
  });

  it('omits the weekly window when the weekly status is 3 (inactive)', async () => {
    stubFetchByUrl({
      [TOKEN_URL]: okPayload([
        model({
          current_interval_remaining_percent: 50,
          current_weekly_remaining_percent: 40,
          current_weekly_total_count: 100,
          current_weekly_status: 3,
        }),
      ]),
    });
    const result = await provider.fetchQuota();
    expect(result.usage.windows.weekly).toBeUndefined();
  });

  it('includes the weekly window when weekly data exists and the status is not 3', async () => {
    stubFetchByUrl({
      [TOKEN_URL]: okPayload([
        model({
          current_interval_remaining_percent: 50,
          current_weekly_remaining_percent: 40,
          current_weekly_total_count: 100,
        }),
      ]),
    });
    const result = await provider.fetchQuota();
    expect(result.usage.windows.weekly.usedPercent).toBe(60);
  });

  it('omits the weekly window when there is no weekly data', async () => {
    stubFetchByUrl({
      [TOKEN_URL]: okPayload([model({ current_interval_remaining_percent: 50 })]),
    });
    const result = await provider.fetchQuota();
    expect(result.usage.windows.weekly).toBeUndefined();
  });

  it('derives window seconds from the start/end timestamps', async () => {
    stubFetchByUrl({
      [TOKEN_URL]: okPayload([
        model({
          current_interval_remaining_percent: 50,
          start_time: 1_700_000_000,
          end_time: 1_700_018_000,
          remains_time: 3_600_000,
        }),
      ]),
    });
    const result = await provider.fetchQuota();
    expect(result.usage.windows['5h'].windowSeconds).toBe(18000);
  });

  it('reports null window seconds when only remains_time is present', async () => {
    stubFetchByUrl({
      [TOKEN_URL]: okPayload([
        model({
          current_interval_remaining_percent: 50,
          remains_time: 9_664_502,
          current_weekly_remaining_percent: 50,
          current_weekly_total_count: 100,
          weekly_remains_time: 9_664_502,
        }),
      ]),
    });
    const result = await provider.fetchQuota();
    expect(result.usage.windows['5h'].windowSeconds).toBeNull();
    expect(result.usage.windows.weekly.windowSeconds).toBeNull();
  });
});

describe('MiniMax request deadline', () => {
  it('reports no usable data when both endpoints time out, with a deadline on each request', async () => {
    const fetchMock = vi.fn(async () => { throw new DOMException('Timed out', 'TimeoutError'); });
    vi.stubGlobal('fetch', fetchMock);

    const result = await provider.fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe('API returned no usable quota data');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(call[1].signal).toBeInstanceOf(AbortSignal);
    }
  });
});

describe('MiniMax credential selection (#1755)', () => {
  it('falls through an empty or whitespace key to the token in isConfigured', () => {
    expect(provider.isConfigured({ 'minimax-test': { key: '', token: 'valid-token' } })).toBe(true);
    expect(provider.isConfigured({ 'minimax-test': { key: '   ', token: 'valid-token' } })).toBe(true);
    expect(provider.isConfigured({ 'minimax-test': { key: 'real-key', token: 'valid-token' } })).toBe(true);
  });

  it('reports not configured in isConfigured when both fields are empty or whitespace', () => {
    expect(provider.isConfigured({ 'minimax-test': { key: ' ', token: '' } })).toBe(false);
    expect(provider.isConfigured({ 'minimax-test': { key: '', token: '  ' } })).toBe(false);
  });

  it('does not send a whitespace key as a bearer in fetchQuota', async () => {
    credentialEntries = [{ active: true, integrationID: 'minimax-test', value: { type: 'key', key: '   ' } }];
    const calls = stubFetchByUrl({ [TOKEN_URL]: okPayload([model({ model_name: 'general', current_interval_remaining_percent: 50 })]) });

    const result = await provider.fetchQuota();

    expect(result.configured).toBe(false);
    expect(result.error).toBe('Not configured');
    expect(calls).toHaveLength(0);
  });

  it('does not treat an empty key as configured in fetchQuota', async () => {
    credentialEntries = [{ active: true, integrationID: 'minimax-test', value: { type: 'key', key: '' } }];
    const calls = stubFetchByUrl({});

    const result = await provider.fetchQuota();

    expect(result.configured).toBe(false);
    expect(result.error).toBe('Not configured');
    expect(calls).toHaveLength(0);
  });
});
