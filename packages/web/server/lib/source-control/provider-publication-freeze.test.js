import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { registerSourceControlRoutes } from './routes.js';
import { createSourceControlProviders } from './provider-registry.js';
import frozen from './provider-publication-freeze.json' with { type: 'json' };

/**
 * What the three built-ins publish, frozen. Change-based review hosts extend
 * the descriptor contract with optional fields; a host that declares none of
 * them must publish byte for byte what it did before, so an older client
 * reads GitHub, GitLab and Gitea exactly as it always has. GitHub declares
 * discussions, which add `urls.discussion` and `features.discussions` beside
 * the fields it always had; older clients leave both unread.
 */
const BUILT_INS = ['github', 'gitlab', 'gitea'];
// Gerrit came with change-based review; its own literal is held apart, so the
// three above stay exactly what they were before it.
const ALL = [...BUILT_INS, 'gerrit'];
const INSTANCES = { github: 'github.com', gitlab: 'https://gitlab.com', gitea: 'https://gitea.example.com', gerrit: 'https://gerrit.example.com' };

const appWith = () => {
  // The instance probe is the implementation's; the static half is the descriptor's.
  const loaders = Object.fromEntries(ALL.map((id) => [id, async () => ({
    createProvider: () => ({
      classifyFailure: () => 'provider-error',
      auth: {
        capabilities: vi.fn(async () => ({ authentication: true, authenticationMethods: { pat: { available: true } } })),
        listInstances: vi.fn(async () => []),
        listConnectedAccounts: vi.fn(async () => []),
      },
      resources: {},
    }),
  })]));
  const providers = createSourceControlProviders({ loaders });
  const app = express();
  app.use(express.json());
  registerSourceControlRoutes(app, {
    providers,
    bindingService: { validateReadContext: vi.fn(), validateMutationContext: vi.fn(), accountUnavailable: vi.fn(), accountConnected: vi.fn() },
    identityProvisioning: { backfillAccountIdentities: vi.fn(), ensureAccountIdentity: vi.fn(), repointAccountIdentities: vi.fn() },
    mutationExecutor: { read: vi.fn(), execute: vi.fn() },
  });
  return app;
};

describe('published built-in providers', () => {
  it('answers /providers for GitHub, GitLab and Gitea exactly as frozen', async () => {
    const response = await request(appWith()).get('/api/source-control/providers').expect(200);
    const builtIns = response.body.providers.filter((provider) => BUILT_INS.includes(provider.id));
    expect(builtIns).toEqual(frozen.providers);
  });

  it.each(BUILT_INS)('answers /capabilities for %s exactly as frozen', async (id) => {
    const response = await request(appWith()).get(`/api/source-control/${id}/capabilities`).query({ instance: INSTANCES[id] }).expect(200);
    expect(response.body).toEqual(frozen.capabilities[id]);
  });

  it('answers /providers and /capabilities for Gerrit as frozen, after the three built-ins', async () => {
    const app = appWith();
    const { providers } = (await request(app).get('/api/source-control/providers').expect(200)).body;
    expect(providers.map((provider) => provider.id).slice(0, ALL.length)).toEqual(ALL);
    expect(providers.find((provider) => provider.id === 'gerrit')).toEqual(frozen.gerrit.provider);
    const capabilities = await request(app).get('/api/source-control/gerrit/capabilities').query({ instance: INSTANCES.gerrit }).expect(200);
    expect(capabilities.body).toEqual(frozen.gerrit.capabilities);
  });
});
