import { describe, expect, it } from 'vitest';
import { applySmallModelOverrideToOpenCodeConfig } from './config-injection.js';

describe('applySmallModelOverrideToOpenCodeConfig', () => {
  it('leaves config unchanged when use-default is not explicitly disabled', () => {
    const config = '{"model":"anthropic/claude-sonnet-4-5"}';
    expect(
      applySmallModelOverrideToOpenCodeConfig({
        configContent: config,
        smallModelUseDefault: true,
        smallModelOverride: 'anthropic/claude-haiku-4-5',
      }),
    ).toBe(config);
    expect(
      applySmallModelOverrideToOpenCodeConfig({
        configContent: config,
        smallModelUseDefault: undefined,
        smallModelOverride: 'anthropic/claude-haiku-4-5',
      }),
    ).toBe(config);
  });

  it('leaves config unchanged when the override is empty or whitespace', () => {
    const config = '{"model":"anthropic/claude-sonnet-4-5"}';
    expect(
      applySmallModelOverrideToOpenCodeConfig({
        configContent: config,
        smallModelUseDefault: false,
        smallModelOverride: '   ',
      }),
    ).toBe(config);
    expect(
      applySmallModelOverrideToOpenCodeConfig({
        configContent: config,
        smallModelUseDefault: false,
        smallModelOverride: undefined,
      }),
    ).toBe(config);
  });

  it('injects small_model into an empty config', () => {
    const result = applySmallModelOverrideToOpenCodeConfig({
      configContent: undefined,
      smallModelUseDefault: false,
      smallModelOverride: 'anthropic/claude-haiku-4-5',
    });
    expect(JSON.parse(result)).toEqual({ small_model: 'anthropic/claude-haiku-4-5' });
  });

  it('injects small_model while preserving existing config keys and plugins', () => {
    const result = applySmallModelOverrideToOpenCodeConfig({
      configContent: '{"model":"anthropic/claude-sonnet-4-5","plugin":["file:///tool.js"]}',
      smallModelUseDefault: false,
      smallModelOverride: 'google/gemini-2.5-flash',
    });
    expect(JSON.parse(result)).toEqual({
      model: 'anthropic/claude-sonnet-4-5',
      plugin: ['file:///tool.js'],
      small_model: 'google/gemini-2.5-flash',
    });
  });

  it('replaces an existing small_model with the override', () => {
    const result = applySmallModelOverrideToOpenCodeConfig({
      configContent: '{"small_model":"anthropic/claude-haiku-4-5"}',
      smallModelUseDefault: false,
      smallModelOverride: 'google/gemini-2.5-flash',
    });
    expect(JSON.parse(result)).toEqual({ small_model: 'google/gemini-2.5-flash' });
  });

  it('leaves malformed config untouched instead of rewriting it', () => {
    const config = '{not-valid-json';
    expect(
      applySmallModelOverrideToOpenCodeConfig({
        configContent: config,
        smallModelUseDefault: false,
        smallModelOverride: 'anthropic/claude-haiku-4-5',
      }),
    ).toBe(config);
    const arrayConfig = '["not","an","object"]';
    expect(
      applySmallModelOverrideToOpenCodeConfig({
        configContent: arrayConfig,
        smallModelUseDefault: false,
        smallModelOverride: 'anthropic/claude-haiku-4-5',
      }),
    ).toBe(arrayConfig);
  });
});
