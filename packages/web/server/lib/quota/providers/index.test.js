import { describe, expect, it } from 'vitest';

import * as google from './google/index.js';
import { listConfiguredQuotaProviders } from './index.js';

describe('quota provider registry', () => {
  it('exposes google provider configuration helpers through the provider module', () => {
    expect(google.providerId).toBe('google');
    expect(google.providerName).toBe('Google');
    expect(typeof google.isConfigured).toBe('function');
    expect(typeof google.resolveGoogleAuthSources).toBe('function');
  });

  it('can list configured providers without missing provider exports', () => {
    expect(() => listConfiguredQuotaProviders()).not.toThrow();
  });
});
