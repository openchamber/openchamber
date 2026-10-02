import { describe, expect, test } from 'bun:test';

import { MANAGED_CREDENTIAL_PROVIDERS, matchQuotaCredentialRoute } from './quotaCredentialRoutes';

describe('VS Code webview managed credential routes', () => {
  test('answers locally for every provider the extension host accepts', () => {
    // An id missing from this list falls through to the OpenCode upstream, which
    // has no credential routes, so the provider's secret cannot be saved from
    // the extension at all. That is what happened to exe.dev.
    for (const providerId of MANAGED_CREDENTIAL_PROVIDERS) {
      expect(matchQuotaCredentialRoute(`/api/quota/credentials/${providerId}`, 'GET'))
        .toEqual({ providerId, method: 'GET' });
    }
  });

  test('saves, validates, imports and deletes per provider through the bridge', () => {
    expect(matchQuotaCredentialRoute('/api/quota/credentials/exe-dev', 'PUT'))
      .toEqual({ providerId: 'exe-dev', method: 'PUT' });
    expect(matchQuotaCredentialRoute('/api/quota/credentials/exe-dev', 'DELETE'))
      .toEqual({ providerId: 'exe-dev', method: 'DELETE' });
    expect(matchQuotaCredentialRoute('/api/quota/credentials/exe-dev/validate', 'POST'))
      .toEqual({ providerId: 'exe-dev', method: 'VALIDATE' });
    expect(matchQuotaCredentialRoute('/api/quota/credentials/cursor/import', 'POST'))
      .toEqual({ providerId: 'cursor', method: 'IMPORT' });
  });

  test('no longer claims Ollama Cloud, which reads the API key instead', () => {
    // Its usage comes from `GET /api/usage`, so there is nothing to paste and
    // nothing to store. A local form here would be dead.
    expect(matchQuotaCredentialRoute('/api/quota/credentials/ollama-cloud', 'GET')).toBeNull();
  });

  test('leaves an unknown provider or an unknown operation to the upstream', () => {
    expect(matchQuotaCredentialRoute('/api/quota/credentials/anthropic', 'GET')).toBeNull();
    expect(matchQuotaCredentialRoute('/api/quota/credentials/exe-dev/extra', 'POST')).toBeNull();
  });
});
