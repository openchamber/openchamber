import { describe, expect, test } from 'bun:test';

import { getDefaultModels } from './model-families';

// Model ids below are taken from the models.dev catalog the provider metadata
// is built from, so the boundaries are checked against names that actually
// exist: Gemini 3.x in both spellings, earlier Gemini generations, and the
// neighbouring Google families that must not be swept in.

describe('getDefaultModels for the google provider', () => {
  test('selects dotted Gemini 3.x model IDs', () => {
    const models = [
      'gemini-3.1-pro',
      'gemini-3.5-flash',
      'gemini-3.6-flash',
      'gemini-3.7-flash',
      'gemini-3.8-flash',
    ];

    expect(getDefaultModels('google', models)).toEqual(models);
  });

  test('selects the hyphenated Gemini 3 ids', () => {
    const models = ['gemini-3-flash', 'gemini-3-pro'];

    expect(getDefaultModels('google', models)).toEqual(models);
  });

  test('selects hyphenated minor versions some providers expose', () => {
    const models = ['gemini-3-1-pro', 'gemini-3-6-flash', 'gemini-3-7-flash'];

    expect(getDefaultModels('google', models)).toEqual(models);
  });

  test('selects preview and preview-suffixed Gemini 3.x ids', () => {
    const models = [
      'gemini-3.1-pro-preview',
      'gemini-3.1-flash-lite',
      'gemini-3.0-flash-preview',
      'gemini-3.1-flash-live-preview',
    ];

    expect(getDefaultModels('google', models)).toEqual(models);
  });

  test('selects Gemini 3.x under the gemini/ and antigravity/ auth prefixes', () => {
    expect(getDefaultModels('google', ['gemini/gemini-3.8-flash'])).toEqual(['gemini/gemini-3.8-flash']);
    expect(getDefaultModels('google', ['antigravity/gemini-3-flash'])).toEqual(['antigravity/gemini-3-flash']);
    expect(getDefaultModels('google', ['antigravity/gemini-3.1-pro'])).toEqual(['antigravity/gemini-3.1-pro']);
  });

  test('selects preview ids regardless of which prefix they carry', () => {
    const models = [
      'gemini/gemini-3.1-pro-preview',
      'antigravity/gemini-3.7-flash',
      'gemini-3.1-flash-lite-preview',
    ];

    expect(getDefaultModels('google', models)).toEqual(models);
  });

  test('selects every Claude model', () => {
    expect(getDefaultModels('google', ['antigravity/claude-sonnet-4-6'])).toEqual(['antigravity/claude-sonnet-4-6']);
  });

  test('selects the model list from the bug report', () => {
    const models = [
      'antigravity/gemini-3-flash',
      'antigravity/gemini-3.1-pro-high',
      'antigravity/gemini-3.8-flash-tiered',
      'gemini/gemini-3.1-pro-high',
      'gemini-3.8-flash',
      'antigravity/claude-sonnet-4-6',
    ];

    expect(getDefaultModels('google', models)).toEqual(models);
  });

  test('keeps legacy Gemini 3 and dotted ids together', () => {
    const models = [
      'gemini-3-flash',
      'gemini-3-pro',
      'gemini-3.1-pro',
      'gemini-3.5-flash',
      'gemini-3.6-flash',
      'gemini-3.7-flash',
      'gemini-3.8-flash',
      'antigravity/claude-sonnet-4-6',
    ];

    expect(getDefaultModels('google', models)).toEqual(models);
  });

  test('ignores earlier Gemini generations', () => {
    expect(getDefaultModels('google', [
      'gemini-1.5-flash',
      'gemini-2.0-flash',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-2.5-pro',
    ])).toEqual([]);
  });

  test('ignores versionless Gemini aliases', () => {
    expect(getDefaultModels('google', [
      'gemini-flash-latest',
      'gemini-flash-lite-latest',
    ])).toEqual([]);
  });

  test('ignores non-chat surfaces and neighbouring families', () => {
    expect(getDefaultModels('google', [
      'gemini-embedding-001',
      'gemini-embedding-2',
      'gemma-4-26b-a4b-it',
      'veo-3.1-generate-preview',
      'lyria-3-pro-preview',
    ])).toEqual([]);
  });

  test('ignores unrelated providers', () => {
    expect(getDefaultModels('google', ['gpt-5.2-codex', 'deepseek-v4-pro'])).toEqual([]);
  });
});

describe('getDefaultModels for the claude provider', () => {
  test('keeps every model the provider reports a limit for', () => {
    const models = ['claude-opus-4-6', 'claude-sonnet-4-6'];

    expect(getDefaultModels('claude', models)).toEqual(models);
  });
});
