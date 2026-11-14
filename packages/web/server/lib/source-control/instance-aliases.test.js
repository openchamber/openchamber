import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInstanceAliasStore, instanceHostname, normalizeInstanceAlias } from './instance-aliases.js';
import { registerSourceControlRoutes } from './routes.js';

const missingGt = (_file, _args, _options, callback) => {
  callback(Object.assign(new Error('gt not installed'), { code: 'ENOENT' }));
};

describe('normalizeInstanceAlias', () => {
  it('spells an alias the way the provider spells its instances', () => {
    expect(normalizeInstanceAlias('origin', 'Domain-A.internal-a.net')).toBe('https://domain-a.internal-a.net');
    expect(normalizeInstanceAlias('origin', 'https://domain-a.internal-a.net/')).toBe('https://domain-a.internal-a.net');
    expect(normalizeInstanceAlias('origin', 'https://code.example.com:8443')).toBe('https://code.example.com:8443');
    expect(normalizeInstanceAlias('host', 'https://GHE-Mirror.example.com')).toBe('ghe-mirror.example.com');
  });

  it.each([
    ['origin', 'http://domain-a.internal-a.net'],
    ['origin', 'https://domain-a.internal-a.net/group'],
    ['origin', 'https://user@domain-a.internal-a.net'],
    ['origin', ''],
    ['host', 'https://ghe.example.com:8443'],
    ['host', 'ghe.example.com/path'],
  ])('refuses %s alias %j', (form, value) => {
    expect(() => normalizeInstanceAlias(form, value)).toThrow(expect.objectContaining({ code: 'INVALID_INSTANCE_ALIAS' }));
  });

  it('compares addresses by hostname whatever their form', () => {
    expect(instanceHostname('https://Code.example.com:8443')).toBe('code.example.com');
    expect(instanceHostname('ghe.example.com')).toBe('ghe.example.com');
  });
});

describe('instance alias store', () => {
  let directory;
  let filePath;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-instance-aliases-'));
    filePath = path.join(directory, 'source-control-instance-aliases.json');
  });
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

  it('reads a missing file as no aliases and leaves no lock behind', async () => {
    await expect(createInstanceAliasStore({ filePath }).list()).resolves.toEqual({});
    await expect(fs.readdir(directory)).resolves.toEqual([]);
  });

  it('round-trips one instance and drops it when its list empties', async () => {
    const store = createInstanceAliasStore({ filePath });
    await store.set('gitlab', 'https://code.internal.net', ['https://domain-a.internal-a.net']);
    await store.set('gitea', 'https://gitea.example.com', ['https://git.example.com']);
    expect(await createInstanceAliasStore({ filePath }).list()).toEqual({
      gitlab: { 'https://code.internal.net': ['https://domain-a.internal-a.net'] },
      gitea: { 'https://gitea.example.com': ['https://git.example.com'] },
    });
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);

    await store.set('gitlab', 'https://code.internal.net', []);
    expect(await store.list()).toEqual({ gitea: { 'https://gitea.example.com': ['https://git.example.com'] } });
  });

  it('refuses a file it cannot parse and leaves it untouched', async () => {
    await fs.writeFile(filePath, '{"version":2,"providers":{}}');
    const store = createInstanceAliasStore({ filePath });
    await expect(store.list()).rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_INSTANCE_ALIASES' });
    await expect(store.set('gitlab', 'https://code.internal.net', ['https://a.example.com'])).rejects.toMatchObject({
      code: 'INVALID_SOURCE_CONTROL_INSTANCE_ALIASES',
    });
    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe('{"version":2,"providers":{}}');
  });

  it('writes nothing when the check refuses', async () => {
    const store = createInstanceAliasStore({ filePath });
    await expect(store.set('gitlab', 'https://code.internal.net', ['https://a.example.com'], () => {
      throw Object.assign(new Error('taken'), { code: 'INSTANCE_ALIAS_TAKEN' });
    })).rejects.toMatchObject({ code: 'INSTANCE_ALIAS_TAKEN' });
    await expect(fs.access(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('instance alias routes', () => {
  let directory;
  let previousConfigDir;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-instance-alias-routes-'));
    // The instance list also reads trusted enterprise hosts from gh's config.
    previousConfigDir = process.env.GH_CONFIG_DIR;
    process.env.GH_CONFIG_DIR = '/oc-no-gh-cli-config';
  });
  afterEach(async () => {
    if (previousConfigDir === undefined) delete process.env.GH_CONFIG_DIR;
    else process.env.GH_CONFIG_DIR = previousConfigDir;
    await fs.rm(directory, { recursive: true, force: true });
  });

  const mount = () => {
    const handlers = new Map();
    const record = (route, handler) => {
      if (Object.prototype.toString.call(route) === '[object String]') handlers.set(route, handler);
    };
    const app = { get: vi.fn(record), post: vi.fn(record), put: vi.fn(), delete: vi.fn(), use: vi.fn() };
    registerSourceControlRoutes(app, {
      configRoot: directory,
      gitea: { execFile: missingGt },
      gitlab: { store: {
        listInstances: async () => ['https://code.internal.net', 'https://other.internal.net'],
        readInstance: async () => ({ activeAccountId: null, accounts: [], cliDisabled: false, cliActive: false }),
      } },
    });
    const call = async (route, req) => {
      const json = vi.fn();
      const status = vi.fn(() => ({ json }));
      await handlers.get(route)(req, { json, status });
      return { status: status.mock.calls[0]?.[0] ?? 200, body: json.mock.calls[0]?.[0] };
    };
    return {
      setAliases: (body) => call('/api/source-control/instances/aliases', { body }),
      listInstances: () => call('/api/source-control/instances', {}),
    };
  };

  it('saves aliases of an added instance and lists them with it', async () => {
    const routes = mount();
    await expect(routes.setAliases({
      provider: 'gitlab', instance: 'https://code.internal.net', aliases: ['domain-a.internal-a.net', 'https://domain-a.internal-a.net'],
    })).resolves.toEqual({ status: 200, body: { aliases: ['https://domain-a.internal-a.net'] } });

    const { body } = await routes.listInstances();
    expect(body.instances).toContainEqual({
      provider: 'gitlab', instance: 'https://code.internal.net', instanceAliases: ['https://domain-a.internal-a.net'],
    });
    expect(body.instances).toContainEqual({ provider: 'gitlab', instance: 'https://other.internal.net' });
  });

  it('refuses a default instance and one the provider does not know', async () => {
    const routes = mount();
    for (const instance of ['https://gitlab.com', 'https://unknown.internal.net']) {
      await expect(routes.setAliases({ provider: 'gitlab', instance, aliases: ['a.example.com'] }))
        .resolves.toMatchObject({ status: 404, body: { code: 'SOURCE_CONTROL_INSTANCE_UNKNOWN' } });
    }
  });

  it('refuses an address that already names an instance or another instance\'s alias', async () => {
    const routes = mount();
    for (const alias of ['other.internal.net', 'github.com', 'code.internal.net']) {
      await expect(routes.setAliases({ provider: 'gitlab', instance: 'https://code.internal.net', aliases: [alias] }))
        .resolves.toMatchObject({ status: 409, body: { code: 'INSTANCE_ALIAS_TAKEN' } });
    }
    await routes.setAliases({ provider: 'gitlab', instance: 'https://other.internal.net', aliases: ['mirror.internal.net'] });
    await expect(routes.setAliases({ provider: 'gitlab', instance: 'https://code.internal.net', aliases: ['mirror.internal.net'] }))
      .resolves.toMatchObject({ status: 409, body: { code: 'INSTANCE_ALIAS_TAKEN', alias: 'https://mirror.internal.net' } });
    // Its own aliases are no conflict when it saves them again.
    await expect(routes.setAliases({ provider: 'gitlab', instance: 'https://other.internal.net', aliases: ['mirror.internal.net'] }))
      .resolves.toMatchObject({ status: 200 });
  });

  it('refuses an address that is not one', async () => {
    const routes = mount();
    await expect(routes.setAliases({ provider: 'gitlab', instance: 'https://code.internal.net', aliases: ['http://plain.example.com'] }))
      .resolves.toMatchObject({ status: 400, body: { code: 'INVALID_INSTANCE_ALIAS', alias: 'http://plain.example.com' } });
  });

  it('still lists instances when the alias file cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await fs.writeFile(path.join(directory, 'source-control-instance-aliases.json'), 'not json');
      const { body } = await mount().listInstances();
      expect(body.instances).toContainEqual({ provider: 'gitlab', instance: 'https://code.internal.net' });
    } finally {
      warn.mockRestore();
    }
  });
});
