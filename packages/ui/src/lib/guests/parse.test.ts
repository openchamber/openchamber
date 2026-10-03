import { describe, expect, test } from 'bun:test';

import { browserProviderGuests } from './browser-providers.ts';
import { parseGuestCatalogJson, parseInstalledGuestJson } from './parse.ts';
import { enabledGuestSurfaces } from './surfaces.ts';

describe('parseGuestCatalogJson', () => {
  test('reads a valid catalog', () => {
    expect(parseGuestCatalogJson(JSON.stringify({
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
    expect(parseGuestCatalogJson(JSON.stringify({
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
    expect(parseGuestCatalogJson(JSON.stringify({
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
    expect(parseGuestCatalogJson(JSON.stringify({
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
    const [guest] = parseGuestCatalogJson(JSON.stringify({
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
    const [newer] = parseGuestCatalogJson(JSON.stringify({
      guests: [{
        id: 'x', name: 'X', icon: 'window', capabilities: { requested: [], granted: [] },
        service: { runtime: 'host', granted: true, provides: ['printer'] },
      }],
    })) ?? [];
    expect(newer?.service).toEqual({ runtime: 'host', granted: true });
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
    expect(parseGuestCatalogJson(JSON.stringify({ guests: [guest({ tools })] }))).toEqual([guest({ tools })]);
    expect(parseGuestCatalogJson(JSON.stringify({ guests: [guest({ tools: [{ match: 'mcp.*.search' }] })] }))).toBeNull();
    expect(parseGuestCatalogJson(JSON.stringify({ guests: [guest({ tools: [{ match: 'x', output: 'html' }] })] }))).toBeNull();
  });

  test('keeps a status section without a panel entry and drops an out-of-range height', () => {
    const row = { id: 'git-graph', name: 'Git graph', icon: 'git-commit', capabilities: { requested: [], granted: [] } };
    expect(parseGuestCatalogJson(JSON.stringify({ guests: [{ ...row, statusEntry: 'status/index.html', statusTitle: 'Commits', statusHeight: 160 }] })))
      .toEqual([{ ...row, statusEntry: 'status/index.html', statusTitle: 'Commits', statusHeight: 160 }]);
    expect(parseGuestCatalogJson(JSON.stringify({ guests: [{ ...row, statusEntry: 'status/index.html', statusHeight: 4000 }] }))).toBeNull();
  });

  test('rejects junk instead of returning an empty catalog', () => {
    expect(parseGuestCatalogJson('null')).toBeNull();
    expect(parseGuestCatalogJson('{"guests":[{"id":"Nope"}]}')).toBeNull();
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
