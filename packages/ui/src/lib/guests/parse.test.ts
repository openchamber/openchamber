import { describe, expect, test } from 'bun:test';
import type { JsonValue } from '@openchamber/sdk';

import { browserProviderGuests } from './browser-providers.ts';
import { parseGuestCatalogJson, parseInstalledGuestJson } from './parse.ts';
import { mayGuestShowOnPhone } from './phone.ts';
import { enabledGuestSurfaces } from './surfaces.ts';

/** The readable rows, or null when any row was not readable. */
const readGuests = (json: string) => {
  const catalog = parseGuestCatalogJson(json);
  return catalog && catalog.unreadable.length === 0 ? catalog.guests : null;
};

describe('parseGuestCatalogJson', () => {
  test('a block keeps whether its frame answers', () => {
    const block = { name: 'Card', description: 'Asks', args: ['title'], entry: 'card.html', answers: true };
    const guest = { id: 'hello', name: 'Hello', icon: 'window', capabilities: { requested: [], granted: [] }, source: 'path', blocks: [block] };
    expect(readGuests(JSON.stringify({ guests: [guest] }))?.[0]?.blocks?.[0]?.answers).toBe(true);
  });

  test('a row keeps its phone opt-in, and the phone shows only what opted in', () => {
    const guest = { id: 'hello', name: 'Hello', icon: 'window', entry: 'index.html', pageEntry: 'page.html', capabilities: { requested: [], granted: [] }, source: 'path' };
    const [optedIn, plain, odd] = readGuests(JSON.stringify({ guests: [
      { ...guest, entryMobile: true, pageMobile: true },
      guest,
      { ...guest, id: 'odd', entryMobile: 'yes' },
    ] })) ?? [];
    expect(optedIn && [mayGuestShowOnPhone(optedIn, 'panel'), mayGuestShowOnPhone(optedIn, 'page')]).toEqual([true, true]);
    expect(plain && [mayGuestShowOnPhone(plain, 'panel'), mayGuestShowOnPhone(plain, 'page')]).toEqual([false, false]);
    // A value it cannot read drops the opt-in, never the row.
    expect(odd?.id).toBe('odd');
    expect(odd?.entryMobile).toBeUndefined();
  });

  test('a row keeps its provider logos, and logos it cannot read cost only themselves', () => {
    const guest = { id: 'hello', name: 'Hello', icon: 'window', capabilities: { requested: [], granted: [] }, source: 'path' };
    expect(readGuests(JSON.stringify({ guests: [{ ...guest, providerLogos: { acme: 'logos/acme.svg' } }] }))?.[0]?.providerLogos)
      .toEqual({ acme: 'logos/acme.svg' });

    const unreadable = readGuests(JSON.stringify({ guests: [{ ...guest, providerLogos: { acme: '../acme.svg' } }] }))?.[0];
    expect(unreadable?.id).toBe('hello');
    expect(unreadable?.providerLogos).toBeUndefined();
  });

  test('one row it cannot read keeps the others and is listed by name', () => {
    const valid = {
      id: 'hello',
      name: 'Hello',
      icon: 'window',
      capabilities: { requested: [], granted: [] },
      source: 'path',
    };
    // A newer server can send a capability this build does not know.
    const newer = { ...valid, id: 'engram-memory', name: 'Engram', capabilities: { requested: ['telepathy'], granted: [] } };
    expect(parseGuestCatalogJson(JSON.stringify({
      guests: [valid, newer, { id: 'Not An Id', icon: 7, source: 'bundled' }, 'junk'],
    }))).toEqual({
      guests: [valid],
      unreadable: [
        { id: 'engram-memory', name: 'Engram', builtIn: false },
        { id: null, name: null, builtIn: true },
        { id: null, name: null, builtIn: false },
      ],
      opencodePlugins: null,
    });
  });

  test('a response without a guest list is still a failure', () => {
    expect(parseGuestCatalogJson('<html>Fallback</html>')).toBeNull();
    expect(parseGuestCatalogJson(JSON.stringify({ guests: {} }))).toBeNull();
  });

  test('reads a valid catalog', () => {
    expect(readGuests(JSON.stringify({
      guests: [{
        id: 'hello',
        name: 'Hello',
        icon: 'window',
        entry: 'panel/index.html',
        capabilities: { requested: [], granted: [] },
        version: '1.0.0',
        source: 'path',
        path: '/tmp/hello',
      }, {
        id: 'zip-hello',
        name: 'Zip',
        icon: 'window',
        entry: 'panel/index.html',
        capabilities: { requested: [], granted: [] },
        source: 'zip',
        path: '/data/guests/zip-hello',
      }, {
        id: 'git-hello',
        name: 'Git',
        icon: 'window',
        entry: 'panel/index.html',
        capabilities: { requested: [], granted: [] },
        source: 'git',
        path: '/data/guests/git-hello',
      }],
    }))).toEqual([
      {
        id: 'hello',
        name: 'Hello',
        icon: 'window',
        entry: 'panel/index.html',
        capabilities: { requested: [], granted: [] },
        version: '1.0.0',
        source: 'path',
        path: '/tmp/hello',
      },
      {
        id: 'zip-hello',
        name: 'Zip',
        icon: 'window',
        entry: 'panel/index.html',
        capabilities: { requested: [], granted: [] },
        source: 'zip',
        path: '/data/guests/zip-hello',
      },
      {
        id: 'git-hello',
        name: 'Git',
        icon: 'window',
        entry: 'panel/index.html',
        capabilities: { requested: [], granted: [] },
        source: 'git',
        path: '/data/guests/git-hello',
      },
    ]);
  });

  test('keeps attach when the catalog sends it', () => {
    expect(readGuests(JSON.stringify({
      guests: [{
        id: 'hello',
        name: 'Hello',
        icon: 'window',
        entry: 'panel/index.html',
        capabilities: { requested: [], granted: [] },
        attach: 'dialog',
      }],
    }))).toEqual([
      {
        id: 'hello',
        name: 'Hello',
        icon: 'window',
        entry: 'panel/index.html',
        capabilities: { requested: [], granted: [] },
        attach: 'dialog',
      },
    ]);
  });

  test('keeps a public integration slice and drops oauth URLs if sent', () => {
    expect(readGuests(JSON.stringify({
      guests: [{
        id: 'clickup',
        name: 'ClickUp',
        icon: 'window',
        entry: 'panel/index.html',
        capabilities: { requested: [], granted: [] },
        integration: {
          name: 'ClickUp',
          description: 'Tasks from a ClickUp list',
          auth: 'token',
          settings: [{ id: 'list-id', label: 'List ID' }],
          oauth: {
            tokenUrl: 'https://api.clickup.com/api/v2/oauth/token',
          },
        },
      }],
    }))).toEqual([
      {
        id: 'clickup',
        name: 'ClickUp',
        icon: 'window',
        entry: 'panel/index.html',
        capabilities: { requested: [], granted: [] },
        integration: {
          name: 'ClickUp',
          description: 'Tasks from a ClickUp list',
          auth: 'token',
          settings: [{ id: 'list-id', label: 'List ID' }],
        },
      },
    ]);
  });

  test('keeps a public service slice', () => {
    expect(readGuests(JSON.stringify({
      guests: [{
        id: 'docker',
        name: 'Docker',
        icon: 'box-3',
        entry: 'panel/index.html',
        capabilities: { requested: [], granted: [] },
        service: {
          runtime: 'host',
          granted: false,
          permissions: {
            sockets: ['docker'],
            exec: ['docker'],
          },
          socketBindings: [{
            id: 'docker',
            candidates: ['/var/run/docker.sock'],
            resolved: '/var/run/docker.sock',
            override: null,
          }],
        },
      }],
    }))).toEqual([
      {
        id: 'docker',
        name: 'Docker',
        icon: 'box-3',
        entry: 'panel/index.html',
        capabilities: { requested: [], granted: [] },
        service: {
          runtime: 'host',
          granted: false,
          permissions: {
            sockets: ['docker'],
            exec: ['docker'],
          },
          socketBindings: [{
            id: 'docker',
            candidates: ['/var/run/docker.sock'],
            resolved: '/var/run/docker.sock',
            override: null,
          }],
        },
      },
    ]);
  });

  test('keeps a service\'s provider role and surface, so the dropdown and the rail see them', () => {
    const [guest] = readGuests(JSON.stringify({
      guests: [{
        id: 'server-chrome',
        name: 'Server Chrome',
        icon: 'window',
        capabilities: { requested: ['service'], granted: ['service'] },
        service: { runtime: 'host', granted: true, provides: ['browser'], surface: true },
      }],
    })) ?? [];
    expect(guest?.service).toEqual({ runtime: 'host', granted: true, provides: ['browser'], surface: true });
    expect(browserProviderGuests(guest ? [guest] : [])).toHaveLength(1);
    expect(enabledGuestSurfaces(guest ? [guest] : [], (path) => path)).toHaveLength(1);

    // An unknown role is a newer server; the row still parses, minus that field.
    const [newer] = readGuests(JSON.stringify({
      guests: [{
        id: 'x', name: 'X', icon: 'window', capabilities: { requested: [], granted: [] },
        service: { runtime: 'host', granted: true, provides: ['printer'] },
      }],
    })) ?? [];
    expect(newer?.service).toEqual({ runtime: 'host', granted: true });
  });

  test('keeps the Git host a source-control provider declares, and drops a malformed slice without the row', () => {
    const slice = { label: 'Acme Forge', defaultInstances: ['https://forge.example.com'], custom: true };
    const row = (sourceControl: typeof slice | { label: string; custom: string }) => ({
      id: 'acme-forge', name: 'Acme Forge', icon: 'git-branch',
      capabilities: { requested: ['service'], granted: [] },
      service: { runtime: 'host', granted: false, provides: ['source-control'] },
      sourceControl,
    });
    const [guest, malformed] = readGuests(JSON.stringify({
      guests: [row(slice), { ...row({ label: '', custom: 'yes' }), id: 'other-forge' }],
    })) ?? [];
    expect(guest?.service?.provides).toEqual(['source-control']);
    expect(guest?.sourceControl).toEqual(slice);
    expect(malformed?.id).toBe('other-forge');
    expect(malformed?.sourceControl).toBeUndefined();
  });

  test('keeps declared tool presentations and drops a malformed list', () => {
    const tools = [
      { match: 'mcp.tasks.*', name: 'Tasks', icon: 'checkbox-circle', title: '{input.id}', output: 'table', columns: ['id', 'title'] },
      { match: 'jira_search', output: 'code', language: 'json' },
    ];
    const guest = (extra: Record<string, unknown>) => ({
      id: 'hello',
      name: 'Hello',
      icon: 'window',
      entry: 'panel/index.html',
      capabilities: { requested: [], granted: [] },
      ...extra,
    });
    expect(readGuests(JSON.stringify({ guests: [guest({ tools })] }))).toEqual([guest({ tools })]);
    expect(readGuests(JSON.stringify({ guests: [guest({ tools: [{ match: 'mcp.*.search' }] })] }))).toBeNull();
    expect(readGuests(JSON.stringify({ guests: [guest({ tools: [{ match: 'x', output: 'html' }] })] }))).toBeNull();
  });

  test('keeps a declared card as the SDK admits it, and refuses one it would not', () => {
    const guest = (extra: { [key: string]: JsonValue }) => ({
      id: 'hello',
      name: 'Hello',
      icon: 'window',
      entry: 'panel/index.html',
      capabilities: { requested: [], granted: [] },
      ...extra,
    });
    const card = {
      label: '{output.key} · {output.type}',
      title: '{output.summary}',
      status: { value: '{output.status}', tones: { 'In Progress': 'info', Blocked: 'error', Done: 'success', Stale: 'warning', Open: 'neutral' } },
      fields: Array.from({ length: 8 }, (_unused, index) => ({ label: `Field ${index}`, value: `{output.fields.${index}}` })),
      link: { label: 'Open', url: 'https://{settings.site}/browse/{output.key}' },
    };
    const tools = (value: JsonValue) => [{ match: 'jira_get_issue', output: 'card', card: value }];
    expect(readGuests(JSON.stringify({ guests: [guest({ tools: tools(card) })] }))).toEqual([guest({ tools: tools(card) })]);

    const refusedCards: JsonValue[] = [
      { ...card, html: '<b>x</b>' },
      { ...card, title: 'no placeholder' },
      { ...card, title: '{input.key}' },
      { ...card, status: { value: '{output.status}', tones: { Done: 'green' } } },
      { ...card, link: { label: 'Open', url: 'http://tracker.example/{output.key}' } },
      { ...card, link: { label: 'Open', url: 'javascript:{output.key}' } },
      { ...card, link: { label: 'Open', url: 'https://user:{output.key}@tracker.example/' } },
      { link: card.link },
      {},
    ];
    for (const refused of refusedCards) {
      expect(readGuests(JSON.stringify({ guests: [guest({ tools: tools(refused) })] }))).toBeNull();
    }
  });

  test('keeps the setting values card links read, and a malformed slice costs only itself', () => {
    const guest = { id: 'hello', name: 'Hello', icon: 'window', capabilities: { requested: [], granted: [] }, source: 'path' };
    const read = (toolLinkSettings: JsonValue) => readGuests(JSON.stringify({ guests: [{ ...guest, toolLinkSettings }] }))?.[0];
    expect(read({ site: 'acme.example', org: 'acme' })?.toolLinkSettings).toEqual({ site: 'acme.example', org: 'acme' });
    const malformedSlices: JsonValue[] = [{ site: '' }, { site: 42 }, { site: 'x'.repeat(2001) }, { 'Not An Id': 'x' }, ['acme.example'], 'acme.example'];
    for (const malformed of malformedSlices) {
      const row = read(malformed);
      expect(row?.id).toBe('hello');
      expect(row?.toolLinkSettings).toBeUndefined();
    }
  });

  test('keeps a status section without a panel entry and drops an out-of-range height', () => {
    const row = { id: 'git-graph', name: 'Git graph', icon: 'git-commit', capabilities: { requested: [], granted: [] } };
    expect(readGuests(JSON.stringify({ guests: [{ ...row, statusEntry: 'status/index.html', statusTitle: 'Commits', statusHeight: 160 }] })))
      .toEqual([{ ...row, statusEntry: 'status/index.html', statusTitle: 'Commits', statusHeight: 160 }]);
    expect(readGuests(JSON.stringify({ guests: [{ ...row, statusEntry: 'status/index.html', statusHeight: 4000 }] }))).toBeNull();
  });

  test('keeps a source status section and refuses a path or interval the SDK would not', () => {
    const row = { id: 'monitor', name: 'Monitor', icon: 'pulse', capabilities: { requested: [], granted: [] } };
    const statusSource = { path: '/status', interval: 2000 };
    expect(readGuests(JSON.stringify({ guests: [{ ...row, statusSource }] }))).toEqual([{ ...row, statusSource }]);
    expect(readGuests(JSON.stringify({ guests: [{ ...row, statusSource: { path: 'status', interval: 2000 } }] }))).toBeNull();
    expect(readGuests(JSON.stringify({ guests: [{ ...row, statusSource: { path: '/status', interval: 10 } }] }))).toBeNull();
  });

  test('keeps bounded storage and status metadata', () => {
    const row = { id: 'git-graph', name: 'Git graph', icon: 'git-commit', capabilities: { requested: [], granted: [] } };
    const storageId = '123e4567-e89b-12d3-a456-426614174000';
    expect(readGuests(JSON.stringify({
      guests: [{ ...row, storageId, statusDefaultExpanded: false, statusRequiresProject: true }],
    }))).toEqual([{ ...row, storageId, statusDefaultExpanded: false, statusRequiresProject: true }]);
    expect(readGuests(JSON.stringify({ guests: [{ ...row, storageId: 'not-an-installation-id' }] }))).toBeNull();
  });

  test('rejects junk instead of returning an empty catalog', () => {
    expect(parseGuestCatalogJson('null')).toBeNull();
    expect(parseGuestCatalogJson('{"guests":[{"id":"Nope"}]}')).toEqual({
      guests: [],
      unreadable: [{ id: null, name: null, builtIn: false }],
      opencodePlugins: null,
    });
  });

  test('reads how OpenCode plugins reach OpenCode, and drops a delivery state this build does not know', () => {
    type Envelope = { delivery: string; globalConfigPath: string | null; inGlobalConfig: string[] };
    const listing = (opencodePlugins?: Envelope) => parseGuestCatalogJson(JSON.stringify({ guests: [], opencodePlugins }))?.opencodePlugins;
    expect(listing({ delivery: 'restart', globalConfigPath: '/home/me/.config/opencode/opencode.json', inGlobalConfig: ['teapot-tools'] }))
      .toEqual({ delivery: 'restart', globalConfigPath: '/home/me/.config/opencode/opencode.json', inGlobalConfig: ['teapot-tools'] });
    // No package ships a plugin, or the global config could not be read: no path, no ids.
    expect(listing({ delivery: 'file', globalConfigPath: null, inGlobalConfig: [] })).toEqual({ delivery: 'file', globalConfigPath: null, inGlobalConfig: [] });
    // A newer server's state would draw a button for a case this build cannot describe.
    expect(listing({ delivery: 'teleport', globalConfigPath: null, inGlobalConfig: [] })).toBeNull();
    expect(listing(undefined)).toBeNull();
  });
});

describe('parseInstalledGuestJson', () => {
  test('reads the install wrapper', () => {
    expect(parseInstalledGuestJson(JSON.stringify({
      guest: {
        id: 'clone-hello',
        name: 'Clone',
        icon: 'window',
        entry: 'panel/index.html',
        capabilities: { requested: [], granted: [] },
        source: 'path',
        path: '/tmp/clone',
      },
    }))).toEqual({
      id: 'clone-hello',
      name: 'Clone',
      icon: 'window',
      entry: 'panel/index.html',
      capabilities: { requested: [], granted: [] },
      source: 'path',
      path: '/tmp/clone',
    });
  });

  test('rejects a bare guest object', () => {
    expect(parseInstalledGuestJson(JSON.stringify({
      id: 'clone-hello',
      name: 'Clone',
      icon: 'window',
      entry: 'panel/index.html',
      capabilities: { requested: [], granted: [] },
    }))).toBeNull();
  });

  test('keeps a git origin and a pending update', () => {
    const guest = parseInstalledGuestJson(JSON.stringify({
      guest: {
        id: 'hello',
        name: 'Hello',
        icon: 'window',
        entry: 'panel/index.html',
        version: '1.0.0',
        source: 'git',
        capabilities: { requested: [], granted: [] },
        origin: { url: 'https://github.com/acme/hello.git', ref: 'v1' },
        update: { version: '1.1.0' },
      },
    }));
    expect(guest?.origin).toEqual({ url: 'https://github.com/acme/hello.git', ref: 'v1' });
    expect(guest?.update).toEqual({ version: '1.1.0' });

    const junkUpdate = parseInstalledGuestJson(JSON.stringify({
      guest: {
        id: 'hello',
        name: 'Hello',
        icon: 'window',
        entry: 'panel/index.html',
        capabilities: { requested: [], granted: [] },
        update: { version: '' },
      },
    }));
    expect(junkUpdate).toBeNull();
  });
});

describe('session events on a catalog row', () => {
  test('keeps the subscription a service declares, and drops a slice with an unknown event type without the row', () => {
    const slice = { events: ['turn-finished', 'question-asked'], content: true };
    const row = (sessionEvents: { events: string[]; content: boolean }) => ({
      id: 'journal', name: 'Journal', icon: 'book',
      capabilities: { requested: ['service', 'transcript'], granted: [] },
      service: { runtime: 'host', granted: false },
      sessionEvents,
    });
    const [guest, newer] = readGuests(JSON.stringify({
      guests: [row(slice), { ...row({ events: ['turn-finished', 'turn-paused'], content: false }), id: 'newer' }],
    })) ?? [];
    expect(guest?.sessionEvents).toEqual(slice);
    expect(guest?.capabilities.requested).toEqual(['service', 'transcript']);
    expect(newer?.id).toBe('newer');
    expect(newer?.sessionEvents).toBeUndefined();
  });
});

describe('marks on a catalog row', () => {
  test('keeps that an extension asks to show marks, and reads a row that says it another way as one that does not', () => {
    const row = (id: string, marks: JsonValue) => ({
      id, name: id, icon: 'flag',
      capabilities: { requested: ['service', 'marks'], granted: ['service', 'marks'] },
      service: { runtime: 'host', granted: true },
      marks,
    });
    const guests = readGuests(JSON.stringify({ guests: [row('ci', true), row('off', false), row('newer', { rows: ['session'] })] })) ?? [];
    expect(guests.map((guest) => [guest.id, guest.marks])).toEqual([['ci', true], ['off', undefined], ['newer', undefined]]);
    expect(guests[0]?.capabilities.granted).toEqual(['service', 'marks']);
  });
});

describe('notification channels on a catalog row', () => {
  test('keeps the channel a service declares, and drops a malformed slice without the row', () => {
    const slice = { label: 'Slack', instances: { kind: 'fixed', origin: 'https://slack.com' }, token: { scheme: 'bearer', username: false, scopes: ['chat:write'] } };
    const row = (notifications: { label: string; instances: { kind: string; origin?: string }; token: { scheme: string; username: boolean; scopes: string[] } }) => ({
      id: 'slack-bridge', name: 'Slack Bridge', icon: 'notification-3',
      capabilities: { requested: ['service'], granted: [] },
      service: { runtime: 'host', granted: false, provides: ['notifications'] },
      notifications,
    });
    const [guest, malformed] = readGuests(JSON.stringify({
      guests: [row(slice), { ...row({ label: 'Slack', instances: { kind: 'dynamic' }, token: { scheme: 'bearer', username: false, scopes: [] } }), id: 'other' }],
    })) ?? [];
    expect(guest?.service?.provides).toEqual(['notifications']);
    expect(guest?.notifications).toEqual(slice);
    expect(malformed?.id).toBe('other');
    expect(malformed?.notifications).toBeUndefined();
  });
});

test('reads an OpenCode service role and its approval capability from the catalog', () => {
  const row = {
    id: 'api-provider', name: 'API provider', icon: 'plug',
    service: { runtime: 'host', provides: ['opencode'], granted: false },
    capabilities: { requested: ['service', 'opencode'], granted: ['service'] },
  };
  expect(parseGuestCatalogJson(JSON.stringify({ guests: [row] }))).toEqual({
    guests: [row],
    opencodePlugins: null,
    unreadable: [],
  });
});

describe('links on a catalog row', () => {
  const links = {
    action: 'open',
    keys: ['DEMO'],
    urls: {
      origin: 'https://tasks.example.com',
      identifierPattern: '^[A-Za-z][A-Za-z0-9_]{0,31}-\\d{1,16}$',
      patterns: [{ path: '^/tasks/([A-Za-z][A-Za-z0-9_]{0,31}-\\d{1,16})(?:/|$)' }],
      itemTemplate: '/tasks/{id}',
    },
  };
  type LinksJson = Omit<typeof links, 'urls'> & { urls: typeof links.urls | null };
  const row = (value: LinksJson) => ({ guest: { id: 'tasks', name: 'Tasks', icon: 'task', capabilities: { requested: ['links'], granted: ['links'] }, links: value } });

  test('reads the compiled links the server serves', () => {
    expect(parseInstalledGuestJson(JSON.stringify(row(links)))?.links).toEqual({ ...links, action: 'open' });
  });

  test('a links value this build cannot read drops the links, never the row', () => {
    for (const broken of [
      { ...links, keys: ['proj'] },
      { ...links, action: 'jump' },
      { ...links, urls: { ...links.urls, origin: 'http://tasks.example.com' } },
      { ...links, urls: { ...links.urls, itemTemplate: '/{segment}/{id}' } },
      { ...links, keys: [], urls: null },
    ]) {
      const parsed = parseInstalledGuestJson(JSON.stringify(row(broken)));
      expect(parsed?.id).toBe('tasks');
      expect(parsed?.links).toBeUndefined();
    }
  });
});
