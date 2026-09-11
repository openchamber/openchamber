import { describe, expect, test } from 'bun:test';

import { OPENCHAMBER_SDK_API_VERSION } from './api-version.ts';
import { requestedGuestCapabilities, resolveAttachEntry, resolveAttachMode, resolveIntegrationApi, toPublicIntegration } from './manifest.ts';
import { parseManifest, parseManifestJson } from './parse.ts';

const validBlock = {
  apiVersion: OPENCHAMBER_SDK_API_VERSION,
  contributes: {
    panel: {
      id: 'acme-hello',
      name: 'Hello',
      icon: 'window',
      entry: 'panel/index.html',
    },
  },
};

describe('parseManifest', () => {
  test('reads a bare manifest block', () => {
    const result = parseManifest(validBlock);
    expect(result).toEqual({
      ok: true,
      manifest: {
        apiVersion: 1,
        contributes: {
          panel: {
            id: 'acme-hello',
            name: 'Hello',
            icon: 'window',
            entry: 'panel/index.html',
          },
        },
      },
    });
  });

  test('reads package.json openchamber', () => {
    const result = parseManifest({
      openchamber: validBlock,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.contributes.panel.id).toBe('acme-hello');
      expect(result.version).toBeUndefined();
    }
  });

  test('reads package.json version', () => {
    const result = parseManifestJson(JSON.stringify({
      name: '@acme/hello-panel',
      version: '1.2.3',
      openchamber: validBlock,
    }));
    expect(result).toMatchObject({
      ok: true,
      version: '1.2.3',
      manifest: { contributes: { panel: { id: 'acme-hello' } } },
    });
  });

  test('rejects a bad package.json version', () => {
    const result = parseManifestJson(JSON.stringify({
      name: '@acme/hello-panel',
      version: 'latest',
      openchamber: validBlock,
    }));
    expect(result).toMatchObject({ ok: false, code: 'invalid-version' });
  });

  test('trims strings and drops extra keys', () => {
    const result = parseManifestJson(JSON.stringify({
      name: '@acme/hello-panel',
      extra: true,
      openchamber: {
        apiVersion: 1,
        extra: true,
        contributes: {
          panel: {
            id: '  acme-hello  ',
            name: ' Hello ',
            icon: ' window ',
            entry: ' panel/index.html ',
            color: 'red',
          },
        },
      },
    }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.contributes.panel).toEqual({
        id: 'acme-hello',
        name: 'Hello',
        icon: 'window',
        entry: 'panel/index.html',
      });
    }
  });

  test('rejects a non-object JSON value', () => {
    expect(parseManifestJson('null')).toEqual({
      ok: false,
      code: 'not-object',
      message: 'Manifest must be a plain object.',
    });
    expect(parseManifestJson('"nope"')).toMatchObject({ ok: false, code: 'not-object' });
  });

  test('rejects a missing or non-object openchamber key', () => {
    const missing = parseManifestJson('{"name":"@acme/hello-panel","openchamber":null}');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe('missing-openchamber');
  });

  test('rejects an unknown apiVersion', () => {
    const result = parseManifestJson(JSON.stringify({ ...validBlock, apiVersion: 99 }));
    expect(result).toMatchObject({ ok: false, code: 'unsupported-api-version' });
  });

  test('accepts a service on apiVersion 1', () => {
    const result = parseManifest({
      apiVersion: 1,
      contributes: {
        panel: validBlock.contributes.panel,
        service: {
          entry: 'service/main.js',
          runtime: 'host',
          permissions: {
            sockets: ['/var/run/docker.sock'],
            exec: ['docker'],
          },
        },
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.contributes.service).toEqual({
        entry: 'service/main.js',
        runtime: 'host',
        permissions: {
          sockets: [{
            id: '/var/run/docker.sock',
            candidatesByPlatform: {
              linux: ['/var/run/docker.sock'],
              darwin: ['/var/run/docker.sock'],
              win32: ['/var/run/docker.sock'],
            },
          }],
          exec: ['docker'],
        },
      });
    }
  });

  test('accepts files in capabilities and a filesystem list, and derives the filesystem grant', () => {
    const result = parseManifest({
      apiVersion: 1,
      contributes: {
        panel: validBlock.contributes.panel,
        capabilities: ['files'],
        filesystem: ['~/.config/opencode/opencode.json', '/tmp/probe/**'],
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.contributes.capabilities).toEqual(['files']);
      expect(result.manifest.contributes.filesystem).toEqual(['~/.config/opencode/opencode.json', '/tmp/probe/**']);
      expect(requestedGuestCapabilities(result.manifest.contributes)).toEqual(['files', 'filesystem']);
    }
    expect(requestedGuestCapabilities({ capabilities: ['files'] })).toEqual(['files']);
  });

  test('rejects filesystem patterns that are relative, escape, or are empty', () => {
    const attempt = (filesystem: unknown) => parseManifest({
      apiVersion: 1,
      contributes: {
        panel: validBlock.contributes.panel,
        // Junk on purpose: this is what an untrusted package.json may carry.
        filesystem: filesystem as string[],
      },
    });
    for (const bad of [['relative/path'], ['~/../etc/passwd'], ['/a//b'], ['/a/'], [], ['/x\\y'], ['~'], new Array(17).fill('/ok')]) {
      const result = attempt(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('invalid-filesystem');
      }
    }
  });

  test('accepts object socket bindings with per-platform candidates', () => {
    const result = parseManifest({
      apiVersion: 1,
      contributes: {
        panel: validBlock.contributes.panel,
        service: {
          entry: 'service/main.js',
          runtime: 'host',
          permissions: {
            sockets: [{
              id: 'docker',
              candidates: {
                linux: ['/var/run/docker.sock'],
                darwin: ['~/.docker/run/docker.sock'],
                win32: ['//./pipe/docker_engine'],
              },
            }],
          },
        },
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.contributes.service?.permissions?.sockets).toEqual([{
        id: 'docker',
        candidatesByPlatform: {
          linux: ['/var/run/docker.sock'],
          darwin: ['~/.docker/run/docker.sock'],
          win32: ['//./pipe/docker_engine'],
        },
      }]);
    }
  });

  test('rejects a socket binding without path or candidates', () => {
    const result = parseManifest({
      apiVersion: 1,
      contributes: {
        panel: validBlock.contributes.panel,
        service: {
          entry: 'service/main.js',
          runtime: 'host',
          permissions: {
            sockets: [{ id: 'docker' }],
          },
        },
      },
    });
    expect(result).toMatchObject({ ok: false, code: 'invalid-service' });
  });

  test('rejects apiVersion 2', () => {
    const result = parseManifestJson(JSON.stringify({
      apiVersion: 2,
      contributes: {
        panel: validBlock.contributes.panel,
      },
    }));
    expect(result).toMatchObject({ ok: false, code: 'unsupported-api-version' });
  });

  test('keeps engines.openchamber', () => {
    const result = parseManifest({
      ...validBlock,
      engines: { openchamber: '>=1.22.0' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.engines).toEqual({ openchamber: '>=1.22.0' });
    }
  });

  test('rejects a junk engines.openchamber range', () => {
    const result = parseManifest({
      ...validBlock,
      engines: { openchamber: '^1.22.0' },
    });
    expect(result).toMatchObject({ ok: false, code: 'invalid-engines' });
  });

  test('keeps attach when it is true', () => {
    const result = parseManifest({
      ...validBlock,
      contributes: {
        ...validBlock.contributes,
        attach: true,
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.contributes.attach).toBe(true);
    }
  });

  test('keeps attach when it is dialog', () => {
    const result = parseManifest({
      ...validBlock,
      contributes: {
        ...validBlock.contributes,
        attach: 'dialog',
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.contributes.attach).toBe('dialog');
    }
  });

  test('keeps the object attach form with a dialog entry', () => {
    const result = parseManifest({
      ...validBlock,
      contributes: {
        ...validBlock.contributes,
        attach: { mode: 'dialog', entry: 'panel/attach.html' },
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.contributes.attach).toEqual({ mode: 'dialog', entry: 'panel/attach.html' });
      expect(resolveAttachMode(result.manifest.contributes.attach)).toBe('dialog');
      expect(resolveAttachEntry(result.manifest.contributes)).toBe('panel/attach.html');
    }
  });

  test('object attach without an entry reuses panel.entry', () => {
    const result = parseManifest({
      ...validBlock,
      contributes: { ...validBlock.contributes, attach: { mode: 'panel' } },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(resolveAttachMode(result.manifest.contributes.attach)).toBe('panel');
      expect(resolveAttachEntry(result.manifest.contributes)).toBeNull();
    }
    expect(resolveAttachEntry({ attach: 'dialog' })).toBeNull();
    expect(resolveAttachEntry({ attach: undefined })).toBeNull();
  });

  test('rejects an attach entry that leaves the package or sits on panel mode', () => {
    expect(parseManifestJson(JSON.stringify({
      ...validBlock,
      contributes: { ...validBlock.contributes, attach: { mode: 'dialog', entry: '../attach.html' } },
    }))).toMatchObject({ ok: false, code: 'invalid-attach' });
    expect(parseManifestJson(JSON.stringify({
      ...validBlock,
      contributes: { ...validBlock.contributes, attach: { mode: 'dialog', entry: 'https://x.test/a.html' } },
    }))).toMatchObject({ ok: false, code: 'invalid-attach' });
    expect(parseManifestJson(JSON.stringify({
      ...validBlock,
      contributes: { ...validBlock.contributes, attach: { mode: 'panel', entry: 'panel/attach.html' } },
    }))).toMatchObject({ ok: false, code: 'invalid-attach' });
    expect(parseManifestJson(JSON.stringify({
      ...validBlock,
      contributes: { ...validBlock.contributes, attach: { mode: 'window' } },
    }))).toMatchObject({ ok: false, code: 'invalid-attach' });
  });

  test('rejects a junk attach value', () => {
    expect(parseManifestJson(JSON.stringify({
      ...validBlock,
      contributes: { ...validBlock.contributes, attach: 'yes' },
    }))).toMatchObject({ ok: false, code: 'invalid-attach' });
  });

  test('resolves attach modes', () => {
    expect(resolveAttachMode(undefined)).toBeNull();
    expect(resolveAttachMode(false)).toBeNull();
    expect(resolveAttachMode(true)).toBe('panel');
    expect(resolveAttachMode('panel')).toBe('panel');
    expect(resolveAttachMode('dialog')).toBe('dialog');
    expect(resolveAttachMode({ mode: 'dialog', entry: 'panel/attach.html' })).toBe('dialog');
    expect(resolveAttachMode({ mode: 'panel' })).toBe('panel');
  });

  test('rejects a missing panel', () => {
    expect(parseManifestJson('{"apiVersion":1,"contributes":{}}')).toMatchObject({
      ok: false,
      code: 'missing-panel',
    });
  });

  test('rejects a bad panel id', () => {
    const result = parseManifestJson(JSON.stringify({
      ...validBlock,
      contributes: { panel: { ...validBlock.contributes.panel, id: 'Acme Hello' } },
    }));
    expect(result).toMatchObject({ ok: false, code: 'invalid-panel-id' });
  });

  test('keeps a valid integration block', () => {
    const result = parseManifest({
      ...validBlock,
      contributes: {
        ...validBlock.contributes,
        integration: {
          name: 'ClickUp',
          description: 'Tasks from a ClickUp list',
          oauth: {
            authorizeUrl: 'https://app.clickup.com/api',
            tokenUrl: 'https://api.clickup.com/api/v2/oauth/token',
            apiOrigin: 'https://api.clickup.com',
            scopes: ['task:read'],
            account: { path: '/api/v2/user', name: 'user.username' },
          },
          settings: [{ id: 'list-id', label: 'List ID' }],
        },
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.contributes.integration).toEqual({
        name: 'ClickUp',
        description: 'Tasks from a ClickUp list',
        oauth: {
          authorizeUrl: 'https://app.clickup.com/api',
          tokenUrl: 'https://api.clickup.com/api/v2/oauth/token',
          apiOrigin: 'https://api.clickup.com',
          scopes: ['task:read'],
          account: { path: '/api/v2/user', name: 'user.username' },
        },
        settings: [{ id: 'list-id', label: 'List ID' }],
      });
    }
  });

  test('keeps a token integration block', () => {
    const result = parseManifest({
      ...validBlock,
      contributes: {
        ...validBlock.contributes,
        integration: {
          name: 'ClickUp',
          description: 'Tasks from a ClickUp list',
          token: {
            apiOrigin: 'https://api.clickup.com',
            account: { path: '/api/v2/user', name: 'user.username' },
          },
          settings: [{ id: 'list-id', label: 'List ID' }],
        },
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.contributes.integration).toEqual({
        name: 'ClickUp',
        description: 'Tasks from a ClickUp list',
        token: {
          apiOrigin: 'https://api.clickup.com',
          account: { path: '/api/v2/user', name: 'user.username' },
        },
        settings: [{ id: 'list-id', label: 'List ID' }],
      });
    }
  });

  test('keeps a basic token scheme with its username label', () => {
    const result = parseManifest({
      ...validBlock,
      contributes: {
        ...validBlock.contributes,
        integration: {
          name: 'Jira',
          description: 'Issues from Jira Cloud',
          token: {
            apiOrigin: 'https://acme.atlassian.net',
            scheme: 'basic',
            usernameLabel: 'Atlassian email',
          },
        },
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const integration = result.manifest.contributes.integration;
      expect(integration?.token).toEqual({
        apiOrigin: 'https://acme.atlassian.net',
        scheme: 'basic',
        usernameLabel: 'Atlassian email',
      });
      expect(resolveIntegrationApi(integration!)?.authorization).toBe('basic');
      expect(toPublicIntegration(integration!).token).toEqual({ scheme: 'basic', usernameLabel: 'Atlassian email' });
    }
  });

  test('keeps a host Linear integration block', () => {
    const result = parseManifest({
      ...validBlock,
      contributes: {
        ...validBlock.contributes,
        integration: {
          name: 'Linear',
          description: 'Issues from Linear',
          host: { provider: 'linear' },
        },
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.contributes.integration).toEqual({
        name: 'Linear',
        description: 'Issues from Linear',
        host: { provider: 'linear' },
      });
    }
  });

  test('rejects an integration with both oauth and token, or neither', () => {
    expect(parseManifest({
      ...validBlock,
      contributes: {
        ...validBlock.contributes,
        integration: {
          name: 'ClickUp',
          description: 'Tasks',
        },
      },
    })).toMatchObject({ ok: false, code: 'invalid-integration' });

    expect(parseManifest({
      ...validBlock,
      contributes: {
        ...validBlock.contributes,
        integration: {
          name: 'ClickUp',
          description: 'Tasks',
          oauth: {
            authorizeUrl: 'https://app.clickup.com/api',
            tokenUrl: 'https://api.clickup.com/api/v2/oauth/token',
            apiOrigin: 'https://api.clickup.com',
          },
          token: { apiOrigin: 'https://api.clickup.com' },
        },
      },
    })).toMatchObject({ ok: false, code: 'invalid-integration' });

    expect(parseManifest({
      ...validBlock,
      contributes: {
        ...validBlock.contributes,
        integration: {
          name: 'Linear',
          description: 'Issues',
          host: { provider: 'linear' },
          token: { apiOrigin: 'https://api.linear.app' },
        },
      },
    })).toMatchObject({ ok: false, code: 'invalid-integration' });
  });

  test('rejects http oauth URLs and credentials in the URL', () => {
    expect(parseManifest({
      ...validBlock,
      contributes: {
        ...validBlock.contributes,
        integration: {
          name: 'ClickUp',
          description: 'Tasks',
          oauth: {
            authorizeUrl: 'http://app.clickup.com/api',
            tokenUrl: 'https://api.clickup.com/api/v2/oauth/token',
            apiOrigin: 'https://api.clickup.com',
          },
        },
      },
    })).toMatchObject({ ok: false, code: 'invalid-integration' });

    expect(parseManifest({
      ...validBlock,
      contributes: {
        ...validBlock.contributes,
        integration: {
          name: 'ClickUp',
          description: 'Tasks',
          oauth: {
            authorizeUrl: 'https://user:pass@app.clickup.com/api',
            tokenUrl: 'https://api.clickup.com/api/v2/oauth/token',
            apiOrigin: 'https://api.clickup.com',
          },
        },
      },
    })).toMatchObject({ ok: false, code: 'invalid-integration' });

    expect(parseManifest({
      ...validBlock,
      contributes: {
        ...validBlock.contributes,
        integration: {
          name: 'ClickUp',
          description: 'Tasks',
          oauth: {
            authorizeUrl: 'https://app.clickup.com/api',
            tokenUrl: 'https://api.clickup.com/api/v2/oauth/token',
            apiOrigin: 'https://api.clickup.com/v2',
          },
        },
      },
    })).toMatchObject({ ok: false, code: 'invalid-integration' });
  });

  test('rejects a path that escapes the package', () => {
    const traversal = parseManifestJson(JSON.stringify({
      ...validBlock,
      contributes: { panel: { ...validBlock.contributes.panel, entry: '../secret.html' } },
    }));
    expect(traversal).toMatchObject({ ok: false, code: 'invalid-panel-entry' });

    const absolute = parseManifestJson(JSON.stringify({
      ...validBlock,
      contributes: { panel: { ...validBlock.contributes.panel, icon: '/etc/passwd' } },
    }));
    expect(absolute).toMatchObject({ ok: false, code: 'invalid-panel-icon' });

    const packagedSvg = parseManifestJson(JSON.stringify({
      ...validBlock,
      contributes: { panel: { ...validBlock.contributes.panel, icon: 'icon.svg' } },
    }));
    expect(packagedSvg).toMatchObject({ ok: true });
    if (packagedSvg.ok) {
      expect(packagedSvg.manifest.contributes.panel.icon).toBe('icon.svg');
    }

    const nestedSvg = parseManifestJson(JSON.stringify({
      ...validBlock,
      contributes: { panel: { ...validBlock.contributes.panel, icon: 'assets/mark.svg' } },
    }));
    expect(nestedSvg).toMatchObject({ ok: true });

    const pngIcon = parseManifestJson(JSON.stringify({
      ...validBlock,
      contributes: { panel: { ...validBlock.contributes.panel, icon: 'icon.png' } },
    }));
    expect(pngIcon).toMatchObject({ ok: false, code: 'invalid-panel-icon' });
  });

  test('reads a token integration', () => {
    const result = parseManifestJson(JSON.stringify({
      name: '@openchamber/clickup',
      openchamber: {
        apiVersion: OPENCHAMBER_SDK_API_VERSION,
        contributes: {
          panel: { id: 'clickup', name: 'ClickUp', icon: 'window', entry: 'panel/index.html' },
          integration: {
            name: 'ClickUp',
            description: 'Tasks from a ClickUp list',
            token: { apiOrigin: 'https://api.clickup.com' },
            settings: [{ id: 'list-id', label: 'List ID' }],
          },
        },
      },
    }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.contributes.panel.id).toBe('clickup');
      expect(result.manifest.contributes.integration?.token?.apiOrigin).toBe('https://api.clickup.com');
      expect(result.manifest.contributes.integration?.oauth).toBeUndefined();
      expect(result.manifest.contributes.integration?.settings).toEqual([
        { id: 'list-id', label: 'List ID' },
      ]);
    }
  });

  test('reads a host Linear integration', () => {
    const result = parseManifestJson(JSON.stringify({
      name: '@openchamber/linear',
      openchamber: {
        apiVersion: OPENCHAMBER_SDK_API_VERSION,
        contributes: {
          panel: { id: 'linear-issues', name: 'Linear', icon: 'window', entry: 'panel/index.html' },
          integration: {
            name: 'Linear',
            description: 'Issues from Linear',
            host: { provider: 'linear' },
          },
        },
      },
    }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.contributes.panel.id).toBe('linear-issues');
      expect(result.manifest.contributes.integration?.host).toEqual({ provider: 'linear' });
      expect(result.manifest.contributes.integration?.oauth).toBeUndefined();
      expect(result.manifest.contributes.integration?.token).toBeUndefined();
    }
  });

  test('reads an OAuth integration', () => {
    const result = parseManifestJson(JSON.stringify({
      name: '@openchamber/gitlab',
      openchamber: {
        apiVersion: OPENCHAMBER_SDK_API_VERSION,
        contributes: {
          panel: { id: 'gitlab', name: 'GitLab', icon: 'window', entry: 'panel/index.html' },
          integration: {
            name: 'GitLab',
            description: 'Merge requests from GitLab',
            oauth: {
              authorizeUrl: 'https://gitlab.com/oauth/authorize',
              tokenUrl: 'https://gitlab.com/oauth/token',
              apiOrigin: 'https://gitlab.com',
              scopes: ['api'],
            },
            settings: [{ id: 'project-path', label: 'Project path' }],
          },
        },
      },
    }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.contributes.panel.id).toBe('gitlab');
      expect(result.manifest.contributes.integration?.oauth).toMatchObject({
        authorizeUrl: 'https://gitlab.com/oauth/authorize',
        tokenUrl: 'https://gitlab.com/oauth/token',
        apiOrigin: 'https://gitlab.com',
        scopes: ['api'],
      });
      expect(result.manifest.contributes.integration?.settings).toEqual([
        { id: 'project-path', label: 'Project path' },
      ]);
    }
  });
});

describe('contributes.actions and contributes.commands', () => {
  const withContributes = (extra: Record<string, unknown>) => parseManifest({
    apiVersion: 1,
    contributes: { panel: validBlock.contributes.panel, ...extra },
  });

  test('reads actions and derives the conversation capability from a messages payload', () => {
    const result = withContributes({
      actions: [
        { id: 'create-task', label: 'Create task from message', icon: 'add-line', where: 'message', roles: ['assistant'] },
        { id: 'summarize', label: 'Summarize session', where: 'session', payload: ['messages'] },
        { id: 'open-session', label: 'Open in tracker', where: 'session' },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.contributes.actions).toEqual([
        { id: 'create-task', label: 'Create task from message', icon: 'add-line', where: 'message', roles: ['assistant'] },
        { id: 'summarize', label: 'Summarize session', where: 'session', payload: ['messages'] },
        { id: 'open-session', label: 'Open in tracker', where: 'session' },
      ]);
      expect(requestedGuestCapabilities(result.manifest.contributes)).toEqual(['conversation']);
    }
    expect(requestedGuestCapabilities({ actions: [{ id: 'a', label: 'A', where: 'session' }] })).toEqual([]);
    expect(requestedGuestCapabilities({ actions: [{ id: 'a', label: 'A', where: 'message' }] })).toEqual([]);
    expect(requestedGuestCapabilities({
      capabilities: ['files'],
      actions: [{ id: 'a', label: 'A', where: 'session', payload: ['messages'] }],
    })).toEqual(['files', 'conversation']);
  });

  test('rejects malformed actions as invalid-actions', () => {
    const cases: unknown[] = [
      [],
      [{ id: 'Bad Id', label: 'x', where: 'message' }],
      [{ id: 'a', label: '', where: 'message' }],
      [{ id: 'a', label: 'x'.repeat(41), where: 'message' }],
      [{ id: 'a', label: 'x', where: 'nowhere' }],
      [{ id: 'a', label: 'x', where: 'session', roles: ['user'] }],
      [{ id: 'a', label: 'x', where: 'message', payload: ['messages'] }],
      [{ id: 'a', label: 'x', where: 'message', roles: [] }],
      [{ id: 'a', label: 'x', where: 'session', payload: ['files'] }],
      [{ id: 'a', label: 'x', where: 'message', icon: 'https://x/y.svg' }],
      [{ id: 'dup', label: 'x', where: 'message' }, { id: 'dup', label: 'y', where: 'session' }],
      new Array(9).fill(null).map((_, index) => ({ id: `a-${index}`, label: 'x', where: 'message' })),
    ];
    for (const actions of cases) {
      expect(withContributes({ actions })).toMatchObject({ ok: false, code: 'invalid-actions' });
    }
  });

  test('reads commands and rejects malformed ones as invalid-commands', () => {
    const result = withContributes({
      commands: [{ name: 'task', description: 'Attach a task by id' }, { name: 'pr' }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.contributes.commands).toEqual([
        { name: 'task', description: 'Attach a task by id' },
        { name: 'pr' },
      ]);
    }
    const cases: unknown[] = [
      [],
      [{ name: 'Task' }],
      [{ name: '1task' }],
      [{ name: 'a'.repeat(25) }],
      [{ name: 'task', description: '' }],
      [{ name: 'task', description: 'x'.repeat(81) }],
      [{ name: 'task' }, { name: 'task' }],
      new Array(9).fill(null).map((_, index) => ({ name: `c-${index}` })),
    ];
    for (const commands of cases) {
      expect(withContributes({ commands })).toMatchObject({ ok: false, code: 'invalid-commands' });
    }
  });
});
