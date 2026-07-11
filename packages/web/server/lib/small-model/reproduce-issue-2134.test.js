/**
 * Reproduction test for issue #2134:
 * callSmallModel fails with "no known API base URL" when the small_model
 * points to a custom OpenAI-compatible provider that isn't in the built-in
 * models.dev catalog.
 *
 * The bug is in call.js lines 347-355:
 *
 *   const provider = getCatalogProvider(catalog, providerID);
 *   const baseURL = providerID === 'openai'
 *     ? 'https://api.openai.com/v1'
 *     : typeof provider?.api === 'string' && provider.api
 *       ? provider.api
 *       : null;
 *   if (!baseURL) {
 *     throw new Error(`Provider "${providerID}" has no known API base URL`);
 *   }
 *
 * For a custom provider configured in opencode.json (e.g. provider.my-proxy),
 * getCatalogProvider returns null because it only looks at the models.dev
 * catalog. There is no fallback to the provider's api field from the OpenCode
 * config (where users define custom providers with their own base URLs).
 */
import { describe, it, expect } from 'bun:test';
import { callSmallModel } from './call.js';

describe('callSmallModel with custom provider (issue #2134)', () => {
  it('throws "no known API base URL" for a custom provider not in the catalog', async () => {
    // A custom OpenAI-compatible provider defined in opencode.json,
    // for example:
    //
    //   "provider": {
    //     "my-local-proxy": {
    //       "api": "http://localhost:8080/v1",
    //       ...
    //     }
    //   }
    //
    // The custom provider has an auth entry (user is logged in) but is NOT
    // in the models.dev catalog.
    const auth = {
      'my-local-proxy': {
        type: 'api',
        key: 'sk-custom-key',
      },
    };

    // Empty catalog — no entries for custom providers.
    const catalog = {};

    await expect(
      callSmallModel({
        auth,
        catalog,
        providerID: 'my-local-proxy',
        modelID: 'my-model',
        prompt: 'Write a commit message for: fix login bug',
      }),
    ).rejects.toThrow('Provider "my-local-proxy" has no known API base URL');
  });

  it('throws even with a non-empty catalog that lacks the custom provider', async () => {
    // The catalog has openai but NOT the custom provider.
    const auth = {
      'my-ollama': {
        type: 'api',
        key: 'ollama-key',
      },
    };

    const catalog = {
      openai: {
        id: 'openai',
        models: {
          'gpt-4o-mini': { id: 'gpt-4o-mini', family: 'gpt-nano' },
        },
      },
    };

    await expect(
      callSmallModel({
        auth,
        catalog,
        providerID: 'my-ollama',
        modelID: 'llama3',
        prompt: 'Summarize the PR changes',
      }),
    ).rejects.toThrow('Provider "my-ollama" has no known API base URL');
  });

  it('succeeds for a catalog-listed provider with an api field', async () => {
    // Sanity check: providers in the catalog with an api field should work.
    const auth = {
      openai: {
        type: 'api',
        key: 'sk-test-key',
      },
    };

    const catalog = {
      openai: {
        id: 'openai',
        api: 'https://api.openai.com/v1',
        models: {
          'gpt-4o-mini': { id: 'gpt-4o-mini', family: 'gpt-nano' },
        },
      },
    };

    // This will fail because the API call will be made but no server
    // is listening — but importantly, it should NOT fail with the
    // "no known API base URL" error. It should get past the base URL
    // check and fail with a network/connection error instead.
    const promise = callSmallModel({
      auth,
      catalog,
      providerID: 'openai',
      modelID: 'gpt-4o-mini',
      prompt: 'test',
    });

    await expect(promise).rejects.not.toThrow('no known API base URL');
    // The actual error should be about the network request failing,
    // not about the missing base URL.
  });
});
