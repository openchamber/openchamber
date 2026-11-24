import { describe, expect, it } from 'vitest';

import { registerProjectSetupRoutes } from './routes.js';
import { actionPlatformOf } from './project-setup.js';

describe('project config route', () => {
  it('tells the client which OS its actions run on, the server\'s own', async () => {
    const handlers = new Map();
    const app = { get: (route, handler) => handlers.set(`GET ${route}`, handler), put: (route, handler) => handlers.set(`PUT ${route}`, handler) };
    registerProjectSetupRoutes(app, { projectConfigRuntime: { readProjectSetup: async () => ({ projectActions: [] }) } });
    const response = { status() { return this; }, json(body) { this.body = body; return this; } };
    await handlers.get('GET /api/projects/:projectId/config')({ params: { projectId: 'p' } }, response);
    expect(response.body).toEqual({ projectActions: [], platform: actionPlatformOf(process.platform) ?? null });
    expect([actionPlatformOf('darwin'), actionPlatformOf('win32'), actionPlatformOf('linux'), actionPlatformOf('freebsd')]).toEqual(['macos', 'windows', 'linux', undefined]);
  });
});
