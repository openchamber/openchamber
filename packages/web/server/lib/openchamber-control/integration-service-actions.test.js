import { describe, expect, it, vi } from 'vitest';

import { registerGitLabRoutes } from '../gitlab/routes.js';
import { OpenChamberControlError } from './error.js';
import {
  INTEGRATION_SERVICE_ACTION_DEFINITIONS,
  INTEGRATION_SERVICE_PARAMETERS,
  createIntegrationServiceActions,
} from './integration-service-actions.js';

const SEED = 'SEEDED-TOKEN-7f3a91c2';
const GITLAB = 'https://gitlab.example.com';

const expectError = async (promise, status, pattern) => {
  const error = await promise.then(() => null, (caught) => caught);
  expect(error).toBeInstanceOf(OpenChamberControlError);
  expect(error.statusCode).toBe(status);
  if (pattern) expect(error.message).toMatch(pattern);
};

/** Operations shaped like the route modules return them; every answer carries the seeded token under secret-named keys. */
const makeOperations = () => {
  const leak = { accessToken: SEED, refreshToken: SEED, token: SEED, clientSecret: SEED, password: SEED, apiKey: SEED, api_key: SEED, cookie: SEED, authorization: SEED, authorizations: SEED, privateKey: SEED, accessKey: SEED, sshKey: SEED, licenseKey: SEED, private_key: SEED, key: SEED, privateKeys: SEED, accessKeys: SEED, apiKeys: SEED, tokens: SEED, secrets: SEED, passwords: SEED, keys: SEED, cookies: SEED };
  const ok = (body) => ({ status: 200, body: { ...body, ...leak } });
  const guest = {
    id: 'acme', name: 'Acme', version: '1.0.0', source: 'git', enabled: true,
    integration: { name: 'Acme', auth: 'token', apiToken: SEED },
    capabilities: { requested: ['network'], granted: ['network'] },
    enterpriseBlocked: [],
  };
  return {
    github: {
      status: vi.fn(async () => ({ connected: true, tokenType: 'bearer', scope: 'repo', accounts: [{ id: 'occred:v1:github:a', current: true, ...leak }], ghCli: { available: true, token: SEED } })),
      activate: vi.fn(async (accountId) => (accountId === 'missing' ? { status: 404, body: { error: 'GitHub account not found' } } : ok({ connected: true }))),
      addFromVault: vi.fn(async (reference) => ok({ connected: true, accounts: [{ id: 'occred:v1:github:b', tokenReference: reference }] })),
      remove: vi.fn(async () => ok({ success: true, removed: true })),
      setCliDisabled: vi.fn(async (disabled) => ({ disabled, ...leak })),
    },
    gitlab: {
      listInstances: vi.fn(async () => [GITLAB]),
      status: vi.fn(async (instance) => ({ provider: 'gitlab', instance, connected: true, accounts: [{ id: `${instance}#1`, ...leak }] })),
      activate: vi.fn(async () => ok({ connected: true })),
      addFromVault: vi.fn(async () => ok({ connected: true })),
      remove: vi.fn(async () => ok({ removed: true })),
      setCliDisabled: vi.fn(async (_instance, disabled) => ({ available: false, disabled, ...leak })),
    },
    linear: {
      status: vi.fn(async () => ({ connected: true, workspaces: [{ id: 'org-1', current: true, ...leak }] })),
      activate: vi.fn(async () => ok({ connected: true })),
      disconnect: vi.fn(async () => ({ success: true, removed: true, ...leak })),
      readMapping: vi.fn(async () => ok({ connected: true, defaultProjectPath: '/p' })),
      writeMapping: vi.fn(async (mapping) => ok({ connected: true, ...mapping })),
      readPreferences: vi.fn(async () => ({ sessionComments: false, ...leak })),
      writePreferences: vi.fn(async (sessionComments) => ok({ sessionComments })),
    },
    bindings: {
      read: vi.fn(async (directory) => ({ directory, revision: 2, binding: { remotes: [{ credentialId: 'ocgit:v2:x', ...leak }] } })),
      setProvider: vi.fn(async (intent) => ({ applied: 'provider', intent, ...leak })),
      setTransport: vi.fn(async (intent) => ({ applied: 'transport', intent, ...leak })),
      removeTransport: vi.fn(async (intent) => ({ applied: 'transport-remove', intent, ...leak })),
      setAuxiliary: vi.fn(async (intent) => ({ applied: 'auxiliary', intent, ...leak })),
      reset: vi.fn(async (intent) => ({ applied: 'reset', intent, ...leak })),
    },
    extensions: {
      list: vi.fn(async () => ({ guests: [{ ...guest, ...leak }] })),
      authStatus: vi.fn(async (id) => (id === 'acme' ? ok({ connected: true, account: 'me', settings: {} }) : { status: 404, body: { error: 'not-found' } })),
      setEnabled: vi.fn(async (id, { enabled }) => (id === 'acme' ? ok({ guest: { ...guest, enabled, ...leak } }) : { status: 404, body: { error: 'not-found' } })),
      saveSettings: vi.fn(async (_id, values) => ok({ connected: true, settings: values })),
      disconnect: vi.fn(async () => ok({ connected: false })),
    },
  };
};

const setup = () => {
  const ops = makeOperations();
  const actions = createIntegrationServiceActions({ getIntegrationOperations: () => ops });
  const ctx = { contextDirectory: '/work/repo' };
  return { ops, actions, ctx, run: (action, input = {}) => actions.execute(action, input, ctx) };
};

/** A valid call for every action, with confirm where it is needed. */
const VALID_CALLS = {
  'integrations.list': {},
  'github.status': {},
  'github.activate': { accountId: 'occred:v1:github:a' },
  'github.addFromVault': { tokenReference: 'op://Vertex SRE/github_token/credential' },
  'github.remove': { accountId: 'occred:v1:github:a', confirm: true },
  'github.cli': { disabled: true },
  'gitlab.status': {},
  'gitlab.activate': { instance: GITLAB, accountId: `${GITLAB}#1` },
  'gitlab.addFromVault': { instance: GITLAB, tokenReference: 'op://Vertex SRE/gitlab_token/credential' },
  'gitlab.remove': { instance: GITLAB, accountId: `${GITLAB}#1`, confirm: true },
  'gitlab.cli': { instance: GITLAB, disabled: false },
  'linear.status': {},
  'linear.activate': { workspaceId: 'org-1' },
  'linear.disconnect': { confirm: true },
  'linear.mapping': { linearMapping: { defaultProjectPath: '/p', teamProjectPaths: {} } },
  'linear.preferences': { sessionComments: true },
  'binding.get': {},
  'binding.set': { bindingOperation: 'transport', bindingIntent: { remoteName: 'origin' }, confirm: true },
  'extensions.list': {},
  'extensions.get': { extensionId: 'acme' },
  'extensions.toggle': { extensionId: 'acme', disabled: true },
  'extensions.settings': { extensionId: 'acme', extensionSettings: { region: 'eu' } },
  'extensions.disconnect': { extensionId: 'acme', confirm: true },
};

describe('integration service action contract', () => {
  it('declares every action it runs, each with a valid call in this suite', () => {
    const { actions } = setup();
    const declared = INTEGRATION_SERVICE_ACTION_DEFINITIONS.map(({ action }) => action);
    expect(actions.actions).toEqual(declared);
    expect(Object.keys(VALID_CALLS).sort()).toEqual([...declared].sort());
  });

  it('declares every parameter the actions read', () => {
    for (const name of ['accountId', 'instance', 'workspaceId', 'linearMapping', 'sessionComments', 'bindingOperation', 'bindingIntent', 'extensionId', 'extensionSettings']) {
      expect(INTEGRATION_SERVICE_PARAMETERS).toHaveProperty(name);
    }
  });

  it('names every field the binding operations consume in the bindingIntent schema', () => {
    // The binding service (source-control/binding-service.js) validates each
    // operation's intent by exact key set; a field missing here is a field a
    // model cannot learn from the schema, and a field named here that no
    // operation takes is refused as an extra key.
    const intent = INTEGRATION_SERVICE_PARAMETERS.bindingIntent;
    const fields = [
      'directory', 'expectedRepositoryId', 'expectedRevision', 'expectedConfigRevision',
      'operation', 'target', 'provider', 'remote', 'transport',
      'expectedFetchFingerprint', 'expectedPushFingerprint', 'unverifiedConfirmed',
      'credentialAccount', 'sshCredentialId', 'parentRemote', 'expectedParentFingerprint',
      'kind', 'path', 'expectedEndpointFingerprint', 'confirmed',
    ];
    for (const name of fields) expect(intent.properties).toHaveProperty(name);
    expect(Object.keys(intent.properties).sort()).toEqual([...fields].sort());
    // Only the revisions every operation takes are unconditionally required:
    // provider rejects expectedConfigRevision as an extra key.
    expect(intent.required).toEqual(['expectedRepositoryId', 'expectedRevision']);
    expect(intent.properties.expectedRevision.type).toBe('integer');
    expect(intent.properties.transport.enum).toEqual(['system', 'https', 'ssh', 'anonymous']);
    expect(intent.properties.kind.enum).toEqual(['submodule', 'lfs']);
    expect(intent.properties.operation.enum).toEqual(['add', 'replace', 'remove', 'configure']);
    for (const nested of ['target', 'provider', 'credentialAccount']) {
      expect(Object.keys(intent.properties[nested].properties).sort())
        .toContain('provider');
    }
    expect(Object.keys(intent.properties.credentialAccount.properties).sort())
      .toEqual(['accountId', 'instance', 'provider']);
    expect(Object.keys(intent.properties.target.properties).sort())
      .toEqual(['accountId', 'instance', 'primaryRemote', 'provider']);
    expect(Object.keys(intent.properties.provider.properties).sort())
      .toEqual(['accountId', 'instance', 'primaryRemote', 'provider', 'repository']);
  });

  it('rejects prototype-named actions instead of dispatching inherited members', async () => {
    const { run } = setup();
    for (const action of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__']) {
      await expectError(run(action), 400, /Unsupported integration action/);
    }
  });

  it('answers 503 before the routes are registered', async () => {
    const actions = createIntegrationServiceActions({ getIntegrationOperations: () => null });
    await expectError(actions.execute('github.status', {}, {}), 503, /finished starting/);
  });
});

describe('secrets never leave', () => {
  it('drops every seeded token from the answer of every action', async () => {
    const { ops, run } = setup();
    // Positive control: the operations really hand the seed out.
    expect(JSON.stringify(await ops.github.status())).toContain(SEED);
    expect(JSON.stringify(await ops.extensions.list())).toContain(SEED);
    for (const [action, input] of Object.entries(VALID_CALLS)) {
      const result = await run(action, input);
      const text = JSON.stringify(result);
      expect(text.length, action).toBeGreaterThan(2);
      expect(text, action).not.toContain(SEED);
    }
  });

  it('refuses inputs that carry a secret before any operation runs', async () => {
    const { ops, run } = setup();
    await expectError(run('binding.set', { bindingOperation: 'provider', bindingIntent: { account: { accessToken: 'x' } } }), 400, /bindingIntent\.account\.accessToken looks like a secret/);
    await expectError(run('extensions.settings', { extensionId: 'acme', extensionSettings: { apiToken: 'x' } }), 400, /looks like a secret/);
    await expectError(run('extensions.settings', { extensionId: 'acme', extensionSettings: { privateKey: 'x' } }), 400, /extensionSettings\.privateKey looks like a secret/);
    await expectError(run('extensions.settings', { extensionId: 'acme', extensionSettings: { access_key: 'x' } }), 400, /looks like a secret/);
    await expectError(run('extensions.settings', { extensionId: 'acme', extensionSettings: { privateKeys: 'x' } }), 400, /extensionSettings\.privateKeys looks like a secret/);
    await expectError(run('extensions.settings', { extensionId: 'acme', extensionSettings: { tokens: 'x' } }), 400, /looks like a secret/);
    await expectError(run('extensions.settings', { extensionId: 'acme', extensionSettings: { apiKeys: 'x' } }), 400, /looks like a secret/);
    await expectError(run('extensions.settings', { extensionId: 'acme', extensionSettings: { passwords: 'x' } }), 400, /looks like a secret/);
    await expectError(run('extensions.settings', { extensionId: 'acme', extensionSettings: { keys: 'x' } }), 400, /looks like a secret/);
    await expectError(run('extensions.settings', { extensionId: 'acme', extensionSettings: { authorizations: 'x' } }), 400, /extensionSettings\.authorizations looks like a secret/);
    // `monkey` ends in `key`; both guards treat it as a secret, fail-closed.
    await expectError(run('extensions.settings', { extensionId: 'acme', extensionSettings: { monkey: 'x' } }), 400, /looks like a secret/);
    await expectError(run('linear.mapping', { linearMapping: { clientSecret: 'x' } }), 400, /looks like a secret/);
    expect(ops.bindings.setProvider).not.toHaveBeenCalled();
    expect(ops.extensions.saveSettings).not.toHaveBeenCalled();
    expect(ops.linear.writeMapping).not.toHaveBeenCalled();
  });

  it('keeps non-secret names that only resemble secret names', async () => {
    const { run } = setup();
    const answer = await run('github.status');
    expect(answer.tokenType).toBe('bearer');
    expect(answer.scope).toBe('repo');
    await expect(run('extensions.settings', { extensionId: 'acme', extensionSettings: { tokenType: 'bearer', scope: 'repo' } })).resolves.toBeTruthy();
  });

  it('returns no token from a real GitLab account store', async () => {
    const account = {
      id: `${GITLAB}#9`, credentialId: `${GITLAB}#9`, credentialRevision: 1, providerUserId: `${GITLAB}#9`,
      token: SEED, refreshToken: SEED, user: { id: 9, username: 'gl-user' }, source: 'pat', status: 'valid',
    };
    const store = {
      listInstances: async () => [GITLAB],
      readInstance: async () => ({ activeAccountId: account.id, accounts: [account], cliDisabled: true, cliActive: false }),
    };
    const fetch = vi.fn(async () => Response.json({ id: 9, username: 'gl-user', name: 'GitLab User' }));
    const gitlab = registerGitLabRoutes({ get: () => {}, post: () => {}, put: () => {}, delete: () => {} }, { store, fetch, execFile: async () => ({ stdout: '' }) });
    const actions = createIntegrationServiceActions({ getIntegrationOperations: () => ({ gitlab: gitlab.accounts }) });

    const result = await actions.execute('gitlab.status', { instance: GITLAB }, {});

    expect(result).toMatchObject({ connected: true, accounts: [{ id: account.id, current: true }] });
    expect(fetch).toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(SEED);
  });
});

describe('github actions', () => {
  it('switch accounts and report a missing one with the route\'s status', async () => {
    const { ops, run } = setup();
    await run('github.activate', { accountId: 'occred:v1:github:a' });
    expect(ops.github.activate).toHaveBeenCalledWith('occred:v1:github:a');
    await expectError(run('github.activate', { accountId: 'missing' }), 404, /GitHub account not found/);
    await expectError(run('github.activate', {}), 400, /accountId is required/);
  });

  it('sign out only with confirm', async () => {
    const { ops, run } = setup();
    await expectError(run('github.remove', { accountId: 'occred:v1:github:a' }), 400, /confirm true/);
    expect(ops.github.remove).not.toHaveBeenCalled();
    await expect(run('github.remove', { accountId: 'occred:v1:github:a', confirm: true })).resolves.toMatchObject({ removed: true });
    expect(ops.github.remove).toHaveBeenCalledWith('occred:v1:github:a');
  });

  it('add an account from a vault reference, which the answer may show', async () => {
    const { ops, run } = setup();
    const answer = await run('github.addFromVault', { tokenReference: 'op://Vertex SRE/github_token/credential' });
    expect(ops.github.addFromVault).toHaveBeenCalledWith('op://Vertex SRE/github_token/credential');
    expect(answer.accounts[0].tokenReference).toBe('op://Vertex SRE/github_token/credential');
    await expectError(run('github.addFromVault', {}), 400, /tokenReference/);
  });

  it('turn the gh login off with a boolean only', async () => {
    const { ops, run } = setup();
    await expectError(run('github.cli', { disabled: 'true' }), 400, /disabled/);
    await expect(run('github.cli', { disabled: true })).resolves.toEqual({ disabled: true });
    expect(ops.github.setCliDisabled).toHaveBeenCalledWith(true);
  });
});

describe('gitlab actions', () => {
  it('only reach instances the user connected', async () => {
    const { ops, run } = setup();
    await expectError(run('gitlab.status', { instance: 'https://attacker.example' }), 404, /not a GitLab instance the user connected/);
    await expectError(run('gitlab.activate', { instance: 'https://attacker.example', accountId: 'x' }), 404);
    expect(ops.gitlab.status).not.toHaveBeenCalled();
    expect(ops.gitlab.activate).not.toHaveBeenCalled();
    await expectError(run('gitlab.status', { instance: 'not a url' }), 400, /not a valid GitLab address/);
    await run('gitlab.status', { instance: 'https://gitlab.com' });
    expect(ops.gitlab.status).toHaveBeenCalledWith('https://gitlab.com');
  });

  it('list every stored instance without one, keeping the others when one fails', async () => {
    const { ops, run } = setup();
    ops.gitlab.listInstances.mockResolvedValue([GITLAB, 'https://gitlab.other.example']);
    ops.gitlab.status.mockImplementation(async (instance) => {
      if (instance === GITLAB) throw new Error('store locked');
      return { instance, connected: false };
    });
    const result = await run('gitlab.status');
    expect(result.instances).toEqual([
      { instance: GITLAB, error: 'store locked' },
      { instance: 'https://gitlab.other.example', connected: false },
    ]);
  });

  it('sign out only with confirm', async () => {
    const { ops, run } = setup();
    await expectError(run('gitlab.remove', { instance: GITLAB, accountId: `${GITLAB}#1` }), 400, /confirm true/);
    expect(ops.gitlab.remove).not.toHaveBeenCalled();
    await run('gitlab.remove', { instance: GITLAB, accountId: `${GITLAB}#1`, confirm: true });
    expect(ops.gitlab.remove).toHaveBeenCalledWith(GITLAB, `${GITLAB}#1`);
  });
});

describe('linear actions', () => {
  it('show status with mapping and preferences, keeping the status when the mapping fails', async () => {
    const { ops, run } = setup();
    ops.linear.readMapping.mockResolvedValue({ status: 500, body: { error: 'Linear mapping file is malformed' } });
    const result = await run('linear.status');
    expect(result).toMatchObject({
      connected: true,
      mapping: { error: 'Linear mapping file is malformed' },
      preferences: { sessionComments: false },
    });
  });

  it('disconnect only with confirm', async () => {
    const { ops, run } = setup();
    await expectError(run('linear.disconnect'), 400, /confirm true/);
    expect(ops.linear.disconnect).not.toHaveBeenCalled();
    await run('linear.disconnect', { confirm: true });
    expect(ops.linear.disconnect).toHaveBeenCalled();
  });

  it('change the workspace, mapping and comment preference', async () => {
    const { ops, run } = setup();
    await run('linear.activate', { workspaceId: 'org-1' });
    expect(ops.linear.activate).toHaveBeenCalledWith('org-1');
    await run('linear.mapping', { linearMapping: { defaultProjectPath: '/p', teamProjectPaths: { t1: '/q' } } });
    expect(ops.linear.writeMapping).toHaveBeenCalledWith({ defaultProjectPath: '/p', teamProjectPaths: { t1: '/q' } });
    await expectError(run('linear.preferences', {}), 400, /sessionComments/);
    await run('linear.preferences', { sessionComments: true });
    expect(ops.linear.writePreferences).toHaveBeenCalledWith(true);
  });
});

describe('binding actions', () => {
  it('read the binding of the session directory by default', async () => {
    const { ops, run } = setup();
    await run('binding.get');
    expect(ops.bindings.read).toHaveBeenCalledWith('/work/repo');
  });

  it('change the provider account without confirm, credentials only with it', async () => {
    const { ops, run } = setup();
    await run('binding.set', { bindingOperation: 'provider', bindingIntent: { expectedRevision: 2 } });
    expect(ops.bindings.setProvider).toHaveBeenCalledWith({ expectedRevision: 2, directory: '/work/repo' });
    for (const operation of ['transport', 'transport-remove', 'auxiliary', 'reset']) {
      await expectError(run('binding.set', { bindingOperation: operation, bindingIntent: {} }), 400, /confirm true/);
    }
    expect(ops.bindings.setTransport).not.toHaveBeenCalled();
    expect(ops.bindings.removeTransport).not.toHaveBeenCalled();
    expect(ops.bindings.setAuxiliary).not.toHaveBeenCalled();
    expect(ops.bindings.reset).not.toHaveBeenCalled();
    await run('binding.set', { bindingOperation: 'reset', bindingIntent: { directory: '/other', confirmed: true }, confirm: true });
    expect(ops.bindings.reset).toHaveBeenCalledWith({ directory: '/other', confirmed: true });
    await expectError(run('binding.set', { bindingOperation: 'delete', bindingIntent: {} }), 400, /bindingOperation must be one of/);
  });

  it('keep a binding conflict\'s status', async () => {
    const { ops, run } = setup();
    ops.bindings.setProvider.mockRejectedValue(Object.assign(new Error('Source control binding changed'), { status: 409, code: 'SOURCE_CONTROL_BINDING_CONFLICT' }));
    await expectError(run('binding.set', { bindingOperation: 'provider', bindingIntent: {} }), 409, /binding changed/);
  });
});

describe('extension actions', () => {
  it('list extensions with their sign-in state', async () => {
    const { run } = setup();
    const { extensions } = await run('extensions.list');
    expect(extensions).toEqual([expect.objectContaining({
      id: 'acme', enabled: true, integration: { name: 'Acme', auth: 'token' }, signIn: { connected: true, account: 'me' },
    })]);
  });

  it('pause and resume with disabled', async () => {
    const { ops, run } = setup();
    const { extension } = await run('extensions.toggle', { extensionId: 'acme', disabled: true });
    expect(ops.extensions.setEnabled).toHaveBeenCalledWith('acme', { enabled: false });
    expect(extension.enabled).toBe(false);
    await expectError(run('extensions.toggle', { extensionId: 'gone', disabled: false }), 404, /Extension not found: gone/);
  });

  it('sign out only with confirm', async () => {
    const { ops, run } = setup();
    await expectError(run('extensions.disconnect', { extensionId: 'acme' }), 400, /confirm true/);
    expect(ops.extensions.disconnect).not.toHaveBeenCalled();
    await run('extensions.disconnect', { extensionId: 'acme', confirm: true });
    expect(ops.extensions.disconnect).toHaveBeenCalledWith('acme');
  });
});

describe('integrations.list', () => {
  it('keeps every readable section when one service fails', async () => {
    const { ops, run } = setup();
    ops.github.status.mockRejectedValue(new Error('GitHub auth storage is invalid'));
    const result = await run('integrations.list');
    expect(result.github).toEqual({ error: 'GitHub auth storage is invalid' });
    expect(result.linear).toMatchObject({ connected: true });
    expect(result.extensions).toHaveLength(1);
    expect(result.binding).toMatchObject({ directory: '/work/repo', revision: 2 });
  });
});
