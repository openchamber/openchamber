import { describe, expect, test } from 'bun:test';
import type { GuestToolCard, GuestToolContribution, JsonValue } from '@openchamber/sdk';

import { useGuestsStore } from './store.ts';
import {
  GUEST_TOOL_CARD_ROWS_MAX,
  compileGuestToolRules,
  guestToolTableRows,
  matchGuestToolRule,
  readPath,
  renderGuestToolHeader,
  renderGuestToolLinkUrl,
  renderTemplate,
  resolveGuestToolCard,
  resolveGuestToolPresentation,
  safeHttpsAddress,
  stringifyTemplateValue,
} from './tool-presentation.ts';
import type { InstalledGuest } from './types.ts';

const guest = (id: string, tools: GuestToolContribution[], overrides: Partial<InstalledGuest> = {}): InstalledGuest => ({
  id,
  name: id,
  icon: 'window',
  entry: 'panel/index.html',
  capabilities: { requested: [], granted: [] },
  tools,
  ...overrides,
});

describe('matchGuestToolRule', () => {
  const rules = compileGuestToolRules([
    guest('jira', [{ match: 'mcp.jira.*', name: 'Jira' }, { match: 'mcp.jira.search', name: 'Jira search' }]),
    guest('tasks', [{ match: 'mcp.*', name: 'Any MCP' }, { match: 'mcp.jira.search', name: 'Tasks search' }]),
    guest('paused', [{ match: 'mcp.jira.create', name: 'Paused' }], { enabled: false }),
    guest('pending', [{ match: 'mcp.jira.create', name: 'Pending' }], { capabilities: { requested: ['prompt'], granted: [] } }),
  ]);

  test('an exact rule beats a wildcard, and the first extension wins among equals', () => {
    expect(matchGuestToolRule(rules, 'mcp.jira.search')?.name).toBe('Jira search');
    expect(matchGuestToolRule(rules, 'mcp.jira.create')?.name).toBe('Jira');
    expect(matchGuestToolRule(rules, 'mcp.linear.issues')?.name).toBe('Any MCP');
    expect(matchGuestToolRule(rules, 'bash')).toBeNull();
    expect(matchGuestToolRule(rules, 'mcpjira')).toBeNull();
  });

  test('a paused or not fully approved extension contributes nothing', () => {
    expect(rules.map((rule) => rule.guestId)).toEqual(['jira', 'jira', 'tasks', 'tasks']);
    expect(compileGuestToolRules([guest('empty', [])])).toEqual([]);
  });

  test('resolveGuestToolPresentation reads the store and follows a catalog replacement', () => {
    useGuestsStore.setState({ status: 'ready', guests: [], runtimeKey: 'test' });
    expect(resolveGuestToolPresentation('mcp.jira.search')).toBeNull();

    useGuestsStore.getState().replaceCatalog([guest('jira', [{ match: 'mcp.jira.*', icon: 'bug' }])], 'test');
    const first = resolveGuestToolPresentation('mcp.jira.search');
    expect(first?.icon).toBe('bug');
    expect(resolveGuestToolPresentation('mcp.jira.search')).toBe(first);
    expect(resolveGuestToolPresentation('')).toBeNull();

    useGuestsStore.getState().replaceCatalog([], 'test');
    expect(resolveGuestToolPresentation('mcp.jira.search')).toBeNull();
  });
});

describe('readPath', () => {
  const value = { input: { id: 'DEMO-2', items: [{ title: 'first' }], nested: { deep: 0 } }, empty: null };

  test('walks objects and array indexes', () => {
    expect(readPath(value, 'input.id')).toBe('DEMO-2');
    expect(readPath(value, 'input.items.0.title')).toBe('first');
    expect(readPath(value, 'input.nested.deep')).toBe(0);
    expect(readPath(value, '')).toBe(value);
  });

  test('is undefined for a missing step, a non-object step, or a prototype key', () => {
    expect(readPath(value, 'input.missing')).toBeUndefined();
    expect(readPath(value, 'input.id.length')).toBeUndefined();
    expect(readPath(value, 'input.items.x')).toBeUndefined();
    expect(readPath(value, 'input.items.5.title')).toBeUndefined();
    expect(readPath(value, 'empty.x')).toBeUndefined();
    expect(readPath(value, 'constructor')).toBeUndefined();
    expect(readPath(value, '__proto__.polluted')).toBeUndefined();
    expect(readPath('text', 'a')).toBeUndefined();
  });
});

describe('renderTemplate', () => {
  const context = {
    input: { id: 'DEMO-2', count: 3, done: false, tags: ['a', 'b'] },
    output: { total: 12 },
    metadata: undefined,
  };

  test('substitutes the three roots and leaves other braces alone', () => {
    expect(renderTemplate('{input.id} ({output.total})', context)).toBe('DEMO-2 (12)');
    expect(renderTemplate('{input.count}/{input.done}/{input.tags}', context)).toBe('3/false/["a","b"]');
    expect(renderTemplate('{output}', context)).toBe('{"total":12}');
    expect(renderTemplate('{foo.bar} {input.id', context)).toBe('{foo.bar} {input.id');
  });

  test('renders a missing path as an empty string and caps long values', () => {
    expect(renderTemplate('[{metadata.x}] [{input.nope.deeper}]', context)).toBe('[] []');
    const long = renderTemplate('{input.id}', { input: { id: 'x'.repeat(500) }, output: undefined, metadata: undefined });
    expect(long).toHaveLength(200);
    expect(long.endsWith('…')).toBe(true);
    expect(stringifyTemplateValue(null)).toBe('');
    expect(stringifyTemplateValue(1.5)).toBe('1.5');
  });
});

describe('renderGuestToolHeader', () => {
  const rule = compileGuestToolRules([guest('jira', [
    { match: 'x', name: 'Jira', title: '{input.id}', subtitle: '{output.total} results' },
  ])])[0]!;

  test('parses JSON output for the templates and falls back to name for an empty title', () => {
    expect(renderGuestToolHeader(rule, { input: { id: 'J-1' }, output: '{"total": 4}', metadata: undefined }))
      .toEqual({ title: 'J-1', subtitle: '4 results' });
    expect(renderGuestToolHeader(rule, { input: {}, output: 'not json', metadata: undefined }))
      .toEqual({ title: 'Jira', subtitle: 'results' });
    expect(renderGuestToolHeader({ ...rule, name: undefined, title: undefined, subtitle: undefined }, { input: {}, output: undefined, metadata: undefined }))
      .toEqual({ title: null, subtitle: null });
  });
});

describe('guestToolTableRows', () => {
  test('takes the array itself or its items', () => {
    expect(guestToolTableRows([{ id: 1 }])).toEqual([{ id: 1 }]);
    expect(guestToolTableRows({ items: [{ id: 1 }], total: 1 })).toEqual([{ id: 1 }]);
    expect(guestToolTableRows({ rows: [] })).toBeNull();
    expect(guestToolTableRows('text')).toBeNull();
  });
});

describe('resolveGuestToolCard', () => {
  const issueCard: GuestToolCard = {
    label: '{output.key} · {output.type}',
    title: '{output.summary}',
    status: { value: '{output.status.name}', tones: { 'In Progress': 'info', Blocked: 'error', toString: 'warning' as const } },
    fields: [
      { label: 'Assignee', value: '{output.assignee.name}' },
      { label: 'Priority', value: '{output.priority}' },
    ],
    link: { label: 'Open', url: '{output.url}' },
  };
  const ruleFor = (card: GuestToolCard | undefined, toolLinkSettings?: Record<string, string>) => {
    const [rule] = compileGuestToolRules([guest('jira', [{ match: 'jira_get_issue', output: 'card', card }], { toolLinkSettings })]);
    if (!rule) throw new Error('no rule compiled');
    return rule;
  };
  const issue = {
    key: 'DEMO-482',
    type: 'Bug',
    summary: 'Login fails after token refresh',
    status: { name: 'In Progress' },
    assignee: { name: 'Olena K.' },
    priority: 'High',
    url: 'https://tracker.example/browse/DEMO-482',
  };

  test('draws one card from an object, every part from its own template', () => {
    expect(resolveGuestToolCard(ruleFor(issueCard), issue)).toEqual({
      kind: 'card',
      card: {
        label: 'DEMO-482 · Bug',
        title: 'Login fails after token refresh',
        status: { text: 'In Progress', tone: 'info' },
        fields: [{ label: 'Assignee', value: 'Olena K.' }, { label: 'Priority', value: 'High' }],
        link: { label: 'Open', url: 'https://tracker.example/browse/DEMO-482' },
      },
    });
  });

  test('hides a part whose paths are missing, null, blank, an object or an array', () => {
    const result = resolveGuestToolCard(ruleFor(issueCard), {
      key: 'DEMO-1',
      summary: '   ',
      status: { name: null },
      assignee: { name: { first: 'Olena' } },
      priority: ['High'],
    });
    expect(result).toEqual({
      kind: 'card',
      // `type` is missing beside a key that resolved: it renders as nothing, the way it does in a title.
      card: { label: 'DEMO-1 ·', title: null, status: null, fields: [], link: null },
    });
  });

  test('shows numbers and booleans, zero and false included', () => {
    const card: GuestToolCard = { title: '{output.count}', fields: [{ label: 'Done', value: '{output.done}' }] };
    expect(resolveGuestToolCard(ruleFor(card), { count: 0, done: false })).toEqual({
      kind: 'card',
      card: { label: null, title: '0', status: null, fields: [{ label: 'Done', value: 'false' }], link: null },
    });
  });

  test('a status without a mapping is neutral, and a tone key never reads the prototype', () => {
    const tone = (name: string) => {
      const result = resolveGuestToolCard(ruleFor(issueCard), { status: { name } });
      return result?.kind === 'card' ? result.card.status : undefined;
    };
    expect(tone('Blocked')).toEqual({ text: 'Blocked', tone: 'error' });
    expect(tone('To Do')).toEqual({ text: 'To Do', tone: 'neutral' });
    expect(tone('in progress')).toEqual({ text: 'in progress', tone: 'neutral' });
    expect(tone('toString')).toEqual({ text: 'toString', tone: 'warning' });
    expect(tone('constructor')).toEqual({ text: 'constructor', tone: 'neutral' });
    expect(tone('__proto__')).toEqual({ text: '__proto__', tone: 'neutral' });
    const bare = resolveGuestToolCard(ruleFor({ status: { value: '{output.state}' } }), { state: 'Open' });
    expect(bare).toEqual({ kind: 'card', card: { label: null, title: null, status: { text: 'Open', tone: 'neutral' }, fields: [], link: null } });
  });

  test('is null when nothing resolves, so the caller falls back; a link alone is not a card', () => {
    const rule = ruleFor(issueCard);
    expect(resolveGuestToolCard(rule, {})).toBeNull();
    expect(resolveGuestToolCard(rule, { url: 'https://tracker.example/browse/DEMO-482' })).toBeNull();
    expect(resolveGuestToolCard(rule, 'plain text')).toBeNull();
    expect(resolveGuestToolCard(rule, 42)).toBeNull();
    expect(resolveGuestToolCard(rule, null)).toBeNull();
    expect(resolveGuestToolCard(rule, undefined)).toBeNull();
    expect(resolveGuestToolCard(rule, [])).toBeNull();
    expect(resolveGuestToolCard(rule, { items: [] })).toBeNull();
    expect(resolveGuestToolCard(rule, [{ other: 1 }, 'text', null])).toBeNull();
    expect(resolveGuestToolCard(ruleFor(undefined), issue)).toBeNull();
  });

  test('draws a list from an array or an items array, one row per item, without links', () => {
    const second = { key: 'DEMO-477', summary: 'Rate limiter drops webhook retries', status: { name: 'Blocked' }, url: 'https://tracker.example/browse/DEMO-477' };
    const rows = [
      {
        label: 'DEMO-482 · Bug',
        title: 'Login fails after token refresh',
        status: { text: 'In Progress', tone: 'info' },
        fields: [{ label: 'Assignee', value: 'Olena K.' }, { label: 'Priority', value: 'High' }],
        link: null,
      },
      { label: 'DEMO-477 ·', title: 'Rate limiter drops webhook retries', status: { text: 'Blocked', tone: 'error' }, fields: [], link: null },
    ];
    expect(resolveGuestToolCard(ruleFor(issueCard), [issue, second])).toEqual({ kind: 'list', rows, hidden: 0 });
    expect(resolveGuestToolCard(ruleFor(issueCard), { summary: 'two found', items: [issue, second] })).toEqual({ kind: 'list', rows, hidden: 0 });
    // An item no template resolves on leaves no empty row.
    expect(resolveGuestToolCard(ruleFor(issueCard), [issue, { unrelated: true }, 7, second])).toEqual({ kind: 'list', rows, hidden: 0 });
  });

  test('caps a list and counts the rest', () => {
    const items = Array.from({ length: GUEST_TOOL_CARD_ROWS_MAX + 25 }, (_unused, index) => ({ key: `DEMO-${index}` }));
    const result = resolveGuestToolCard(ruleFor({ label: '{output.key}' }), items);
    expect(result?.kind).toBe('list');
    if (result?.kind !== 'list') return;
    expect(result.rows).toHaveLength(GUEST_TOOL_CARD_ROWS_MAX);
    expect(result.rows.at(-1)?.label).toBe(`DEMO-${GUEST_TOOL_CARD_ROWS_MAX - 1}`);
    expect(result.hidden).toBe(25);
  });

  test('caps each value at the template limit', () => {
    const result = resolveGuestToolCard(ruleFor({ title: '{output.text}' }), { text: 'x'.repeat(5000) });
    expect(result?.kind === 'card' ? result.card.title?.length : null).toBe(200);
  });

  test('the link reads the guest settings the catalog row carries', () => {
    const card: GuestToolCard = { label: '{output.key}', link: { label: 'Open', url: 'https://{settings.site}/browse/{output.key}' } };
    const linkOf = (settings?: Record<string, string>) => {
      const result = resolveGuestToolCard(ruleFor(card, settings), { key: 'DEMO-482' });
      return result?.kind === 'card' ? result.card.link : undefined;
    };
    expect(linkOf({ site: 'acme.example' })).toEqual({ label: 'Open', url: 'https://acme.example/browse/DEMO-482' });
    expect(linkOf({ other: 'acme.example' })).toBeNull();
    expect(linkOf()).toBeNull();
  });
});

describe('safeHttpsAddress', () => {
  test('admits only an https address without credentials, as the parser wrote it', () => {
    expect(safeHttpsAddress('https://tracker.example/browse/DEMO-482?focus=1#c2')).toBe('https://tracker.example/browse/DEMO-482?focus=1#c2');
    expect(safeHttpsAddress('HTTPS://Tracker.Example')).toBe('https://tracker.example/');
    expect(safeHttpsAddress('https://tracker.example:8443/a')).toBe('https://tracker.example:8443/a');
    for (const address of [
      'http://tracker.example/a',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'openchamber://settings',
      '//tracker.example/a',
      '/browse/DEMO-482',
      'tracker.example/browse/DEMO-482',
      'https://user@tracker.example/a',
      'https://user:secret@tracker.example/a',
      'https://:secret@tracker.example/a',
      'https://',
      '',
    ]) {
      expect(safeHttpsAddress(address)).toBeNull();
    }
    // The parser drops what a browser would drop, and the answer is what it kept.
    expect(safeHttpsAddress(' https://tracker.example/a\n?b=1 ')).toBe('https://tracker.example/a?b=1');
    expect(safeHttpsAddress(`https://tracker.example/${'a'.repeat(2048)}`)).toBeNull();
  });
});

describe('renderGuestToolLinkUrl', () => {
  const link = (template: string, output: JsonValue | undefined, settings: Record<string, string> = {}) => (
    // The output is whatever a tool answered; the reader takes any JSON.
    renderGuestToolLinkUrl(template, { output: JSON.parse(JSON.stringify(output ?? null)), settings })
  );

  test('a template that is one placeholder takes the output address as it is', () => {
    expect(link('{output.url}', { url: 'https://tracker.example/browse/DEMO-482?a=1&b=2#c' })).toBe('https://tracker.example/browse/DEMO-482?a=1&b=2#c');
    expect(link('{output.links.self}', { links: { self: '  https://tracker.example/x  ' } })).toBe('https://tracker.example/x');
    expect(link('{output}', 'https://tracker.example/x')).toBe('https://tracker.example/x');
    expect(link('{output.url}', { url: 'http://tracker.example/x' })).toBeNull();
    expect(link('{output.url}', { url: 'javascript:alert(1)' })).toBeNull();
    expect(link('{output.url}', { url: '/browse/DEMO-482' })).toBeNull();
    expect(link('{output.url}', { url: 'https://user:secret@tracker.example/x' })).toBeNull();
    expect(link('{output.url}', { url: 42 })).toBeNull();
    expect(link('{output.url}', { url: { href: 'https://tracker.example/x' } })).toBeNull();
    expect(link('{output.url}', { url: ['https://tracker.example/x'] })).toBeNull();
    expect(link('{output.url}', {})).toBeNull();
    // A setting is never a whole address: the manifest writes the scheme.
    expect(link('{settings.site}', {}, { site: 'https://tracker.example' })).toBeNull();
  });

  test('a composed address percent-encodes each value, so a value stays where it was written', () => {
    const template = 'https://tracker.example/browse/{output.key}?from={output.source}';
    expect(link(template, { key: 'DEMO-482', source: 'chat' })).toBe('https://tracker.example/browse/DEMO-482?from=chat');
    expect(link(template, { key: 482, source: true })).toBe('https://tracker.example/browse/482?from=true');
    expect(link(template, { key: 'a/b?c#d@e', source: 'x&admin=1' })).toBe('https://tracker.example/browse/a%2Fb%3Fc%23d%40e?from=x%26admin%3D1');
    expect(link(template, { key: 'https://evil.example/x', source: 'chat' })).toBe('https://tracker.example/browse/https%3A%2F%2Fevil.example%2Fx?from=chat');
    expect(link(template, { key: ' DEMO-482 ', source: 'a b' })).toBe('https://tracker.example/browse/DEMO-482?from=a%20b');
    expect(link(template, { key: 'Задача', source: 'chat' })).toBe('https://tracker.example/browse/%D0%97%D0%B0%D0%B4%D0%B0%D1%87%D0%B0?from=chat');
  });

  test('a value cannot walk the path', () => {
    const template = 'https://tracker.example/projects/{output.project}/issues/{output.key}';
    expect(link(template, { project: '..', key: 'DEMO-1' })).toBeNull();
    expect(link(template, { project: '.', key: 'DEMO-1' })).toBeNull();
    expect(link(template, { project: 'web', key: '..' })).toBeNull();
    expect(link('https://tracker.example/a/{output.one}{output.two}/b', { one: '.', two: '.' })).toBeNull();
    // Encoded, a slash or an encoded dot is part of the step, not a step of its own.
    expect(link(template, { project: '../..', key: 'DEMO-1' })).toBe('https://tracker.example/projects/..%2F../issues/DEMO-1');
    expect(link(template, { project: '%2e%2e', key: 'DEMO-1' })).toBe('https://tracker.example/projects/%252e%252e/issues/DEMO-1');
    expect(link(template, { project: '..web', key: 'DEMO-1' })).toBe('https://tracker.example/projects/..web/issues/DEMO-1');
    // A dot step in the query is text.
    expect(link('https://tracker.example/search?q={output.q}', { q: '..' })).toBe('https://tracker.example/search?q=..');
  });

  test('every placeholder has to resolve', () => {
    const template = 'https://tracker.example/browse/{output.key}?from={output.source}';
    expect(link(template, { key: 'DEMO-482' })).toBeNull();
    expect(link(template, { key: 'DEMO-482', source: '  ' })).toBeNull();
    expect(link(template, { key: 'DEMO-482', source: null })).toBeNull();
    expect(link(template, { key: { id: 1 }, source: 'chat' })).toBeNull();
    expect(link(template, { key: 'DEMO-482', source: '\ud800' })).toBeNull();
    expect(link('https://tracker.example/static', {})).toBeNull();
  });

  test('a setting fills a host label, a path step or a query value', () => {
    const template = 'https://{settings.site}/browse/{output.key}';
    expect(link(template, { key: 'DEMO-482' }, { site: 'acme.example' })).toBe('https://acme.example/browse/DEMO-482');
    expect(link('https://{settings.workspace}.tracker.example/{output.key}', { key: 'DEMO-482' }, { workspace: 'acme' })).toBe('https://acme.tracker.example/DEMO-482');
    expect(link('https://tracker.example/{settings.org}/{output.key}', { key: 'DEMO-482' }, { org: 'acme inc' })).toBe('https://tracker.example/acme%20inc/DEMO-482');
    // No value saved, a blank one, or an id only the prototype answers.
    expect(link(template, { key: 'DEMO-482' })).toBeNull();
    expect(link(template, { key: 'DEMO-482' }, { site: '   ' })).toBeNull();
    expect(link('https://{settings.constructor}/{output.key}', { key: 'DEMO-482' })).toBeNull();
  });

  test('a setting that is more than a host name gives no link', () => {
    const template = 'https://{settings.site}/browse/{output.key}';
    const output = { key: 'DEMO-482' };
    expect(link(template, output, { site: 'acme.example:8443' })).toBeNull();
    expect(link(template, output, { site: 'https://acme.example' })).toBeNull();
    expect(link(template, output, { site: 'acme.example/jira' })).toBeNull();
    expect(link(template, output, { site: 'user@acme.example' })).toBeNull();
    expect(link(template, output, { site: 'acme.example#x' })).toBeNull();
    expect(link(template, output, { site: 'acme.example\\evil.example' })).toBeNull();
    expect(link(template, output, { site: 'acme example' })).toBeNull();
  });

  test('never yields anything but an https address without credentials', () => {
    const values = ['evil.example', '@evil.example', 'x:y@evil.example', '//evil.example', '\\\\evil.example', 'javascript:alert(1)', '..', '%2e%2e', '\t', '\n', '?', '#', ':', '[::1]', 'a.b', '%', '%00'];
    const templates = [
      'https://{settings.s}/{output.v}',
      'https://tracker.example{output.v}',
      'https://tracker.example/{output.v}',
      'https://tracker.example:{output.v}/',
      'https://{output.v}@tracker.example/',
      'https://tracker.example/?next={output.v}',
      'https://tracker.example/#{output.v}',
      'https://{output.v}',
    ];
    for (const template of templates) {
      for (const v of values) {
        for (const s of values) {
          const address = link(template, { v }, { s });
          if (address === null) continue;
          const url = new URL(address);
          expect(url.protocol).toBe('https:');
          expect(url.username).toBe('');
          expect(url.password).toBe('');
          // A template that wrote its own host keeps it, whatever the values are.
          if (template.startsWith('https://tracker.example/')) expect(url.host).toBe('tracker.example');
        }
      }
    }
  });
});
