import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import express from 'express';
import { registerHarnessRoutes } from './routes.js';
import { createHarnessRouter } from './router.js';
import {
  configureSessionBindings,
  resetSessionBindings,
  getSessionBinding,
} from './session-bindings.js';
import {
  createCanUseTool,
  resetPendingPermissions,
} from './translators/claude-code/permissions.js';

beforeAll(() => {
  configureSessionBindings({ persist: false, load: true });
});

afterEach(() => {
  resetSessionBindings();
  resetPendingPermissions();
  configureSessionBindings({ persist: false, load: true });
});

async function withServer(register, run) {
  const app = express();
  register(app);
  const server = app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not start');
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
  }
}

describe('harness routes', () => {
  it('lists engines and returns 404 for unknown harness', async () => {
    await withServer((app) => {
      registerHarnessRoutes(app, {
        initBindings: false,
        detectAll: async () => ([
          { engine: { id: 'opencode' }, status: 'ready', sections: [] },
          { engine: { id: 'claude-code' }, status: 'missing-cli', sections: [] },
        ]),
        detectOne: async (id) => {
          if (id === 'claude-code') {
            return { engine: { id: 'claude-code' }, status: 'missing-cli', sections: [] };
          }
          return null;
        },
      });
    }, async (base) => {
      const list = await fetch(`${base}/api/harness`);
      expect(list.status).toBe(200);
      const body = await list.json();
      expect(body.engines).toHaveLength(2);
      expect(body.engines[1].status).toBe('missing-cli');

      const missing = await fetch(`${base}/api/harness/nope`);
      expect(missing.status).toBe(404);

      const detect = await fetch(`${base}/api/harness/claude-code/detect`, { method: 'POST' });
      expect(detect.status).toBe(200);
      expect((await detect.json()).status).toBe('missing-cli');
    });
  });

  it('prompts with a mocked translator and keeps binding sticky', async () => {
    const broadcasts = [];
    const router = createHarnessRouter({
      getBroadcast: () => (payload, options) => {
        broadcasts.push({ payload, options });
      },
      claudeTranslator: {
        async prompt(body) {
          const { bindSession } = await import('./session-bindings.js');
          bindSession({
            sessionId: body.sessionId,
            harnessId: 'claude-code',
            directory: body.directory,
            target: body.target,
          });
          return {
            ok: true,
            sessionId: body.sessionId,
            harnessId: 'claude-code',
            messageId: body.messageId || 'msg_user',
            assistantMessageId: body.assistantMessageId || 'msg_assistant',
            status: 'started',
          };
        },
        async abort(body) {
          return { ok: true, sessionId: body.sessionId, aborted: false, reason: 'no-active-turn' };
        },
        async replyPermission() {
          return { ok: true };
        },
      },
    });

    await withServer((app) => {
      registerHarnessRoutes(app, { router, initBindings: false });
    }, async (base) => {
      const response = await fetch(`${base}/api/harness/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'ses_test',
          directory: '/tmp/project',
          target: { harnessId: 'claude-code', modelRef: 'sonnet' },
          text: 'hello',
        }),
      });
      expect(response.status).toBe(202);
      const json = await response.json();
      expect(json.ok).toBe(true);
      expect(getSessionBinding('ses_test')?.harnessId).toBe('claude-code');

      const bindingRes = await fetch(`${base}/api/harness/sessions/ses_test`);
      expect(bindingRes.status).toBe(200);
      expect((await bindingRes.json()).binding.harnessId).toBe('claude-code');

      const abortRes = await fetch(`${base}/api/harness/abort`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'ses_test' }),
      });
      expect(abortRes.status).toBe(200);
      expect((await abortRes.json()).ok).toBe(true);
    });
  });

  it('rejects prompt validation errors from the router', async () => {
    const router = createHarnessRouter({
      claudeTranslator: {
        async prompt() {
          const error = new Error('Claude Code is not ready (missing-cli)');
          error.code = 'CLAUDE_MISSING_CLI';
          error.statusCode = 503;
          error.status = 'missing-cli';
          throw error;
        },
        async abort() {
          return { ok: true, aborted: false };
        },
        async replyPermission() {
          return { ok: true };
        },
      },
    });

    await withServer((app) => {
      registerHarnessRoutes(app, { router, initBindings: false });
    }, async (base) => {
      const response = await fetch(`${base}/api/harness/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'ses_x',
          directory: '/tmp/project',
          target: { harnessId: 'claude-code' },
          text: 'hi',
        }),
      });
      expect(response.status).toBe(503);
      const json = await response.json();
      expect(json.code).toBe('CLAUDE_MISSING_CLI');
    });
  });

  it('permission reply route resolves bridged canUseTool', async () => {
    const events = [];
    createCanUseTool({
      sessionId: 'ses_perm',
      directory: '/tmp/project',
      getBroadcast: () => (payload) => events.push(payload),
      createId: () => 'perm_route',
      timeoutMs: 5_000,
    })('Bash', { command: 'echo route' }, {});

    const router = createHarnessRouter({
      claudeTranslator: {
        async prompt() {
          return { ok: true };
        },
        async abort() {
          return { ok: true, aborted: false };
        },
        async replyPermission(body) {
          const { replyPermission } = await import('./translators/claude-code/permissions.js');
          return replyPermission(body);
        },
      },
    });

    await withServer((app) => {
      registerHarnessRoutes(app, { router, initBindings: false });
    }, async (base) => {
      const response = await fetch(`${base}/api/harness/permission/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'ses_perm',
          requestId: 'perm_route',
          reply: 'once',
          directory: '/tmp/project',
        }),
      });
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json).toMatchObject({
        ok: true,
        sessionId: 'ses_perm',
        requestId: 'perm_route',
        reply: 'once',
      });
      expect(events.some((event) => event.type === 'permission.replied')).toBe(true);
    });
  });
});

describe('OpenCode overlay proxy', () => {
  const registerWithUpstream = (app, upstream) => {
    registerHarnessRoutes(app, {
      initBindings: false,
      detectAll: async () => [],
      detectOne: async () => null,
      buildOpenCodeUrl: (path) => `http://127.0.0.1:1/${path.replace(/^\//, '')}`,
      getOpenCodeAuthHeaders: () => ({}),
      ...upstream,
    });
    // Generic proxy stand-in so `next()` fallthrough is observable.
    app.use((_req, res) => res.status(599).json({ fellThrough: true }));
  };

  // Only the upstream OpenCode host is stubbed; the test's own client calls to
  // the local express server must still go out for real.
  const UPSTREAM_HOST = '127.0.0.1:1';
  const withStubbedFetch = async (impl, run) => {
    const original = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : String(input?.url ?? input);
      if (url.includes(UPSTREAM_HOST)) return impl(input, init);
      return original(input, init);
    };
    try {
      await run();
    } finally {
      globalThis.fetch = original;
    }
  };

  it('overlays harness busy status onto an OK upstream response', async () => {
    await withServer((app) => registerWithUpstream(app), async (base) => {
      await withStubbedFetch(
        async () => new Response(JSON.stringify({ ses_oc: { type: 'busy' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
        async () => {
          const res = await fetch(`${base}/api/session/status?directory=/proj`);
          expect(res.status).toBe(200);
          expect(await res.json()).toMatchObject({ ses_oc: { type: 'busy' } });
        },
      );
    });
  });

  it('falls through to the generic proxy when upstream is not ok', async () => {
    await withServer((app) => registerWithUpstream(app), async (base) => {
      await withStubbedFetch(
        async () => new Response('nope', { status: 502 }),
        async () => {
          const res = await fetch(`${base}/api/session/status?directory=/proj`);
          expect(res.status).toBe(599);
        },
      );
    });
  });

  it('falls through when the upstream fetch throws', async () => {
    await withServer((app) => registerWithUpstream(app), async (base) => {
      await withStubbedFetch(
        async () => { throw new Error('connection refused'); },
        async () => {
          const res = await fetch(`${base}/api/session/ses_1/message`);
          expect(res.status).toBe(599);
        },
      );
    });
  });

  it('falls through when upstream returns unparseable JSON', async () => {
    await withServer((app) => registerWithUpstream(app), async (base) => {
      await withStubbedFetch(
        async () => new Response('<html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
        async () => {
          const res = await fetch(`${base}/api/session/ses_1/message`);
          expect(res.status).toBe(599);
        },
      );
    });
  });
});

describe('harness Claude import routes', () => {
  it('lists candidates and imports selected sessions', async () => {
    await withServer((app) => {
      registerHarnessRoutes(app, {
        initBindings: false,
        listClaudeImportCandidates: async () => ({
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
        }),
        importClaudeSessions: async ({ sessions }) => ({
          results: sessions.map((session) => ({
            ok: true,
            foreignSessionId: session.foreignSessionId,
            sessionId: 'ses_imported',
            directory: session.directory,
            status: 'imported',
          })),
          summary: { imported: sessions.length, skipped: 0, failed: 0 },
        }),
      });
    }, async (base) => {
      const list = await fetch(`${base}/api/harness/claude-code/import/candidates`);
      expect(list.status).toBe(200);
      const listed = await list.json();
      expect(listed.projects).toHaveLength(1);

      const imported = await fetch(`${base}/api/harness/claude-code/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessions: [{
            foreignSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            directory: '/tmp/app',
            title: 'Hello',
          }],
        }),
      });
      expect(imported.status).toBe(200);
      const body = await imported.json();
      expect(body.summary.imported).toBe(1);
      expect(body.results[0].sessionId).toBe('ses_imported');
    });
  });

  it('rejects import without sessions array', async () => {
    await withServer((app) => {
      registerHarnessRoutes(app, { initBindings: false });
    }, async (base) => {
      const res = await fetch(`${base}/api/harness/claude-code/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe('IMPORT_INVALID');
    });
  });
});
