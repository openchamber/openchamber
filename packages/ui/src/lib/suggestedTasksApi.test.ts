import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { fetchProjectMcpTools, fetchSuggestedTasksSettings, fetchSuggestionInbox, handSuggestionToBot, saveSuggestedTasksConfig } from './suggestedTasksApi';
import { inbox, settings, suggestion } from './test-utils/suggestedTasks.fixture';

const previousFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = previousFetch; });
const answer = (response: Response) => {
  globalThis.fetch = Object.assign(async () => response.clone(), previousFetch);
};

describe('lens API contracts', () => {
  test('supplies safe defaults when a saved lens predates tool and permission settings', async () => {
    // Given an older config with neither new field.
    const document = settings();
    const lens = document.config.lenses[0];
    if (!lens) throw new Error('Missing lens');
    const { mcp: _mcp, permissionMode: _mode, ...legacy } = lens;
    answer(Response.json({ ...document, config: { ...document.config, lenses: [legacy] } }));

    // When settings are loaded.
    const loaded = await fetchSuggestedTasksSettings('app');

    // Then the editor receives explicit defaults.
    expect(loaded.config.lenses[0]?.mcp).toEqual([]);
    expect(loaded.config.lenses[0]?.permissionMode).toBe('default');
  });

  test('roundtrips per-tool effects and automatic-session mode through a settings write', async () => {
    // Given distinct tool effects, including a tool no longer in the catalog.
    const document = settings();
    document.config.lenses = document.config.lenses.map((lens) => ({ ...lens, permissionMode: 'auto', mcp: [
      { server: 'jira', tools: { search: 'allow', comment: 'ask', delete: 'deny', old_tool: 'ask' } },
    ] }));
    const bodySchema = z.object({ config: z.unknown() });
    let written: unknown;
    globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
      written = bodySchema.parse(JSON.parse(String(init?.body))).config;
      return Response.json({ ...document, config: written });
    }, previousFetch);

    // When the edited config is saved and parsed again.
    const saved = await saveSuggestedTasksConfig('app', document.config);

    // Then neither transport nor parsing drops the rules or mode.
    expect(written).toEqual(document.config);
    expect(saved.config).toEqual(document.config);
  });

  test('rejects malformed tool effects instead of granting an empty config', async () => {
    // Given a server response containing an unsupported permission effect.
    const document = settings();
    answer(Response.json({ ...document, config: { ...document.config, lenses: document.config.lenses.map((lens) => ({ ...lens, mcp: [{ server: 'jira', tools: { delete: 'yes' } }] })) } }));

    // When settings load, then malformed permissions are a failed read.
    await expect(fetchSuggestedTasksSettings('app')).rejects.toThrow();
  });

  test('rejects a config exceeding ten MCP servers', async () => {
    // Given a config beyond the persisted server limit.
    const document = settings();
    document.config.lenses = document.config.lenses.map((lens) => ({ ...lens, mcp: Array.from({ length: 11 }, (_, index) => ({ server: `server-${index}`, tools: {} })) }));
    answer(Response.json(document));

    // When settings load, then the invalid contract is rejected.
    await expect(fetchSuggestedTasksSettings('app')).rejects.toThrow();
  });
});

describe('project MCP catalog', () => {
  for (const status of ['loading', 'ready', 'external'] as const) {
    test(`preserves ${status} as distinct authority when a catalog has no servers`, async () => {
      // Given an explicit catalog status.
      answer(Response.json({ status, servers: [] }));

      // When this project's catalog is read.
      const catalog = await fetchProjectMcpTools('app');

      // Then empty loading and external answers never turn into ready.
      expect(catalog).toEqual({ status, servers: [] });
    });
  }
  test('rejects a failed catalog read', async () => {
    // Given an upstream failure.
    answer(Response.json({ error: 'Unavailable' }, { status: 503 }));

    // When the catalog is read, then it throws instead of publishing empty servers.
    await expect(fetchProjectMcpTools('app')).rejects.toThrow();
  });
});

describe('suggestion evidence', () => {
  test('keeps sources and summaries while discarding an unsafe link', async () => {
    // Given source evidence from a scan, including an unsafe optional URL.
    answer(Response.json(inbox([suggestion({ evidence: [
      { source: 'APP-42', summary: 'Reproduction attached.', url: 'https://jira.example/APP-42' },
      { source: 'Audit', summary: 'Unsafe link stays plain text.', url: 'javascript:alert(1)' },
    ] })])));

    // When the inbox is parsed.
    const loaded = await fetchSuggestionInbox('app');

    // Then useful evidence survives and only safe links become clickable.
    expect(loaded.suggestions[0]?.evidence).toEqual([
      { source: 'APP-42', summary: 'Reproduction attached.', url: 'https://jira.example/APP-42' },
      { source: 'Audit', summary: 'Unsafe link stays plain text.', url: undefined },
    ]);
  });
});

describe('suggestion bot handoff', () => {
  test('sends the source approval request and retains the bot item and evidence from its envelope', async () => {
    // Given a server-owned conversion of an evidence-bearing suggestion.
    const evidence = [{ source: 'APP-42', summary: 'Reproduction attached.', url: 'https://jira.example/APP-42' }];
    let sent: unknown;
    let path = '';
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      path = String(input);
      sent = JSON.parse(String(init?.body));
      return Response.json({ suggestion: { ...suggestion({ id: 'suggestion/b', evidence, status: 'approved' }), conversion: { kind: 'bot', botId: 'bot-2', itemId: 'item-7' } } });
    }, previousFetch);

    // When the suggestion is handed to the selected bot.
    const converted = await handSuggestionToBot('project/a', 'suggestion/b', 'bot-2');

    // Then the existing approval route owns the transaction and its parsed result keeps the evidence.
    expect(path.endsWith('/api/projects/project%2Fa/suggested-tasks/items/suggestion%2Fb/approve')).toBe(true);
    expect(sent).toEqual({ action: 'bot', botId: 'bot-2' });
    expect(converted.conversion).toMatchObject({ kind: 'bot', botId: 'bot-2', itemId: 'item-7' });
    expect(converted.evidence).toEqual(evidence);
  });

  for (const conversion of [
    { kind: 'bot', botId: 'bot-2' },
    { kind: 'bot', botId: 'bot-2', itemId: '' },
    { kind: 'bot', botId: 'other-bot', itemId: 'item-7' },
  ]) {
    test(`rejects an unconfirmed bot destination ${JSON.stringify(conversion)}`, async () => {
      // Given an answer without the exact requested destination.
      answer(Response.json({ suggestion: { ...suggestion({ status: 'approved' }), conversion } }));

      // When approval is requested, then the answer cannot grant successful navigation.
      await expect(handSuggestionToBot('app', 'suggestion-1', 'bot-2')).rejects.toThrow();
    });
  }
});
