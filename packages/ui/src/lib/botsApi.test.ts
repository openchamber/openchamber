import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { installSuggestedTasksDom, serveSuggestedTasks, deferred } from './test-utils/suggestedTasks.fixture';
import { botItem, botsConfig } from './bots/bots.fixture';
import { actOnBotItem, BotsApiError, fetchBotItem, fetchBots, saveBotsConfig, writeBotIdentity } from './botsApi';
import { getBotsRuntime } from './botsRuntime';
import { switchRuntimeEndpoint } from './runtime-switch';

const dom = installSuggestedTasksDom();
let server: Awaited<ReturnType<typeof serveSuggestedTasks>>;
let handle: (request: Request) => Response | Promise<Response>;
beforeEach(async () => {
  getBotsRuntime();
  handle = () => Response.json({ config: botsConfig(), revision: 1, items: [botItem()], presets: [] });
  server = await serveSuggestedTasks((request) => handle(request));
});
afterEach(async () => server.stop(true));
afterAll(async () => dom.restore());

describe('Bots HTTP contract', () => {
  test('keeps read failure distinct from a successful empty project', async () => {
    // Given the actual HTTP boundary refuses the read.
    handle = () => Response.json({ code: 'BOT_REQUEST_FAILED' }, { status: 503 });

    // When the project is read, then failure never becomes an empty snapshot.
    await expect(fetchBots('project-1')).rejects.toBeInstanceOf(BotsApiError);
  });

  test('retains exact captured stage directories when item detail crosses HTTP', async () => {
    // Given stage sessions with distinct captured directories and a different host worktree.
    const sessionDirectories = { ses_read: '/spaces/investigation/project checkout', ses_fix: '/host/fixing-checkout', ses_judge: '/spaces/judge/project' };
    const item = botItem({ worktree: '/host/item-worktree', sessions: { investigation: 'ses_read', fixing: 'ses_fix', judge: 'ses_judge' } });
    handle = () => Response.json({ item, reports: {}, snapshot: null, sessionDirectories });

    // When the detail passes through the real HTTP adapter and parser.
    const detail = await fetchBotItem('project-1', item.id);

    // Then every session retains its own address verbatim.
    expect(detail.sessionDirectories).toEqual(sessionDirectories);
  });

  for (const sessionDirectories of [undefined, {}]) {
    test(`grants no directory authority when item detail has ${sessionDirectories === undefined ? 'no projection' : 'an empty projection'}`, async () => {
      // Given an older or explicitly empty detail response, even with a host worktree.
      handle = () => Response.json({ item: botItem({ worktree: '/host/item-worktree' }), reports: {}, snapshot: null, sessionDirectories });

      // When that detail is parsed.
      const detail = await fetchBotItem('project-1', 'item-1');

      // Then the host worktree never supplies a missing session address.
      expect(detail.sessionDirectories).toEqual({});
    });
  }

  for (const sessionDirectories of [null, [], { ses_read: '' }, { ses_read: 42 }]) {
    test(`rejects malformed captured directories when detail returns ${JSON.stringify(sessionDirectories)}`, async () => {
      // Given an invalid directory projection in a successful HTTP response.
      handle = () => Response.json({ item: botItem(), reports: {}, snapshot: null, sessionDirectories });

      // When detail is requested, then malformed authority fails the read.
      await expect(fetchBotItem('project-1', 'item-1')).rejects.toBeInstanceOf(z.ZodError);
    });
  }

  test('roundtrips stage models, tools and executable argv while withholding machine approvals', async () => {
    // Given distinct stage models, tool rules and execution limits.
    const config = botsConfig();
    config.definitions = config.definitions.map((bot) => ({ ...bot,
      models: { investigation: { useDefaults: false, providerID: 'read', modelID: 'small' }, fixing: { useDefaults: false, providerID: 'write', modelID: 'large', variant: 'high' }, judge: { useDefaults: true } },
      mcp: [{ server: 'jira', tools: { search: 'allow', comment: 'ask' } }], correctionMcp: [{ server: 'jira', tools: { comment: 'deny' } }],
      proof: { command: 'bun', args: ['test', '{files}', 'a file.ts'] }, goalTokenBudget: 54321,
    }));
    let written: z.infer<typeof bodySchema> | null = null;
    const bodySchema = z.object({ config: z.json() });
    handle = async (request) => { written = bodySchema.parse(await request.json()); return Response.json(written); };

    // When an edit carrying a server-only approval is submitted.
    const result = await saveBotsConfig('project-1', { ...config, ...{ approvals: { policy: 'forged' } } });

    // Then the boundary preserves editable data and strips machine authority.
    expect(written).toEqual({ config });
    expect(result.config).toEqual(config);
  });

  test('submits identity secrets only in an explicit write and strips them from its public result', async () => {
    // Given a user-provided service identity and a secret-bearing server response.
    const input = { kind: 'jira-service', label: 'Team', site: 'https://jira.example', email: 'team@example.com', apiToken: 'test-secret' } as const;
    let body: z.infer<typeof jsonSchema> | null = null;
    const jsonSchema = z.json();
    handle = async (request) => { body = jsonSchema.parse(await request.json()); return Response.json({ identity: { id: 'identity-1', revision: 1, configured: true, ...input } }); };

    // When the explicit creation operation runs.
    const result = await writeBotIdentity('project-1', input);

    // Then POST matches the server contract and no secret enters the typed UI result.
    expect(body).toEqual(input);
    expect(Object.hasOwn(result.identity, 'apiToken')).toBe(false);
  });

  test('preserves the human answer deduplication ID on the wire', async () => {
    // Given an answer that may be retried after a lost response.
    const reply = { kind: 'answer', text: 'Use the existing API', eventId: 'reply-1' } as const;
    let body: z.infer<typeof bodySchema> | null = null;
    const bodySchema = z.object({ text: z.string(), eventId: z.string() }).strict();
    handle = async (request) => { body = bodySchema.parse(await request.json()); return Response.json({ ok: true }); };

    // When the answer is submitted.
    await actOnBotItem('project-1', 'item-1', reply);

    // Then the server receives the original stable event identity.
    expect(body).toEqual({ text: reply.text, eventId: reply.eventId });
  });

  test('rejects a completed response from a runtime that was left and revisited', async () => {
    // Given an in-flight request at A, with a response held until A has been left.
    const started = deferred<void>();
    const response = deferred<Response>();
    handle = () => { started.resolve(); return response.promise; };
    const outcome = fetchBots('project-1').then(() => 'accepted', () => 'rejected');
    await started.promise;

    // When another server becomes the runtime before the old response completes.
    const next = await serveSuggestedTasks(() => Response.json({}));
    switchRuntimeEndpoint({ apiBaseUrl: server.url.origin, runtimeKey: `test-${server.port}` });
    response.resolve(Response.json({ config: botsConfig(), revision: 1, items: [], presets: [] }));

    // Then that response has no authority in the replacement visit.
    expect(await outcome).toBe('rejected');
    await next.stop(true);
  });
});
