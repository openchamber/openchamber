import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleSmallModelBridgeMessage, readOpenCodeSmallModelCatalog } from './bridge-small-model-runtime';

// A stand-in OpenCode answering the two reads the Small Model picker needs,
// in the `{ location, data }` envelope OpenCode 2.x uses.
const LOCATION = { directory: '/proj', project: { id: 'p', directory: '/proj', canonical: '/proj' } };

type FakeModel = {
  id: string;
  modelID: string;
  providerID: string;
  name: string;
  enabled: boolean;
  limit: { context: number; output: number };
};
type SeenRequest = { path: string; directory: string | undefined; authorization: string | undefined };

const MODEL = (providerID: string, id: string, enabled = true): FakeModel => ({
  id,
  modelID: id,
  providerID,
  name: id,
  enabled,
  limit: { context: 8_000, output: 4_000 },
});

let providers: Array<{ id: string; name: string }> = [];
let models: FakeModel[] = [];
let requests: SeenRequest[] = [];

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const directory = req.headers['x-opencode-directory'];
  requests.push({
    path: url.pathname,
    directory: Array.isArray(directory) ? directory.join(',') : directory,
    authorization: req.headers.authorization,
  });
  const data = url.pathname === '/api/provider' ? providers : url.pathname === '/api/model' ? models : null;
  if (!data) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ location: LOCATION, data }));
});

let port = 0;
const connection = {
  getApiUrl: () => `http://127.0.0.1:${port}/`,
  getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test-token' }),
};

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // A TCP listener reports `AddressInfo`; the string form is for pipes.
  const address: AddressInfo | string | null = server.address();
  port = address instanceof Object ? address.port : 0;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  providers = [];
  models = [];
  requests = [];
});

const ask = (
  payload: { directory?: string },
  read = (directory: string | undefined) => readOpenCodeSmallModelCatalog(connection, directory),
) => handleSmallModelBridgeMessage({ id: '1', type: 'api:small-model:get', payload }, read);

describe('GET /api/small-model in VS Code', () => {
  test('lists every provider with an enabled model, in OpenCode order', async () => {
    providers = [
      { id: 'openai', name: 'OpenAI' },
      { id: 'anthropic', name: 'Anthropic' },
      { id: 'empty', name: 'No models' },
    ];
    models = [
      MODEL('anthropic', 'claude-haiku-4-5'),
      MODEL('openai', 'gpt-5-nano'),
      MODEL('disabled-only', 'old-model', false),
      MODEL('plugin', 'tiny'),
    ];

    const response = await ask({ directory: '/proj' });

    assert.deepEqual(response, {
      id: '1',
      type: 'api:small-model:get',
      success: true,
      data: { authenticatedProviders: ['openai', 'anthropic', 'plugin'] },
    });
  });

  test('reads the project directory with the OpenCode credentials', async () => {
    await ask({ directory: '/Users/me/my project' });

    assert.deepEqual(requests.map((request) => request.path).sort(), ['/api/model', '/api/provider']);
    for (const request of requests) {
      assert.equal(request.directory, encodeURIComponent('/Users/me/my project'));
      assert.equal(request.authorization, 'Bearer test-token');
    }
  });

  test('without a directory the reads carry no directory header', async () => {
    await ask({});

    assert.equal(requests.length, 2);
    assert.ok(requests.every((request) => request.directory === undefined));
  });

  test('a failed read is an error, never an empty provider list', async () => {
    const response = await ask({ directory: '/proj' }, () => Promise.reject(new Error('OpenCode API unavailable')));

    assert.deepEqual(response, { id: '1', type: 'api:small-model:get', success: false, error: 'OpenCode API unavailable' });
  });

  test('without a running OpenCode the read fails', async () => {
    await assert.rejects(readOpenCodeSmallModelCatalog(undefined, '/proj'), /OpenCode API unavailable/);
  });

  test('other message types are left to the next handler', async () => {
    const response = await handleSmallModelBridgeMessage(
      { id: '2', type: 'api:git/commit-message', payload: {} },
      () => Promise.reject(new Error('must not read')),
    );

    assert.equal(response, null);
  });
});
