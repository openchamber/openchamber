import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkspaceSessionRouteStore } from './session-routes.js';

const store = () => new WorkspaceSessionRouteStore({ rootDirectory: fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-session-routes-')) });

describe('WorkspaceSessionRouteStore', () => {
  it('records and rereads a route, replacing an earlier record of the same session', async () => {
    const routes = store();
    await routes.record({ sessionID: 'ses_1234', workspaceID: 'wrk_1234', projectDirectory: 'C:/projects/app' });
    await routes.record({ sessionID: 'ses_1234', workspaceID: 'wrk_5678', projectDirectory: 'C:/projects/app' });
    const read = await routes.routes();
    expect(read).toEqual([expect.objectContaining({ sessionID: 'ses_1234', workspaceID: 'wrk_5678', projectDirectory: 'C:/projects/app' })]);
  });

  it('rejects malformed identifiers before touching storage', async () => {
    const routes = store();
    await expect(routes.record({ sessionID: '../escape', workspaceID: 'wrk_1234', projectDirectory: '/p' })).rejects.toThrow('sessionID');
    await expect(routes.record({ sessionID: 'ses_1234', workspaceID: 'no spaces', projectDirectory: '/p' })).rejects.toThrow('workspaceID');
    await expect(routes.record({ sessionID: 'ses_1234', workspaceID: 'wrk_1234', projectDirectory: '' })).rejects.toThrow('directory');
    expect(await routes.routes()).toEqual([]);
  });

  it('reads a corrupt file as empty rather than failing the caller', async () => {
    const routes = store();
    await routes.record({ sessionID: 'ses_1234', workspaceID: 'wrk_1234', projectDirectory: '/p' });
    fs.writeFileSync(path.join(routes.rootDirectory, 'session-routes.json'), '{not json');
    expect(await routes.routes()).toEqual([]);
  });

  it('drops the oldest routes past the bound', async () => {
    const routes = new WorkspaceSessionRouteStore({ rootDirectory: fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-session-routes-')), maxRoutes: 5 });
    for (let index = 0; index < 7; index += 1) {
      await routes.record({ sessionID: `ses_${String(index).padStart(4, '0')}`, workspaceID: 'wrk_1234', projectDirectory: '/p' });
    }
    const read = await routes.routes();
    expect(read).toHaveLength(5);
    expect(read[0].sessionID).toBe('ses_0002');
  });
});
