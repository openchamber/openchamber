import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { SPACE_LOGIN_CREDENTIAL_ID, WINDOW_PLACEHOLDER_KEY, archivedChatOf, buildLoginRow, buildProviderConfig, createSpaceOpenCode, loginGrantOf } from './space-opencode.js';

const ID = 'a1b2c3d4e5f6';
const GRANTS = [
  { kind: 'model', id: 'anthropic', provider: 'anthropic', upstream: 'https://api.anthropic.com/v1', header: 'x-api-key', source: { kind: 'typed' } },
  { kind: 'domain', id: 'open-0a1b2c3d4e5f', upstream: 'https://registry.example.com/npm/' },
  { kind: 'model', id: 'openai', provider: 'openai', upstream: 'https://api.openai.com/v1', header: 'authorization', source: { kind: 'env', name: 'OPENAI_API_KEY' } },
];
const ACCESS = 'eyJ-live-short-token';
const LOGIN = { methodID: 'chatgpt-token-sharing', access: ACCESS, expires: 1791600000000, metadata: { clientID: 'client_1', scopes: ['chatgpt.tokens.use.direct'], models: [{ slug: 'gpt-5.5' }] } };

describe('the provider configuration inside a space', () => {
  it('names each granted provider as the host does, at the window, with a placeholder key, and leaves domains out', () => {
    expect(buildProviderConfig(GRANTS)).toEqual({
      $schema: 'https://opencode.ai/config.json',
      provider: {
        anthropic: { options: { baseURL: 'http://gatekeeper:8080/model/anthropic', apiKey: WINDOW_PLACEHOLDER_KEY } },
        openai: { options: { baseURL: 'http://gatekeeper:8080/model/openai', apiKey: WINDOW_PLACEHOLDER_KEY } },
      },
    });
    expect(buildProviderConfig([])).toEqual({ $schema: 'https://opencode.ai/config.json', provider: {} });
    // The upstream is the gatekeeper's business; nothing of it is written where the agent reads.
    expect(JSON.stringify(buildProviderConfig(GRANTS))).not.toContain('api.anthropic.com');
  });

  it('writes the whole file over exec, as JSON on stdin, through a temporary name', async () => {
    const calls = [];
    const opencode = createSpaceOpenCode({ exec: async (spaceId, argv, options) => { calls.push({ spaceId, argv, options }); return { code: 0, stdout: '', stderr: '' }; } });
    await opencode.writeProviderConfig(ID, GRANTS);
    expect(calls).toEqual([{
      spaceId: ID,
      argv: ['/bin/sh', '-c', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; mkdir -p /home/space/.config/opencode && cat > /home/space/.config/opencode/opencode.json.new && mv /home/space/.config/opencode/opencode.json.new /home/space/.config/opencode/opencode.json'],
      options: { stdin: `${JSON.stringify(buildProviderConfig(GRANTS), null, 2)}\n` },
    }]);
  });

  it('says what failed inside', async () => {
    const opencode = createSpaceOpenCode({ exec: async () => ({ code: 1, stdout: '', stderr: 'sh: cannot create: Read-only file system\n' }) });
    await expect(opencode.writeProviderConfig(ID, GRANTS)).rejects.toMatchObject({ code: 'space_setup_failed', message: expect.stringContaining('Read-only file system') });
  });

  it('points a provider with a login grant at the window over HTTP, with no placeholder key', () => {
    expect(buildProviderConfig([{ kind: 'login', id: 'openai', provider: 'openai', method: 'chatgpt-browser' }]).provider).toEqual({
      openai: { options: { baseURL: 'http://gatekeeper:8080/model/openai', transport: 'http' } },
    });
  });
});

describe('the login row inside a space', () => {
  it('sends each login method to the upstream OpenCode uses for it, as a bearer, and knows no other', () => {
    expect(loginGrantOf('openai', LOGIN)).toEqual({ upstream: 'https://api.openai.com/v1', header: 'authorization', secret: ACCESS });
    expect(loginGrantOf('openai', { ...LOGIN, methodID: 'chatgpt-browser' })).toMatchObject({ upstream: 'https://chatgpt.com/backend-api/codex' });
    expect(loginGrantOf('openai', { ...LOGIN, methodID: 'chatgpt-headless' })).toMatchObject({ upstream: 'https://chatgpt.com/backend-api/codex' });
    expect(loginGrantOf('openai', { ...LOGIN, methodID: 'some-new-method' })).toBeNull();
    expect(loginGrantOf('github-copilot', { ...LOGIN, methodID: 'device' })).toBeNull();
  });

  it('names the method and the account, holds placeholder tokens that never end, and carries no other metadata', () => {
    const row = buildLoginRow('openai', { ...LOGIN, metadata: { ...LOGIN.metadata, someNewSecret: 'shh' } });
    expect(row).toEqual({
      id: SPACE_LOGIN_CREDENTIAL_ID,
      integrationID: 'openai',
      label: 'OpenChamber space',
      value: { type: 'oauth', methodID: 'chatgpt-token-sharing', access: WINDOW_PLACEHOLDER_KEY, refresh: WINDOW_PLACEHOLDER_KEY, expires: Date.UTC(2100, 0, 1), metadata: { clientID: 'client_1', scopes: ['chatgpt.tokens.use.direct'] } },
    });
    expect(JSON.stringify(row)).not.toContain(ACCESS);
    expect(buildLoginRow('openai', { ...LOGIN, methodID: 'chatgpt-browser', metadata: { accountID: 'acct_1' } }).value.metadata).toEqual({ accountID: 'acct_1' });
    expect(buildLoginRow('openai', { ...LOGIN, metadata: {} }).value).not.toHaveProperty('metadata');
  });

  const answering = (statuses) => {
    const asked = [];
    const requestInside = async (spaceId, request) => {
      asked.push({ spaceId, ...request });
      const response = Readable.from([]);
      response.statusCode = statuses[asked.length - 1] ?? 500;
      return response;
    };
    return { asked, opencode: createSpaceOpenCode({ exec: async () => ({ code: 0 }), requestInside }) };
  };

  it('replaces the row through OpenCode inside: the old one out, the new one in as JSON', async () => {
    const { asked, opencode } = answering([204, 200]);
    await opencode.writeLogin(ID, 'openai', LOGIN);
    expect(asked).toEqual([
      expect.objectContaining({ spaceId: ID, method: 'DELETE', path: `/api/credential/${SPACE_LOGIN_CREDENTIAL_ID}` }),
      expect.objectContaining({ spaceId: ID, method: 'POST', path: '/api/credential', headers: expect.objectContaining({ 'content-type': 'application/json' }), body: JSON.stringify(buildLoginRow('openai', LOGIN)) }),
    ]);
    expect(JSON.stringify(asked)).not.toContain(ACCESS);
    // A row that was not there is nothing to remove.
    const first = answering([404, 200]);
    await first.opencode.writeLogin(ID, 'openai', LOGIN);
    expect(first.asked).toHaveLength(2);
  });

  it('says when OpenCode inside refused the row, or would not let the old one go', async () => {
    await expect(answering([204, 409]).opencode.writeLogin(ID, 'openai', LOGIN)).rejects.toMatchObject({ code: 'space_setup_failed', message: expect.stringContaining('409') });
    await expect(answering([500]).opencode.writeLogin(ID, 'openai', LOGIN)).rejects.toMatchObject({ code: 'space_setup_failed', message: expect.stringContaining('500') });
    await expect(answering([404]).opencode.removeLogin(ID)).resolves.toBeUndefined();
  });
});

describe('a chat taken out of a space for the archive', () => {
  const CHAT = 'ses_f10ac21b9ffeQoN3eUQ3H9hwpf';
  const INFO = {
    id: CHAT,
    projectID: 'p1',
    cost: 0.5,
    tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
    outcome: 'failed',
    time: { created: 10, updated: 20, idle: 15 },
    title: 'Fix the greeting',
    location: { directory: '/spaces/a1b2c3d4e5f6/demo' },
    permissions: [{ permission: '*', pattern: '*', action: 'allow' }],
    metadata: { goal: 'run forever' },
    agent: 'build',
  };
  const MESSAGES = [{ id: 'msg_1', type: 'user', text: 'hello <script>' }];
  const answering = (statusCode, body) => {
    const asked = [];
    const requestInside = async (spaceId, request) => {
      asked.push({ spaceId, ...request });
      const response = Readable.from([Buffer.from(body instanceof Object ? JSON.stringify(body) : body)]);
      response.statusCode = statusCode;
      return response;
    };
    return { asked, opencode: createSpaceOpenCode({ exec: async () => ({ code: 0 }), requestInside, chatMaxBytes: 4096 }) };
  };

  it('asks the server inside for the export and keeps only the checked fields of the record', async () => {
    const { asked, opencode } = answering(200, { data: { info: INFO, messages: MESSAGES } });
    const chat = await opencode.exportChat(ID, CHAT);
    expect(asked).toEqual([expect.objectContaining({ spaceId: ID, path: `/api/experimental/session/${CHAT}/export` })]);
    expect(chat.messages).toEqual(MESSAGES);
    expect(chat.info).not.toHaveProperty('permissions');
    expect(chat.info).not.toHaveProperty('metadata');
    expect(chat.info).not.toHaveProperty('agent');
  });

  it('refuses a chat over the cap, one that is not whole, and one that names another id', async () => {
    await expect(answering(200, 'x'.repeat(5000)).opencode.exportChat(ID, CHAT)).rejects.toMatchObject({ code: 'chat_too_large' });
    await expect(answering(200, '{"data":').opencode.exportChat(ID, CHAT)).rejects.toMatchObject({ code: 'chat_export_failed' });
    await expect(answering(404, {}).opencode.exportChat(ID, CHAT)).rejects.toMatchObject({ code: 'chat_export_failed' });
    await expect(answering(200, { data: { info: { ...INFO, id: 'ses_other' }, messages: [] } }).opencode.exportChat(ID, CHAT)).rejects.toMatchObject({ code: 'chat_export_failed' });
    await expect(answering(200, {}).opencode.exportChat(ID, '../../config')).rejects.toThrow();
  });

  it('gives up on a chat that does not come whole in time, however slowly the space keeps sending', async () => {
    const requestInside = async () => {
      const response = new Readable({ read() {} });
      response.statusCode = 200;
      response.push('{"data":');
      return response;
    };
    const opencode = createSpaceOpenCode({ exec: async () => ({ code: 0 }), requestInside, chatTimeoutMs: 50 });
    await expect(opencode.exportChat(ID, CHAT)).rejects.toMatchObject({ code: 'chat_export_timed_out' });
  });

  it('builds the import at the archive directory, stamped archived, with a parent only from the same archive', () => {
    const exported = { info: { ...INFO, parentID: 'ses_parent1' }, messages: MESSAGES };
    const kept = archivedChatOf(exported, { directory: '/data/spaces/archive/a1b2c3d4e5f6', archivedAt: 99, keepParent: true });
    expect(kept).toEqual({
      info: {
        id: CHAT,
        parentID: 'ses_parent1',
        projectID: 'p1',
        cost: 0.5,
        tokens: INFO.tokens,
        outcome: 'failed',
        time: { created: 10, updated: 20, idle: 15, archived: 99 },
        title: 'Fix the greeting',
        location: { directory: '/data/spaces/archive/a1b2c3d4e5f6' },
        permissions: [{ action: '*', resource: '*', effect: 'deny' }],
      },
      messages: MESSAGES,
      location: { directory: '/data/spaces/archive/a1b2c3d4e5f6' },
    });
    expect(archivedChatOf(exported, { directory: '/d', archivedAt: 99, keepParent: false }).info).not.toHaveProperty('parentID');
  });
});
