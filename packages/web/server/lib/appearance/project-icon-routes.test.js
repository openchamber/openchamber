import { describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import path from 'path';

import { registerProjectIconRoutes } from './project-icon-routes.js';

const createRouteRegistry = () => {
  const routes = new Map();

  return {
    app: {
      get(routePath, handler) {
        routes.set(`GET ${routePath}`, handler);
      },
      post(routePath, handler) {
        routes.set(`POST ${routePath}`, handler);
      },
      put(routePath, handler) {
        routes.set(`PUT ${routePath}`, handler);
      },
      delete(routePath, handler) {
        routes.set(`DELETE ${routePath}`, handler);
      },
    },
    getRoute(method, routePath) {
      return routes.get(`${method} ${routePath}`);
    },
  };
};

const createMockResponse = () => {
  const headers = new Map();
  let statusCode = 200;
  let body = null;

  return {
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
    },
    getHeader(name) {
      return headers.get(name.toLowerCase());
    },
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
    send(payload) {
      body = payload;
      return this;
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
  };
};

describe('project icon routes', () => {
  it('uses fallback file extension MIME when metadata points to a missing icon', async () => {
    const { app, getRoute } = createRouteRegistry();
    const jpgBytes = Buffer.from('jpg-bytes');
    const enoent = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const fsPromises = {
      readFile: vi.fn(async (iconPath) => {
        if (iconPath.endsWith('.jpg')) {
          return jpgBytes;
        }
        throw enoent;
      }),
    };

    registerProjectIconRoutes(app, {
      fsPromises,
      path,
      crypto,
      openchamberDataDir: '/tmp/openchamber-test',
      sanitizeProjects: (projects) => projects,
      readSettingsFromDiskMigrated: async () => ({
        projects: [{
          id: 'proj-1',
          path: '/repo',
          iconImage: { mime: 'image/png', updatedAt: 1, source: 'custom' },
        }],
      }),
      persistSettings: async () => ({}),
      createFsSearchRuntime: () => ({ searchFilesystemFiles: async () => [] }),
      spawn: vi.fn(),
      resolveGitBinaryForSpawn: vi.fn(),
    });

    const res = createMockResponse();
    await getRoute('GET', '/api/projects/:projectId/icon')({
      params: { projectId: 'proj-1' },
      query: {},
    }, res);

    expect(res.statusCode).toBe(200);
    expect(res.getHeader('Content-Type')).toBe('image/jpeg');
    expect(res.body).toBe(jpgBytes);
    // A repository icon opened as a page must stay inert.
    expect(res.getHeader('Content-Security-Policy')).toContain('sandbox');
    expect(res.getHeader('X-Content-Type-Options')).toBe('nosniff');
  });

  it('discovers a favicon at a Windows project root', async () => {
    const { app, getRoute } = createRouteRegistry();
    const svgBytes = Buffer.from('svg-bytes');
    const fsPromises = {
      readFile: vi.fn(async () => svgBytes),
      mkdir: vi.fn(async () => {}),
      writeFile: vi.fn(async () => {}),
      unlink: vi.fn(async () => {}),
    };

    registerProjectIconRoutes(app, {
      fsPromises,
      path,
      crypto,
      openchamberDataDir: '/tmp/openchamber-test',
      sanitizeProjects: (projects) => projects,
      readSettingsFromDiskMigrated: async () => ({
        projects: [{ id: 'proj-1', path: 'C:\\repo' }],
      }),
      persistResolvedSettings: async () => ({ projects: [] }),
      createFsSearchRuntime: () => ({
        searchFilesystemFiles: async () => [
          {
            name: 'favicon.svg',
            path: 'C:\\repo\\favicon.svg',
            relativePath: 'favicon.svg',
            extension: 'svg',
          },
        ],
      }),
      spawn: vi.fn(),
      resolveGitBinaryForSpawn: vi.fn(),
    });

    const res = createMockResponse();
    await getRoute('POST', '/api/projects/:projectId/icon/discover')({
      params: { projectId: 'proj-1' },
      body: {},
    }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.discoveredPath).toBe('C:\\repo\\favicon.svg');
  });

  it('keeps a project added while the favicon search runs', async () => {
    const { app, getRoute } = createRouteRegistry();
    const original = { id: 'proj-1', path: '/repo' };
    const addedDuringSearch = { id: 'proj-2', path: '/other' };
    let saved = { projects: [original] };

    registerProjectIconRoutes(app, {
      fsPromises: {
        readFile: vi.fn(async () => Buffer.from('svg-bytes')),
        mkdir: vi.fn(async () => {}),
        writeFile: vi.fn(async () => {}),
        unlink: vi.fn(async () => {}),
      },
      path,
      crypto,
      openchamberDataDir: '/tmp/openchamber-test',
      sanitizeProjects: (projects) => projects,
      readSettingsFromDiskMigrated: async () => saved,
      persistResolvedSettings: async (resolveChanges) => {
        saved = { ...saved, ...resolveChanges(saved) };
        return saved;
      },
      createFsSearchRuntime: () => ({
        searchFilesystemFiles: async () => {
          saved = { projects: [original, addedDuringSearch] };
          return [{ name: 'favicon.svg', path: '/repo/favicon.svg', relativePath: 'favicon.svg', extension: 'svg' }];
        },
      }),
      spawn: vi.fn(),
      resolveGitBinaryForSpawn: vi.fn(),
    });

    const res = createMockResponse();
    await getRoute('POST', '/api/projects/:projectId/icon/discover')({
      params: { projectId: 'proj-1' },
      body: {},
    }, res);

    expect(res.statusCode).toBe(200);
    expect(saved.projects.map((entry) => entry.id)).toEqual(['proj-1', 'proj-2']);
    expect(saved.projects[0].iconImage?.source).toBe('auto');
  });

  it('keeps an icon the user chose while the favicon search runs', async () => {
    const { app, getRoute } = createRouteRegistry();
    const chosen = { mime: 'image/png', updatedAt: 1, source: 'custom' };
    let saved = { projects: [{ id: 'proj-1', path: '/repo' }] };
    const writeFile = vi.fn(async () => {});
    const persistResolvedSettings = vi.fn(async () => saved);

    registerProjectIconRoutes(app, {
      fsPromises: {
        readFile: vi.fn(async () => Buffer.from('svg-bytes')),
        mkdir: vi.fn(async () => {}),
        writeFile,
        unlink: vi.fn(async () => {}),
      },
      path,
      crypto,
      openchamberDataDir: '/tmp/openchamber-test',
      sanitizeProjects: (projects) => projects,
      readSettingsFromDiskMigrated: async () => saved,
      persistResolvedSettings,
      createFsSearchRuntime: () => ({
        searchFilesystemFiles: async () => {
          saved = { projects: [{ id: 'proj-1', path: '/repo', iconImage: chosen }] };
          return [{ name: 'favicon.svg', path: '/repo/favicon.svg', relativePath: 'favicon.svg', extension: 'svg' }];
        },
      }),
      spawn: vi.fn(),
      resolveGitBinaryForSpawn: vi.fn(),
    });

    const res = createMockResponse();
    await getRoute('POST', '/api/projects/:projectId/icon/discover')({
      params: { projectId: 'proj-1' },
      body: {},
    }, res);

    expect(res.body.reason).toBe('custom-icon-present');
    expect(writeFile).not.toHaveBeenCalled();
    expect(persistResolvedSettings).not.toHaveBeenCalled();
  });

  it('filters out hidden or test directories and prioritizes public/ assets', async () => {
    const { app, getRoute } = createRouteRegistry();
    const icoBytes = Buffer.from('ico-bytes');
    const fsPromises = {
      readFile: vi.fn(async () => icoBytes),
      mkdir: vi.fn(async () => {}),
      writeFile: vi.fn(async () => {}),
      unlink: vi.fn(async () => {}),
    };
    let capturedSearchOptions = null;

    registerProjectIconRoutes(app, {
      fsPromises,
      path,
      crypto,
      openchamberDataDir: '/tmp/openchamber-test',
      sanitizeProjects: (projects) => projects,
      readSettingsFromDiskMigrated: async () => ({
        projects: [{ id: 'proj-1', path: '/repo' }],
      }),
      persistResolvedSettings: async () => ({ projects: [] }),
      createFsSearchRuntime: () => ({
        searchFilesystemFiles: async (_root, options) => {
          capturedSearchOptions = options;
          return [
            {
              name: 'favicon.ico',
              path: '/repo/.local/dep/favicon.ico',
              relativePath: '.local/dep/favicon.ico',
              extension: 'ico',
            },
            {
              name: 'favicon.ico',
              path: '/repo/tests/fixtures/favicon.ico',
              relativePath: 'tests/fixtures/favicon.ico',
              extension: 'ico',
            },
            {
              name: 'favicon.ico',
              path: '/repo/web/public/icons/favicon.ico',
              relativePath: 'web/public/icons/favicon.ico',
              extension: 'ico',
            },
          ];
        },
      }),
      spawn: vi.fn(),
      resolveGitBinaryForSpawn: vi.fn(),
    });

    const res = createMockResponse();
    await getRoute('POST', '/api/projects/:projectId/icon/discover')({
      params: { projectId: 'proj-1' },
      body: {},
    }, res);

    expect(res.statusCode).toBe(200);
    expect(capturedSearchOptions).toEqual({
      limit: 200,
      query: 'favicon',
      includeHidden: false,
      respectGitignore: true,
    });
    expect(res.body.discoveredPath).toBe('/repo/web/public/icons/favicon.ico');
  });

  it('prefers svg over ico format in the same directory', async () => {
    const { app, getRoute } = createRouteRegistry();
    const svgBytes = Buffer.from('svg-bytes');
    const fsPromises = {
      readFile: vi.fn(async () => svgBytes),
      mkdir: vi.fn(async () => {}),
      writeFile: vi.fn(async () => {}),
      unlink: vi.fn(async () => {}),
    };

    registerProjectIconRoutes(app, {
      fsPromises,
      path,
      crypto,
      openchamberDataDir: '/tmp/openchamber-test',
      sanitizeProjects: (projects) => projects,
      readSettingsFromDiskMigrated: async () => ({
        projects: [{ id: 'proj-1', path: '/repo' }],
      }),
      persistResolvedSettings: async () => ({ projects: [] }),
      createFsSearchRuntime: () => ({
        searchFilesystemFiles: async () => [
          {
            name: 'favicon.ico',
            path: '/repo/public/favicon.ico',
            relativePath: 'public/favicon.ico',
            extension: 'ico',
          },
          {
            name: 'favicon.svg',
            path: '/repo/public/favicon.svg',
            relativePath: 'public/favicon.svg',
            extension: 'svg',
          },
        ],
      }),
      spawn: vi.fn(),
      resolveGitBinaryForSpawn: vi.fn(),
    });

    const res = createMockResponse();
    await getRoute('POST', '/api/projects/:projectId/icon/discover')({
      params: { projectId: 'proj-1' },
      body: {},
    }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.discoveredPath).toBe('/repo/public/favicon.svg');
  });
});
