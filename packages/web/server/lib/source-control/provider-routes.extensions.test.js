import express from 'express';
import fs from 'node:fs';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';

import { buildExtensionDescriptor } from './extension-descriptor.js';
import { createProviderDescriptors } from './provider-descriptors.js';
import { createAccountEvents } from './provider-registry.js';
import { registerSourceControlRoutes } from './routes.js';
import { githubDescriptor } from '../github/descriptor.js';

const contribution = JSON.parse(fs.readFileSync(
  new URL('../../../../sdk/examples/source-control-provider/package.json', import.meta.url), 'utf8',
)).openchamber.contributes.sourceControl;
const descriptor = buildExtensionDescriptor({ guestId: 'forge', contribution, guest: { name: 'Forge', version: '1.2.0' } });

/** A registry with GitHub (never loaded) and extensions whose implementations answer auth status only. */
const fakeProviders = () => {
  const descriptors = createProviderDescriptors([githubDescriptor]);
  const impls = new Map();
  return {
    descriptors,
    events: createAccountEvents(),
    has: (id) => descriptors.has(id),
    list: () => descriptors.list(),
    describe: (id) => descriptors.get(id),
    implementation: async (id) => impls.get(id) ?? null,
    readTransportCredential: async () => null,
    registerExtension: ({ descriptor: added }) => {
      descriptors.attachExtension(added);
      impls.set(added.id, {
        descriptor: added,
        classifyFailure: () => 'provider-error',
        auth: {
          status: async ({ instance }) => ({ provider: added.id, instance, status: 'disconnected', connected: false }),
          listInstances: async () => [],
          listConnectedAccounts: async () => [],
        },
      });
    },
    unregisterExtension: (id) => {
      impls.delete(id);
      return descriptors.detachExtension(id);
    },
  };
};

let server;
afterEach(() => new Promise((resolve) => (server ? server.close(() => resolve()) : resolve())));

const start = async () => {
  const app = express();
  app.use(express.json());
  const shell = registerSourceControlRoutes(app, { providers: fakeProviders(), bindingService: {} });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (path) => {
    const response = await fetch(`${base}${path}`);
    return { status: response.status, body: await response.json() };
  };
  return { shell, get };
};

describe('extension provider routes', () => {
  it('serve a mounted extension, fall through to the catch-all once unmounted, and list it with its marker', async () => {
    const { shell, get } = await start();
    const statusPath = '/api/source-control/ext-forge/auth/status?instance=https%3A%2F%2Fforge.example';
    expect(await get(statusPath)).toMatchObject({ status: 404, body: { code: 'SOURCE_CONTROL_PROVIDER_UNAVAILABLE' } });

    shell.registerExtensionProvider({ descriptor, guest: { id: 'forge' } });
    expect(await get(statusPath)).toEqual({ status: 200, body: {
      provider: 'ext-forge', instance: 'https://forge.example', status: 'disconnected', connected: false,
    } });
    // A capability the extension turns off still answers, with the stable 501.
    expect((await get('/api/source-control/ext-forge/references/labels?directory=/r&owner=a&repo=b')).status).toBe(501);
    const { body } = await get('/api/source-control/providers');
    expect(body.providers.map((provider) => provider.id)).toEqual(['github', 'ext-forge']);
    expect(body.providers[0]).not.toHaveProperty('extension');
    expect(body.providers[1].extension).toEqual({ guestId: 'forge', name: 'Forge', version: '1.2.0' });

    shell.unregisterExtensionProvider('ext-forge');
    expect(await get(statusPath)).toMatchObject({ status: 404, body: { code: 'SOURCE_CONTROL_PROVIDER_UNAVAILABLE' } });
    expect((await get('/api/source-control/providers')).body.providers.map((provider) => provider.id)).toEqual(['github']);
  });

  it('never reaches an extension router for a path that only looks like one', async () => {
    const { shell, get } = await start();
    shell.registerExtensionProvider({ descriptor, guest: { id: 'forge' } });
    expect((await get('/api/source-control/ext-forgery/auth/status')).status).toBe(404);
    expect((await get('/api/source-control/ext-forge/nothing-here')).body.code).toBe('SOURCE_CONTROL_PROVIDER_UNAVAILABLE');
  });
});
