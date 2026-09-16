import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { createResolvedModelRuntime } from './runtime.js';

const temporaryDirectories = [];
const originalFetch = globalThis.fetch;
const envKeys = ['OPENCHAMBER_RESOLVED_MODEL_URL', 'OPENCHAMBER_RESOLVED_MODEL_TOKEN'];
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

afterEach(async () => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

/**
 * Loads the materialized plugin exactly as the OpenCode child would, then
 * routes one tagged and one untagged request through the patched fetch.
 */
const createPluginHarness = async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-resolved-model-plugin-'));
  temporaryDirectories.push(dataDir);
  const runtime = createResolvedModelRuntime({
    crypto,
    fsPromises: fs,
    path,
    dataDir,
    getActivePort: () => 3901,
    env: {},
  });
  const env = await runtime.prepareManagedOpenCodeEnv('{}');
  process.env.OPENCHAMBER_RESOLVED_MODEL_URL = env.OPENCHAMBER_RESOLVED_MODEL_URL;
  process.env.OPENCHAMBER_RESOLVED_MODEL_TOKEN = env.OPENCHAMBER_RESOLVED_MODEL_TOKEN;

  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url) === env.OPENCHAMBER_RESOLVED_MODEL_URL) {
      return new Response('{"ok":true}', { status: 200 });
    }
    return new Response('{}', {
      status: 200,
      headers: {
        'x-litellm-model-name': 'hosted_vllm/deepseek-ai/DeepSeek-V4.1-Flash',
        'x-litellm-model-group': 'bsp-agent-beta',
        'x-litellm-call-id': 'call-1',
      },
    });
  };

  const pluginPath = path.join(dataDir, 'resolved-model', 'openchamber-resolved-model-plugin.js');
  const module = await import(`${pathToFileURL(pluginPath).href}?test=${Date.now()}`);
  const hooks = await module.OpenChamberResolvedModelPlugin();
  // The report is fire-and-forget; let its microtasks flush before asserting.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  return { env, hooks, calls, settle };
};

describe('managed resolved-model plugin', () => {
  it('tags outgoing chat requests with the session id', async () => {
    const { hooks } = await createPluginHarness();
    const output = { headers: {} };

    await hooks['chat.headers']({ sessionID: 'ses_1' }, output);
    expect(output.headers['x-openchamber-session']).toBe('ses_1');

    await hooks['chat.headers']({ sessionID: '' }, output);
    expect(output.headers['x-openchamber-session']).toBe('ses_1');
  });

  it('reports the resolved model from response headers for a tagged request', async () => {
    const { env, hooks, calls, settle } = await createPluginHarness();
    const output = { headers: {} };
    await hooks['chat.headers']({ sessionID: 'ses_1' }, output);

    const response = await globalThis.fetch('https://llm.example/v1/chat/completions', { headers: output.headers });
    expect(response.status).toBe(200);
    await settle();

    const report = calls.find((call) => call.url === env.OPENCHAMBER_RESOLVED_MODEL_URL);
    expect(report).toBeDefined();
    expect(report.init.headers.authorization).toBe(`Bearer ${env.OPENCHAMBER_RESOLVED_MODEL_TOKEN}`);
    expect(JSON.parse(report.init.body)).toEqual({
      sessionID: 'ses_1',
      model: 'hosted_vllm/deepseek-ai/DeepSeek-V4.1-Flash',
      modelGroup: 'bsp-agent-beta',
      callId: 'call-1',
    });
  });

  it('never reports untagged requests', async () => {
    const { env, calls, settle } = await createPluginHarness();

    await globalThis.fetch('https://llm.example/v1/chat/completions');
    await settle();

    expect(calls.find((call) => call.url === env.OPENCHAMBER_RESOLVED_MODEL_URL)).toBeUndefined();
  });

  it('leaves the response untouched for downstream consumers', async () => {
    const { hooks } = await createPluginHarness();
    const output = { headers: {} };
    await hooks['chat.headers']({ sessionID: 'ses_1' }, output);

    const response = await globalThis.fetch('https://llm.example/v1/chat/completions', { headers: output.headers });
    expect(await response.text()).toBe('{}');
    expect(response.headers.get('content-type')).toContain('text/plain');
  });
});
