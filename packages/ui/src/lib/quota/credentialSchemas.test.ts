import { describe, expect, test } from 'bun:test';
import { resolveQuotaProviderId } from './credentialSchemas';

describe('resolveQuotaProviderId', () => {
  test('maps OpenCode Zen (id "opencode") to the shared opencode-go credential', () => {
    expect(resolveQuotaProviderId('opencode')).toBe('opencode-go');
  });

  test('maps OpenCode Go (id "opencode-go") to its own credential', () => {
    expect(resolveQuotaProviderId('opencode-go')).toBe('opencode-go');
  });

  test('resolves known aliases to their canonical quota provider', () => {
    expect(resolveQuotaProviderId('byteplus-plan')).toBe('byteplus');
    expect(resolveQuotaProviderId('atlas-cloud')).toBe('atlascloud');
    expect(resolveQuotaProviderId('ollama')).toBe('ollama-cloud');
    expect(resolveQuotaProviderId('mistral-vibe')).toBe('mistral');
  });

  test('resolves custom-named providers by dash/underscore prefix', () => {
    expect(resolveQuotaProviderId('mistral-schlambo')).toBe('mistral');
    expect(resolveQuotaProviderId('stepfun_custom')).toBe('stepfun');
  });

  test('returns undefined for unmapped providers and empty input', () => {
    expect(resolveQuotaProviderId('anthropic')).toBe(undefined);
    expect(resolveQuotaProviderId(undefined)).toBe(undefined);
  });
});
