import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEnvironmentStore } from '../environment/store.js';
import { createEnvironmentActions, ENVIRONMENT_ACTION_DEFINITIONS } from './environment-actions.js';

const REFERENCE = 'op://Vertex SRE/github_token/credential';

describe('environment actions', () => {
  let root;
  let store;
  let runtime;
  let actions;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-environment-actions-'));
    store = createEnvironmentStore({ filePath: path.join(root, 'environment.json') });
    runtime = { vaultStatus: vi.fn(() => ({ GITHUB_TOKEN: { state: 'resolved', at: 1 } })), invalidateProject: vi.fn() };
    actions = createEnvironmentActions({ store, runtime, listProjects: async () => [{ id: 'path_project', path: '/repo' }] });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('lists the actions it serves', () => {
    expect(actions.actions).toEqual(ENVIRONMENT_ACTION_DEFINITIONS.map(({ action }) => action));
  });

  it('shows names and vault references, and never a plain value', async () => {
    await store.updateUser({ variables: { API_TOKEN: 'plain-secret', GITHUB_TOKEN: REFERENCE } });
    const result = await actions.execute('environment.get', {});
    expect(result).toEqual({
      names: ['API_TOKEN', 'GITHUB_TOKEN'],
      references: { GITHUB_TOKEN: REFERENCE },
      vault: { GITHUB_TOKEN: { state: 'resolved', at: 1 } },
    });
    expect(JSON.stringify(result)).not.toContain('plain-secret');
  });

  it('does not invent a vault status for a prototype-named variable (#2311)', async () => {
    await store.updateUser({ variables: { constructor: REFERENCE } });
    const result = await actions.execute('environment.get', {});
    expect(result.references).toEqual({ constructor: REFERENCE });
    // vaultStatus returned no entry for it: the inherited Object.prototype
    // member must not be reported as its vault status.
    expect(result.vault).toEqual({});
  });

  it('sets a vault reference or removes a variable, and refuses a plain value without saving anything', async () => {
    await store.updateUser({ variables: { OLD: 'x' } });
    await expect(actions.execute('environment.set', { environmentVariables: { GITHUB_TOKEN: REFERENCE, OLD: null } }))
      .resolves.toMatchObject({ names: ['GITHUB_TOKEN'], references: { GITHUB_TOKEN: REFERENCE } });

    await expect(actions.execute('environment.set', { environmentVariables: { NPM_TOKEN: 'npm_plain', OTHER: REFERENCE } }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/^Nothing was saved\. NPM_TOKEN: only a vault reference/) });
    expect(store.describeUser().names).toEqual(['GITHUB_TOKEN']);
  });

  it('works on a configured project and forgets what the runtime kept for it', async () => {
    await actions.execute('environment.set', { projectId: 'path_project', environmentVariables: { DB_URL: 'op://Dev/db/url' } });
    expect(runtime.invalidateProject).toHaveBeenCalledWith('path_project');
    await expect(actions.execute('environment.get', { projectId: 'path_project' }))
      .resolves.toMatchObject({ projectId: 'path_project', references: { DB_URL: 'op://Dev/db/url' } });
    await expect(actions.execute('environment.get', { projectId: 'nope' })).rejects.toMatchObject({ statusCode: 404 });
  });
});
