import { describe, expect, test } from 'bun:test';

import { OPENCHAMBER_SDK_API_VERSION } from './api-version.ts';
import { clampStatusSectionHeight, hasGuestPage, requestedGuestCapabilities, toPublicNotifications, toPublicSessionEvents, toPublicSourceControl, resolveAttachEntry, resolveStatusSectionEntry, resolveStatusSectionSource, resolveAttachMode, resolveIntegrationApi, toPublicIntegration, type OpenChamberContributes } from './manifest.ts';
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
  test('preserves background action mode without changing legacy actions', () => {
    const actions = [
      { id: 'toast', label: 'Toast', where: 'message', mode: 'background' },
      { id: 'inspect', label: 'Inspect', where: 'session' },
    ];
    const result = parseManifestJson(JSON.stringify({ ...validBlock, contributes: { ...validBlock.contributes, actions } }));
    expect(result).toMatchObject({ ok: true, manifest: { contributes: { actions } } });
    expect(parseManifestJson(JSON.stringify({ ...validBlock, contributes: {
      ...validBlock.contributes, actions: [{ ...actions[0], mode: 'silent' }],
    } }))).toMatchObject({ ok: false, code: 'invalid-actions' });
    expect(parseManifestJson(JSON.stringify({ ...validBlock, contributes: {
      panel: { id: 'toast', name: 'Toast', icon: 'window' }, actions,
    } }))).toMatchObject({ ok: false, code: 'invalid-panel' });
  });

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

  test('preserves optional Work Status visibility and expansion settings', () => {
    const result = parseManifest({
      ...validBlock,
      contributes: {
        ...validBlock.contributes,
        statusSection: {
          entry: 'status/index.html',
          defaultExpanded: false,
          requiresProject: true,
        },
      },
    });
    expect(result).toMatchObject({ ok: true, manifest: { contributes: { statusSection: {
      entry: 'status/index.html', defaultExpanded: false, requiresProject: true,
    } } } });
    expect(parseManifest({ ...validBlock, contributes: { ...validBlock.contributes, statusSection: { entry: 'status/index.html', defaultExpanded: 'no' } } })).toMatchObject({ ok: false, code: 'invalid-status-section' });
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

  test('accepts model in capabilities and keeps it in the requested list', () => {
    const result = parseManifest({
      apiVersion: 1,
      contributes: {
        panel: validBlock.contributes.panel,
        capabilities: ['model', 'prompt'],
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.contributes.capabilities).toEqual(['model', 'prompt']);
      expect(requestedGuestCapabilities(result.manifest.contributes)).toEqual(['prompt', 'model']);
    }
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

  test('accepts declared https origins and derives the origins grant', () => {
    const result = parseManifest({
      apiVersion: 1,
      contributes: { panel: validBlock.contributes.panel, origins: ['https://fonts.example.com', 'https://api.example.com:8443'] },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.contributes.origins).toEqual(['https://fonts.example.com', 'https://api.example.com:8443']);
      expect(requestedGuestCapabilities(result.manifest.contributes)).toEqual(['origins']);
    }
  });

  test('rejects origins that are not plain unique https origins', () => {
    for (const bad of [['http://fonts.example.com'], ['https://fonts.example.com/path'], ['https://*.example.com'], ['https://a.test', 'https://a.test'], [], ['https://u:p@a.test'], new Array(9).fill(0).map((_, i) => `https://a${i}.test`)]) {
      // Junk on purpose: this is what an untrusted package.json may carry.
      const result = parseManifest({ apiVersion: 1, contributes: { panel: validBlock.contributes.panel, origins: bad as string[] } });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('invalid-origins');
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

describe('contributes.tools', () => {
  const withTools = (tools: unknown) => parseManifest({
    apiVersion: 1,
    contributes: { panel: validBlock.contributes.panel, tools },
  });

  test('reads tool presentations as declared', () => {
    const tools = [
      { match: 'mcp.tasks.*', name: 'Tasks', icon: 'checkbox-circle', title: '{input.id}', output: 'table', columns: ['id', 'title', 'status'] },
      { match: 'jira_search', subtitle: '{input.query} ({output.total})', output: 'code', language: 'json' },
      { match: 'notes:read', output: 'markdown' },
      { match: 'plain' },
      { match: 'svg', icon: 'icons/tool.svg' },
    ];
    const result = withTools(tools);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.contributes.tools).toEqual(tools);
    }
  });

  test('rejects malformed tools as invalid-tools', () => {
    const cases: unknown[] = [
      [],
      [{}],
      [{ match: '' }],
      [{ match: '*' }],
      [{ match: 'mcp.*.search' }],
      [{ match: 'mcp jira' }],
      [{ match: 'a'.repeat(129) }],
      [{ match: 'x', name: '' }],
      [{ match: 'x', name: 'n'.repeat(41) }],
      [{ match: 'x', icon: 'https://x.test/icon.svg' }],
      [{ match: 'x', icon: '../icon.svg' }],
      [{ match: 'x', icon: 'icon.png' }],
      [{ match: 'x', title: 't'.repeat(201) }],
      [{ match: 'x', output: 'html' }],
      [{ match: 'x', output: 'text', language: 'json' }],
      [{ match: 'x', output: 'table' }],
      [{ match: 'x', output: 'json', columns: ['id'] }],
      [{ match: 'x', output: 'table', columns: [] }],
      [{ match: 'x', output: 'table', columns: new Array(17).fill('c') }],
      new Array(17).fill(null).map((_, index) => ({ match: `t-${index}` })),
    ];
    for (const tools of cases) {
      expect(withTools(tools)).toMatchObject({ ok: false, code: 'invalid-tools' });
    }
  });
});

describe('page-less extensions', () => {
  const pageless = { id: 'tools-only', name: 'Tools Only', icon: 'tools' };
  const withContributes = (extra: Partial<Omit<OpenChamberContributes, 'panel'>>) => parseManifest({
    apiVersion: 1,
    contributes: { panel: pageless, ...extra },
  });

  test('background entry enables actions, commands and granted APIs without a visible panel', () => {
    const result = withContributes({
      background: { entry: 'background/index.html' },
      actions: [{ id: 'inspect', label: 'Inspect', where: 'message', mode: 'background' }],
      commands: [{ name: 'task' }], attach: false,
      capabilities: ['files', 'model', 'sessions', 'prompt'], filesystem: ['~/notes/**'],
      service: { entry: 'service/main.js', runtime: 'host' },
      integration: { name: 'Tasks', description: 'Tasks', token: { apiOrigin: 'https://example.com' } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(hasGuestPage(result.manifest.contributes)).toBe(false);
    expect(result.manifest.contributes.background).toEqual({ entry: 'background/index.html' });
    expect(requestedGuestCapabilities(result.manifest.contributes)).toEqual(['prompt', 'sessions', 'files', 'model', 'service', 'network', 'filesystem']);
    expect(parseManifest({ ...validBlock, contributes: { ...validBlock.contributes, background: { entry: 'background/index.html' } } })).toMatchObject({ ok: true });
  });

  test('background-only packages reject visible surfaces and actions that would open a panel', () => {
    const visible: Partial<Omit<OpenChamberContributes, 'panel'>>[] = [
      { page: true }, { page: { entry: 'page.html' } }, { attach: true }, { attach: 'dialog' },
      { actions: [{ id: 'inspect', label: 'Inspect', where: 'message' }] },
      { actions: [{ id: 'inspect', label: 'Inspect', where: 'session', mode: 'open' }] },
    ];
    for (const extra of visible) {
      expect(withContributes({ ...extra, background: { entry: 'background/index.html' } })).toMatchObject({ ok: false, code: 'invalid-panel' });
    }
  });

  test('background entries must be package-local HTML', () => {
    for (const background of [{}, { entry: '' }, { entry: '../index.html' }, { entry: '/index.html' },
      { entry: 'https://example.com/index.html' }, { entry: 'background/main.js' }, { entry: 'a\\b.html' }]) {
      expect(parseManifestJson(JSON.stringify({ apiVersion: 1, contributes: { panel: pageless, background } })))
        .toMatchObject({ ok: false, code: 'invalid-background' });
    }
  });

  test('accepts a panel without entry that only declares tools', () => {
    const result = withContributes({ tools: [{ match: 'mcp.*', output: 'json' }] });
    expect(result).toEqual({
      ok: true,
      manifest: {
        apiVersion: 1,
        contributes: {
          panel: pageless,
          tools: [{ match: 'mcp.*', output: 'json' }],
        },
      },
    });
    if (result.ok) {
      expect(hasGuestPage(result.manifest.contributes)).toBe(false);
    }
    expect(withContributes({ attach: false, capabilities: [] })).toMatchObject({ ok: true });
    expect(hasGuestPage(validBlock.contributes)).toBe(true);
  });

  test('refuses every page-only contribution without entry as invalid-panel', () => {
    const cases: Partial<Omit<OpenChamberContributes, 'panel'>>[] = [
      { attach: true },
      { attach: 'panel' },
      { attach: 'dialog' },
      { attach: { mode: 'dialog', entry: 'panel/attach.html' } },
      { actions: [{ id: 'a', label: 'A', where: 'message' }] },
      { commands: [{ name: 'task' }] },
      { service: { entry: 'service/main.js', runtime: 'host' } },
      { integration: { name: 'X', description: 'Y', token: { apiOrigin: 'https://api.x.test' } } },
      { capabilities: ['prompt'] },
      { capabilities: ['sessions'] },
      { capabilities: ['files'] },
      { filesystem: ['~/.config/x/**'] },
    ];
    for (const extra of cases) {
      const result = withContributes({ ...extra, tools: [{ match: 'mcp.*' }] });
      expect(result).toMatchObject({ ok: false, code: 'invalid-panel' });
      if (!result.ok) {
        expect(result.message).toContain('needs panel.entry');
      }
    }
  });

  test('a service that provides the browser needs no panel or background entry', () => {
    const result = withContributes({
      service: { entry: 'service/main.js', runtime: 'host', provides: ['browser'] },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.contributes.service?.provides).toEqual(['browser']);
      expect(hasGuestPage(result.manifest.contributes)).toBe(false);
      expect(requestedGuestCapabilities(result.manifest.contributes)).toEqual(['service']);
    }
  });

  test('refuses an unknown or repeated provides role as invalid-service', () => {
    expect(withContributes({
      service: { entry: 'service/main.js', runtime: 'host', provides: ['browser', 'browser'] },
    })).toMatchObject({ ok: false, code: 'invalid-service' });
    expect(parseManifestJson(JSON.stringify({
      apiVersion: 1,
      contributes: { panel: pageless, service: { entry: 'service/main.js', runtime: 'host', provides: ['printer'] } },
    }))).toMatchObject({ ok: false, code: 'invalid-service' });
    expect(parseManifestJson(JSON.stringify({
      apiVersion: 1,
      contributes: { panel: pageless, service: { entry: 'service/main.js', runtime: 'host', provides: [] } },
    }))).toMatchObject({ ok: false, code: 'invalid-service' });
  });

  test('a surface service needs no panel entry; with one, panel.dock and panel.size place it', () => {
    const ok = withContributes({ service: { entry: 'service/main.js', runtime: 'host', surface: true } });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.manifest.contributes.service?.surface).toBe(true);

    const withStrip = parseManifest({
      apiVersion: 1,
      contributes: {
        panel: { ...pageless, entry: 'panel/index.html', dock: 'right', size: 240 },
        service: { entry: 'service/main.js', runtime: 'host', surface: true },
      },
    });
    expect(withStrip.ok).toBe(true);
    if (withStrip.ok) expect(withStrip.manifest.contributes.panel).toMatchObject({ dock: 'right', size: 240 });

    expect(parseManifest({
      apiVersion: 1,
      contributes: { panel: { ...pageless, entry: 'panel/index.html', dock: 'bottom' } },
    })).toMatchObject({ ok: false, code: 'invalid-panel' });
    expect(parseManifest({
      apiVersion: 1,
      contributes: {
        panel: { ...pageless, entry: 'panel/index.html', size: 8 },
        service: { entry: 'service/main.js', runtime: 'host', surface: true },
      },
    })).toMatchObject({ ok: false, code: 'invalid-panel' });

    expect(parseManifestJson(JSON.stringify({
      apiVersion: 1,
      contributes: { panel: pageless, service: { entry: 'service/main.js', runtime: 'host', surface: false } },
    }))).toMatchObject({ ok: false, code: 'invalid-service' });
  });

  test('still reports a malformed page-only field by its own code', () => {
    const bogusAttach = parseManifestJson(JSON.stringify({
      apiVersion: 1,
      contributes: { panel: pageless, attach: 'bogus' },
    }));
    expect(bogusAttach).toMatchObject({ ok: false, code: 'invalid-attach' });
    expect(withContributes({ commands: [] })).toMatchObject({ ok: false, code: 'invalid-commands' });
  });
});

describe('contributes.statusSection', () => {
  const pageless = { id: 'git-graph', name: 'Git graph', icon: 'git-commit' };
  const parse = (contributes: Record<string, unknown>) => parseManifestJson(JSON.stringify({ apiVersion: 1, contributes }));

  test('a status section alone is enough: no panel page, no rail icon', () => {
    const result = parse({ panel: pageless, statusSection: { entry: 'status/index.html', title: 'Recent commits', height: 160 } });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(hasGuestPage(result.manifest.contributes)).toBe(false);
    expect(resolveStatusSectionEntry(result.manifest.contributes)).toBe('status/index.html');
    expect(result.manifest.contributes.statusSection).toEqual({ entry: 'status/index.html', title: 'Recent commits', height: 160 });
  });

  test('the section frame may use a service and granted capabilities', () => {
    const result = parse({
      panel: pageless, statusSection: { entry: 'status/index.html' },
      service: { entry: 'service/main.js', runtime: 'host' }, capabilities: ['files'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(requestedGuestCapabilities(result.manifest.contributes)).toEqual(['files', 'service']);
  });

  test('true reuses panel.entry and needs one', () => {
    const result = parse({ panel: { ...pageless, entry: 'panel/index.html' }, statusSection: true });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(resolveStatusSectionEntry(result.manifest.contributes)).toBe('panel/index.html');
    expect(parse({ panel: pageless, statusSection: true })).toMatchObject({ ok: false, code: 'invalid-status-section' });
  });

  test('a status-only package cannot declare things that open or invoke another frame', () => {
    for (const extra of [
      { page: { entry: 'page.html' } }, { attach: 'dialog' }, { commands: [{ name: 'graph' }] },
      { actions: [{ id: 'inspect', label: 'Inspect', where: 'message', mode: 'background' }] },
    ]) {
      expect(parse({ panel: pageless, statusSection: { entry: 'status/index.html' }, ...extra })).toMatchObject({ ok: false, code: 'invalid-panel' });
    }
    expect(parse({
      panel: pageless, statusSection: { entry: 'status/index.html' }, background: { entry: 'background/index.html' },
      commands: [{ name: 'graph' }],
    })).toMatchObject({ ok: true });
  });

  test('refuses entries outside the package, non-HTML entries, and out-of-range sizes', () => {
    for (const statusSection of [false, {}, { entry: '../status.html' }, { entry: 'status/main.js' }, { entry: 'https://example.com/a.html' },
      { entry: 'status/index.html', height: 10 }, { entry: 'status/index.html', height: 400 }, { entry: 'status/index.html', height: 100.5 },
      { entry: 'status/index.html', title: '' }, { entry: 'status/index.html', title: 'x'.repeat(61) }]) {
      expect(parse({ panel: pageless, statusSection })).toMatchObject({ ok: false, code: 'invalid-status-section' });
    }
  });

  test('a source section is drawn by the host from the service, so it needs no frame', () => {
    const service = { entry: 'service/main.js', runtime: 'host' };
    const result = parse({ panel: pageless, statusSection: { source: { path: '/status' }, title: 'Resources' }, service });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(resolveStatusSectionEntry(result.manifest.contributes)).toBeNull();
    expect(resolveStatusSectionSource(result.manifest.contributes)).toEqual({ path: '/status', interval: 2000 });
    expect(requestedGuestCapabilities(result.manifest.contributes)).toEqual(['service']);
  });

  test('a section may carry both, so hosts without source support load the frame', () => {
    const result = parse({
      panel: pageless, service: { entry: 'service/main.js', runtime: 'host' },
      statusSection: { entry: 'status/index.html', source: { path: '/status', interval: 5000 } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(resolveStatusSectionEntry(result.manifest.contributes)).toBe('status/index.html');
    expect(resolveStatusSectionSource(result.manifest.contributes)).toEqual({ path: '/status', interval: 5000 });
  });

  test('a source needs a service, a request path and an interval in range', () => {
    expect(parse({ panel: pageless, statusSection: { source: { path: '/status' } } }))
      .toMatchObject({ ok: false, code: 'invalid-status-section' });
    const service = { entry: 'service/main.js', runtime: 'host' };
    for (const source of [{ path: 'status' }, { path: '/../x' }, { path: 'https://x.dev/s' }, { path: '/s', interval: 500 },
      { path: '/s', interval: 120_000 }, { path: '/s', interval: 1500.5 }, { path: '/s', every: 2000 }]) {
      expect(parse({ panel: pageless, statusSection: { source }, service })).toMatchObject({ ok: false, code: 'invalid-status-section' });
    }
  });

  test('without a frame, frame-only grants still need a panel or background entry', () => {
    expect(parse({
      panel: pageless, statusSection: { source: { path: '/status' } },
      service: { entry: 'service/main.js', runtime: 'host' }, capabilities: ['files'],
    })).toMatchObject({ ok: false, code: 'invalid-panel' });
  });

  test('clamps heights to the host range', () => {
    expect(clampStatusSectionHeight(5)).toBe(24);
    expect(clampStatusSectionHeight(200.4)).toBe(200);
    expect(clampStatusSectionHeight(5000)).toBe(320);
    expect(clampStatusSectionHeight(Number.NaN)).toBe(120);
  });
});

describe('contributes.sourceControl', () => {
  const sourceControl = {
    wire: 1,
    label: 'Teahouse',
    terminology: { changeRequest: 'pullRequest', ci: 'checks' },
    referencePrefix: { changeRequest: '#', issue: '#' },
    repositoryPath: 'owner/name',
    instances: {
      defaultInstances: ['https://tea.example.com'],
      custom: true,
      allowLoopbackHttp: true,
      allowPort: true,
      placeholder: 'https://tea.example.com',
    },
    capabilities: { projects: true, issues: true, changeRequests: true, merge: { methods: ['merge'] }, liveSummaries: true },
    token: { header: 'authorization', scheme: 'token', scopes: ['write:repository'], createPath: '/user/settings/applications' },
    transport: { httpsUsername: { kind: 'login' }, appendDotGitToHttpsClone: false },
    limits: { commentMaxLength: 65_536, reviewerId: 'numeric', labelsMax: 100, reviewersMax: 50 },
    trackedItems: { batchLimit: 50 },
    presentation: {
      abbreviation: 'PR',
      promptNoun: 'pull request',
      sharedNumberSpace: true,
      iconPath: 'M2 6h15v5.5z',
      urls: { changeRequest: ['/{owner}/{repo}/pulls/{number}'], issue: ['/{owner}/{repo}/issues/{number}'] },
      features: {},
      changeRequestTemplates: ['.gitea/pull_request_template.md'],
    },
  };
  const manifest = <T,>(contributes: T, id = 'teahouse') => parseManifestJson(JSON.stringify({
    apiVersion: 1,
    contributes: {
      panel: { id, name: 'Teahouse', icon: 'git-branch-line' },
      service: { entry: 'service/main.js', runtime: 'host', provides: ['source-control'] },
      sourceControl,
      ...contributes,
    },
  }));
  const withSourceControl = <T,>(patch: T) => manifest({ sourceControl: { ...sourceControl, ...patch } });

  test('a source-control service needs no panel entry, and capabilities left out are off', () => {
    const result = manifest({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = result.manifest.contributes.sourceControl;
    expect(parsed?.capabilities).toEqual({
      projects: true, issues: true, changeRequests: true, draftChangeRequests: false, merge: { methods: ['merge'] },
      ci: false, comments: false, reviews: false, state: false, labels: false, reviewers: false,
      changeRequestPatch: false, liveSummaries: true,
    });
    expect(parsed?.presentation.features).toEqual({ authorCanReview: false, issueCloseReason: false });
    expect(parsed && toPublicSourceControl(parsed)).toEqual({ label: 'Teahouse', defaultInstances: ['https://tea.example.com'], custom: true });
  });

  test('the role and the contribution come together', () => {
    const withoutContribution = parseManifestJson(JSON.stringify({
      apiVersion: 1,
      contributes: {
        panel: { id: 'teahouse', name: 'Teahouse', icon: 'window' },
        service: { entry: 'service/main.js', runtime: 'host', provides: ['source-control'] },
      },
    }));
    expect(withoutContribution).toMatchObject({ ok: false, code: 'invalid-service' });
    if (!withoutContribution.ok) expect(withoutContribution.message).toContain('come together');
    expect(manifest({ service: { entry: 'service/main.js', runtime: 'host', provides: ['browser'] } }))
      .toMatchObject({ ok: false, code: 'invalid-service' });
  });

  test('the guest id leaves room for the ext- prefix in a 32-character provider id', () => {
    expect(manifest({}, 'a'.repeat(28)).ok).toBe(true);
    const long = manifest({}, 'a'.repeat(29));
    expect(long).toMatchObject({ ok: false, code: 'invalid-service' });
    if (!long.ok) expect(long.message).toContain('ext-<panel.id>');
  });

  test('refuses unknown keys, bad origins and a token header that contradicts its scheme', () => {
    expect(withSourceControl({ id: 'gitea' })).toMatchObject({ ok: false, code: 'invalid-service' });
    expect(withSourceControl({ wire: 2 })).toMatchObject({ ok: false, code: 'invalid-service' });
    const instances = <T,>(patch: T) => withSourceControl({ instances: { ...sourceControl.instances, ...patch } });
    expect(instances({ defaultInstances: ['http://tea.example.com'] })).toMatchObject({ ok: false, code: 'invalid-service' });
    expect(instances({ defaultInstances: ['https://tea.example.com/sub'] })).toMatchObject({ ok: false, code: 'invalid-service' });
    expect(instances({ defaultInstances: ['https://a.example', 'https://b.example', 'https://c.example', 'https://d.example', 'https://e.example'] }))
      .toMatchObject({ ok: false, code: 'invalid-service' });
    expect(instances({ custom: false, defaultInstances: [] })).toMatchObject({ ok: false, code: 'invalid-service' });
    expect(instances({ custom: false }).ok).toBe(true);
    const token = <T,>(patch: T) => withSourceControl({ token: { ...sourceControl.token, ...patch } });
    expect(token({ header: 'private-token', scheme: 'none' }).ok).toBe(true);
    expect(token({ header: 'private-token', scheme: 'bearer' })).toMatchObject({ ok: false, code: 'invalid-service' });
    expect(token({ header: 'authorization', scheme: 'none' })).toMatchObject({ ok: false, code: 'invalid-service' });
    expect(withSourceControl({ capabilities: { ...sourceControl.capabilities, uploads: true } })).toMatchObject({ ok: false, code: 'invalid-service' });
    expect(withSourceControl({ trackedItems: { batchLimit: 51 } })).toMatchObject({ ok: false, code: 'invalid-service' });
    // Review threads stay off for an extension's Git host, so the flag is not declarable.
    expect(withSourceControl({ presentation: { ...sourceControl.presentation, features: { startThread: true } } }))
      .toMatchObject({ ok: false, code: 'invalid-service' });
    expect(withSourceControl({ presentation: { ...sourceControl.presentation, iconPath: '"/><script>' } }))
      .toMatchObject({ ok: false, code: 'invalid-service' });
    for (const template of ['../secrets.md', '/etc/passwd', '.github/./x.md']) {
      expect(withSourceControl({ presentation: { ...sourceControl.presentation, changeRequestTemplates: [template] } }))
        .toMatchObject({ ok: false, code: 'invalid-service' });
    }
  });

  test('a change-based host declares the change term, votes, revisions, submit and basic auth', () => {
    const result = withSourceControl({
      terminology: { changeRequest: 'change', ci: 'checks' },
      capabilities: { ...sourceControl.capabilities, reviews: true, merge: { methods: ['submit'] }, reviewModel: 'votes', revisions: true },
      token: { header: 'authorization', scheme: 'basic', username: true, scopes: [], createPath: '/settings/' },
      presentation: { ...sourceControl.presentation, features: { submitRequirements: true } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = result.manifest.contributes.sourceControl;
    expect(parsed?.terminology.changeRequest).toBe('change');
    expect(parsed?.capabilities).toMatchObject({ merge: { methods: ['submit'] }, reviewModel: 'votes', revisions: true });
    expect(parsed?.token).toMatchObject({ scheme: 'basic', username: true });
    expect(parsed?.presentation.features).toEqual({ authorCanReview: false, issueCloseReason: false, submitRequirements: true });
    expect(withSourceControl({ capabilities: { ...sourceControl.capabilities, reviewModel: 'stars' } })).toMatchObject({ ok: false, code: 'invalid-service' });
    expect(withSourceControl({ terminology: { changeRequest: 'patch', ci: 'checks' } })).toMatchObject({ ok: false, code: 'invalid-service' });
  });

  test('submit is the only merge method when present', () => {
    const merge = (methods: string[]) => withSourceControl({ capabilities: { ...sourceControl.capabilities, merge: { methods } } });
    expect(merge(['submit']).ok).toBe(true);
    for (const methods of [['submit', 'merge'], ['squash', 'submit'], ['submit', 'submit']]) {
      const result = merge(methods);
      expect(result).toMatchObject({ ok: false, code: 'invalid-service' });
      if (!result.ok) expect(result.message.startsWith('contributes.sourceControl.capabilities.merge')).toBe(true);
    }
  });

  test('the basic scheme needs a username field, and only basic takes one', () => {
    const token = <T,>(patch: T) => withSourceControl({ token: { ...sourceControl.token, ...patch } });
    expect(token({ scheme: 'basic', username: true }).ok).toBe(true);
    const missing = token({ scheme: 'basic' });
    expect(missing).toMatchObject({ ok: false, code: 'invalid-service' });
    if (!missing.ok) expect(missing.message.startsWith('contributes.sourceControl.token')).toBe(true);
    expect(token({ scheme: 'basic', username: false })).toMatchObject({ ok: false, code: 'invalid-service' });
    expect(token({ scheme: 'token', username: true })).toMatchObject({ ok: false, code: 'invalid-service' });
    expect(token({ header: 'private-token', scheme: 'basic', username: true })).toMatchObject({ ok: false, code: 'invalid-service' });
  });

  test('URL templates take only the known placeholders as whole segments, never a pattern', () => {
    const urls = (changeRequest: string[], repositoryPath = 'owner/name') => withSourceControl({
      repositoryPath,
      presentation: { ...sourceControl.presentation, urls: { changeRequest, issue: [] } },
    });
    expect(urls(['/{owner}/{repo}/pulls/{number}']).ok).toBe(true);
    expect(urls(['/{namespace+}/{repo}/-/merge_requests/{number}'], 'namespace/name').ok).toBe(true);
    for (const bad of [
      '{owner}/{repo}/pulls/{number}',
      '/{owner}/{repo}/pulls/(\\d+)',
      '/{owner}/{repo}/pulls/{id}',
      '/{owner}/{repo}/pulls/n{number}',
      '/{owner}/{repo}/pulls',
      '/{owner}/{repo}/{repo}/{number}',
      '/{namespace+}/{repo}/pulls/{number}',
      '/{owner}//{repo}/{number}',
    ]) {
      const result = urls([bad]);
      expect(result).toMatchObject({ ok: false, code: 'invalid-service' });
      if (!result.ok) expect(result.message).toContain('contributes.sourceControl');
    }
    expect(urls(['/{owner}/{repo}/pulls/{number}'], 'namespace/name')).toMatchObject({ ok: false, code: 'invalid-service' });
    // A normalized URL never has these segments, so such a template could never match.
    for (const dotted of ['/{owner}/{repo}/./pulls/{number}', '/{owner}/{repo}/../pulls/{number}']) {
      expect(urls([dotted])).toMatchObject({ ok: false, code: 'invalid-service' });
    }
  });

  test('refuses a template that is both a change request and an issue template', () => {
    const result = withSourceControl({
      presentation: {
        ...sourceControl.presentation,
        urls: { changeRequest: ['/{owner}/{repo}/items/{number}'], issue: ['/{owner}/{repo}/issues/{number}', '/{owner}/{repo}/items/{number}'] },
      },
    });
    expect(result).toMatchObject({ ok: false, code: 'invalid-service' });
    if (!result.ok) expect(result.message).toContain('contributes.sourceControl.presentation.urls.issue[1]');
  });

  test('names the field a refined value failed at', () => {
    const cases: Array<[object, string]> = [
      [{ instances: { ...sourceControl.instances, defaultInstances: ['https://git.example.com/'] } }, 'contributes.sourceControl.instances.defaultInstances[0]'],
      [{ token: { ...sourceControl.token, createPath: '/a/../b' } }, 'contributes.sourceControl.token.createPath'],
      [{ presentation: { ...sourceControl.presentation, changeRequestTemplates: ['ok.md', '../x.md'] } }, 'contributes.sourceControl.presentation.changeRequestTemplates[1]'],
      [{ presentation: { ...sourceControl.presentation, urls: { changeRequest: ['/{owner}/{repo}'], issue: [] } } }, 'contributes.sourceControl.presentation.urls.changeRequest[0]'],
      [{ wire: 2 }, 'contributes.sourceControl.wire'],
    ];
    for (const [patch, field] of cases) {
      const result = withSourceControl(patch);
      expect(result).toMatchObject({ ok: false, code: 'invalid-service' });
      if (!result.ok) expect(result.message.startsWith(field)).toBe(true);
    }
  });
});

describe('contributes.sessionEvents', () => {
  const pageless = { id: 'acme-events', name: 'Events', icon: 'window' };
  const service = { entry: 'service/main.js', runtime: 'host' };
  const parse = <T,>(contributes: T) => parseManifestJson(JSON.stringify({ apiVersion: OPENCHAMBER_SDK_API_VERSION, contributes }));

  test('a service-only package may subscribe to events and asks for transcript only with content', () => {
    const result = parse({ panel: pageless, service, sessionEvents: { events: ['turn-finished', 'question-asked'] } });
    expect(result).toMatchObject({ ok: true, manifest: { contributes: { sessionEvents: { events: ['turn-finished', 'question-asked'] } } } });
    if (!result.ok) throw new Error(result.message);
    expect(requestedGuestCapabilities(result.manifest.contributes)).toEqual(['service']);
    expect(toPublicSessionEvents(result.manifest.contributes.sessionEvents!)).toEqual({ events: ['turn-finished', 'question-asked'], content: false });

    const withContent = parse({ panel: pageless, service, sessionEvents: { events: ['turn-finished'], content: true } });
    if (!withContent.ok) throw new Error(withContent.message);
    expect(requestedGuestCapabilities(withContent.manifest.contributes)).toEqual(['service', 'transcript']);
    expect(toPublicSessionEvents(withContent.manifest.contributes.sessionEvents!)).toEqual({ events: ['turn-finished'], content: true });
  });

  test('needs contributes.service, and its fields are checked', () => {
    expect(parse({ panel: pageless, sessionEvents: { events: ['turn-finished'] } })).toMatchObject({
      ok: false, code: 'invalid-session-events', message: expect.stringContaining('declare contributes.service'),
    });
    expect(parse({ panel: pageless, service, sessionEvents: { events: [] } })).toMatchObject({ ok: false, code: 'invalid-session-events' });
    expect(parse({ panel: pageless, service, sessionEvents: { events: ['turn-finished', 'turn-finished'] } })).toMatchObject({ ok: false, code: 'invalid-session-events' });
    expect(parse({ panel: pageless, service, sessionEvents: { events: ['turn-aborted'] } })).toMatchObject({ ok: false, code: 'invalid-session-events' });
    expect(parse({ panel: pageless, service, sessionEvents: { events: ['turn-finished'], content: false } })).toMatchObject({ ok: false, code: 'invalid-session-events' });
    expect(parse({ panel: pageless, service, sessionEvents: { events: ['turn-finished'], projects: ['/repo'] } })).toMatchObject({ ok: false, code: 'invalid-session-events' });
    expect(parse({ panel: pageless, service, sessionEvents: ['turn-finished'] })).toMatchObject({ ok: false, code: 'invalid-session-events' });
  });

  test('a subscribing service beside a panel keeps the panel\'s other contributions', () => {
    const result = parse({ panel: { ...pageless, entry: 'panel/index.html' }, service, sessionEvents: { events: ['turn-failed'] }, capabilities: ['files'] });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(result.message);
    expect(requestedGuestCapabilities(result.manifest.contributes)).toEqual(['files', 'service']);
  });
});

describe('contributes.notifications', () => {
  const pageless = { id: 'slack-bridge', name: 'Slack Bridge', icon: 'notification-3' };
  const role = { entry: 'service/main.js', runtime: 'host', provides: ['notifications'] };
  const channel = {
    label: 'Slack',
    instances: { kind: 'fixed', origin: 'https://slack.com' },
    token: { header: 'authorization', scheme: 'bearer', scopes: ['chat:write'], createPath: '/apps' },
  };
  const parse = <T,>(contributes: T) => parseManifestJson(JSON.stringify({ apiVersion: OPENCHAMBER_SDK_API_VERSION, contributes }));

  test('the role and the contribution come together and name a channel OpenChamber can draw without the service', () => {
    const result = parse({ panel: pageless, service: role, notifications: channel });
    expect(result).toMatchObject({ ok: true, manifest: { contributes: { notifications: channel } } });
    if (!result.ok) throw new Error(result.message);
    expect(requestedGuestCapabilities(result.manifest.contributes)).toEqual(['service']);
    expect(toPublicNotifications(result.manifest.contributes.notifications!)).toEqual({
      label: 'Slack', instances: { kind: 'fixed', origin: 'https://slack.com' }, token: { scheme: 'bearer', username: false, scopes: ['chat:write'], createPath: '/apps' },
    });
    const typed = parse({ panel: pageless, service: role, notifications: { ...channel, instances: { kind: 'user', label: 'Homeserver', placeholder: 'https://matrix.example.org' } } });
    expect(typed).toMatchObject({ ok: true });

    expect(parse({ panel: pageless, service: role })).toMatchObject({ ok: false, code: 'invalid-service', message: expect.stringContaining('come together') });
    expect(parse({ panel: pageless, service: { ...role, provides: undefined }, notifications: channel })).toMatchObject({ ok: false, code: 'invalid-service' });
    expect(parse({ panel: { ...pageless, id: 'a'.repeat(29) }, service: role, notifications: channel })).toMatchObject({ ok: false, code: 'invalid-service', message: expect.stringContaining('28') });
  });

  test('its fields are checked and named', () => {
    const withChannel = <T,>(patch: T) => parse({ panel: pageless, service: role, notifications: { ...channel, ...patch } });
    expect(withChannel({ instances: { kind: 'fixed', origin: 'http://slack.com' } })).toMatchObject({ ok: false, code: 'invalid-service', message: expect.stringContaining('contributes.notifications.instances') });
    expect(withChannel({ instances: { kind: 'fixed', origin: 'https://slack.com/api' } })).toMatchObject({ ok: false, code: 'invalid-service' });
    expect(withChannel({ instances: { kind: 'user' } })).toMatchObject({ ok: false, code: 'invalid-service' });
    expect(withChannel({ token: { header: 'private-token', scheme: 'bearer' } })).toMatchObject({ ok: false, code: 'invalid-service' });
    expect(withChannel({ token: { header: 'authorization', scheme: 'basic' } })).toMatchObject({ ok: false, code: 'invalid-service' });
    expect(withChannel({ token: { header: 'authorization', scheme: 'basic', username: true } })).toMatchObject({ ok: true });
    expect(withChannel({ label: '' })).toMatchObject({ ok: false, code: 'invalid-service' });
    expect(withChannel({ extra: 1 })).toMatchObject({ ok: false, code: 'invalid-service' });
  });
});
