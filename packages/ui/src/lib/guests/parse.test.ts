import { describe, expect, test } from 'bun:test';

import { parseGuestCatalogJson, parseInstalledGuestJson } from './parse.ts';

describe('parseGuestCatalogJson', () => {
  test('reads a valid catalog', () => {
    expect(parseGuestCatalogJson(JSON.stringify({
      guests: [{
        id: 'hello',
        name: 'Hello',
        icon: 'window',
        entry: 'panel/index.html',
        source: 'path',
        path: '/tmp/hello',
      }, {
        id: 'zip-hello',
        name: 'Zip',
        icon: 'window',
        entry: 'panel/index.html',
        source: 'zip',
        path: '/data/guests/zip-hello',
      }, {
        id: 'git-hello',
        name: 'Git',
        icon: 'window',
        entry: 'panel/index.html',
        source: 'git',
        path: '/data/guests/git-hello',
      }],
    }))).toEqual([
      {
        id: 'hello',
        name: 'Hello',
        icon: 'window',
        entry: 'panel/index.html',
        source: 'path',
        path: '/tmp/hello',
      },
      {
        id: 'zip-hello',
        name: 'Zip',
        icon: 'window',
        entry: 'panel/index.html',
        source: 'zip',
        path: '/data/guests/zip-hello',
      },
      {
        id: 'git-hello',
        name: 'Git',
        icon: 'window',
        entry: 'panel/index.html',
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
        attach: 'dialog',
      }],
    }))).toEqual([
      {
        id: 'hello',
        name: 'Hello',
        icon: 'window',
        entry: 'panel/index.html',
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
        integration: {
          name: 'ClickUp',
          description: 'Tasks from a ClickUp list',
          auth: 'token',
          settings: [{ id: 'list-id', label: 'List ID' }],
        },
      },
    ]);
  });

  test('keeps a public agent slice', () => {
    expect(parseGuestCatalogJson(JSON.stringify({
      guests: [{
        id: 'docker',
        name: 'Docker',
        icon: 'box-3',
        entry: 'panel/index.html',
        agent: {
          runtime: 'host',
          granted: false,
          permissions: {
            sockets: ['/var/run/docker.sock'],
            exec: ['docker'],
          },
        },
      }],
    }))).toEqual([
      {
        id: 'docker',
        name: 'Docker',
        icon: 'box-3',
        entry: 'panel/index.html',
        agent: {
          runtime: 'host',
          granted: false,
          permissions: {
            sockets: ['/var/run/docker.sock'],
            exec: ['docker'],
          },
        },
      },
    ]);
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
        source: 'path',
        path: '/tmp/clone',
      },
    }))).toEqual({
      id: 'clone-hello',
      name: 'Clone',
      icon: 'window',
      entry: 'panel/index.html',
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
    }))).toBeNull();
  });
});
