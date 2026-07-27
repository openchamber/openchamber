import { beforeEach, describe, expect, mock, test } from 'bun:test';

const runtimeFetchMock = mock(async () => new Response('{}'));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: runtimeFetchMock,
}));

const {
  buildHarnessPromptBody,
  harnessAbort,
  harnessPermissionReply,
  harnessPrompt,
  listClaudeImportCandidates,
  importClaudeSessions,
  HarnessClientError,
} = await import(`./client?cache-test=${Date.now()}`);

beforeEach(() => {
  runtimeFetchMock.mockReset();
  runtimeFetchMock.mockImplementation(async () => new Response(JSON.stringify({ ok: true, status: 'started' }), {
    status: 202,
    headers: { 'Content-Type': 'application/json' },
  }));
});

describe('buildHarnessPromptBody', () => {
  test('shapes prompt body with files and messageId', () => {
    const body = buildHarnessPromptBody({
      sessionId: 'ses_1',
      directory: '/project',
      target: { harnessId: 'claude-code', modelRef: 'sonnet', permissionMode: 'default' },
      text: 'hello',
      files: [{ mime: 'image/png', url: 'data:image/png;base64,abc', filename: 'a.png' }],
      messageId: 'msg_1',
    });

    expect(body).toEqual({
      sessionId: 'ses_1',
      directory: '/project',
      target: { harnessId: 'claude-code', modelRef: 'sonnet', permissionMode: 'default' },
      text: 'hello',
      files: [{ mime: 'image/png', url: 'data:image/png;base64,abc', filename: 'a.png' }],
      messageId: 'msg_1',
    });
  });

  test('includes seedFromSessionId for handoff prompts', () => {
    const body = buildHarnessPromptBody({
      sessionId: 'ses_new',
      directory: '/project',
      target: { harnessId: 'claude-code', modelRef: 'sonnet' },
      text: 'hello',
      seedFromSessionId: 'ses_source',
    });
    expect(body.seedFromSessionId).toBe('ses_source');
  });

  test('rejects opencode targets', () => {
    expect(() => buildHarnessPromptBody({
      sessionId: 'ses_1',
      directory: '/project',
      target: { harnessId: 'opencode', providerId: 'anthropic', modelId: 'claude' },
      text: 'hi',
    })).toThrow(HarnessClientError);
  });
});

describe('harnessPrompt', () => {
  test('posts to /api/harness/prompt via runtimeFetch', async () => {
    await harnessPrompt({
      sessionId: 'ses_1',
      directory: '/project',
      target: { harnessId: 'claude-code', modelRef: 'opus' },
      text: 'ping',
      messageId: 'msg_user',
    });

    expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = runtimeFetchMock.mock.calls[0];
    expect(path).toBe('/api/harness/prompt');
    expect(init.method).toBe('POST');
    const parsed = JSON.parse(String(init.body));
    expect(parsed.sessionId).toBe('ses_1');
    expect(parsed.directory).toBe('/project');
    expect(parsed.target).toEqual({ harnessId: 'claude-code', modelRef: 'opus' });
    expect(parsed.text).toBe('ping');
    expect(parsed.messageId).toBe('msg_user');
    expect(Object.prototype.hasOwnProperty.call(parsed, 'token')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(parsed, 'authorization')).toBe(false);
  });

  test('throws typed HarnessClientError on non-OK response', async () => {
    runtimeFetchMock.mockImplementation(async () => new Response(JSON.stringify({
      error: 'Claude Code is not ready',
      code: 'CLAUDE_NOT_READY',
      status: 'needs-login',
    }), { status: 503 }));

    let caught = null;
    try {
      await harnessPrompt({
        sessionId: 'ses_1',
        directory: '/project',
        target: { harnessId: 'claude-code', modelRef: 'sonnet' },
        text: 'hi',
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(HarnessClientError);
    expect(caught.code).toBe('CLAUDE_NOT_READY');
    expect(caught.statusCode).toBe(503);
    expect(caught.status).toBe('needs-login');
  });
});

describe('harnessAbort', () => {
  test('posts sessionId to /api/harness/abort', async () => {
    runtimeFetchMock.mockImplementation(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await harnessAbort({ sessionId: 'ses_1', directory: '/project' });
    const [path, init] = runtimeFetchMock.mock.calls[0];
    expect(path).toBe('/api/harness/abort');
    expect(JSON.parse(String(init.body))).toEqual({ sessionId: 'ses_1', directory: '/project' });
  });
});

describe('harnessPermissionReply', () => {
  test('posts to /api/harness/permission/reply via runtimeFetch', async () => {
    runtimeFetchMock.mockImplementation(async () => new Response(JSON.stringify({
      ok: true,
      sessionId: 'ses_1',
      requestId: 'perm_1',
      reply: 'once',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const result = await harnessPermissionReply({
      sessionId: 'ses_1',
      requestId: 'perm_1',
      reply: 'once',
      directory: '/project',
    });

    expect(result).toEqual({
      ok: true,
      sessionId: 'ses_1',
      requestId: 'perm_1',
      reply: 'once',
    });
    const [path, init] = runtimeFetchMock.mock.calls[0];
    expect(path).toBe('/api/harness/permission/reply');
    expect(JSON.parse(String(init.body))).toEqual({
      sessionId: 'ses_1',
      requestId: 'perm_1',
      reply: 'once',
      directory: '/project',
    });
  });
});

describe('claude import client', () => {
  test('lists candidates via runtimeFetch', async () => {
    runtimeFetchMock.mockImplementation(async () => new Response(JSON.stringify({
      configDir: '/tmp/.claude',
      projectsRoot: '/tmp/.claude/projects',
      projects: [{
        projectKey: '-tmp-app',
        directory: '/tmp/app',
        directoryMissing: false,
        sessionCount: 1,
        sessions: [{
          foreignSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          title: 'Hello',
          directory: '/tmp/app',
          updatedAt: 1,
          alreadyImported: false,
          directoryMissing: false,
        }],
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const result = await listClaudeImportCandidates();
    expect(runtimeFetchMock.mock.calls[0][0]).toBe('/api/harness/claude-code/import/candidates');
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].sessions[0].foreignSessionId).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  });

  test('posts selected sessions for import', async () => {
    runtimeFetchMock.mockImplementation(async () => new Response(JSON.stringify({
      results: [{
        ok: true,
        foreignSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        sessionId: 'ses_1',
        directory: '/tmp/app',
        status: 'imported',
      }],
      summary: { imported: 1, skipped: 0, failed: 0 },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const result = await importClaudeSessions([{
      foreignSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      directory: '/tmp/app',
      title: 'Hello',
    }]);

    expect(runtimeFetchMock.mock.calls[0][0]).toBe('/api/harness/claude-code/import');
    expect(result.summary.imported).toBe(1);
    expect(result.results[0].sessionId).toBe('ses_1');
  });
});
