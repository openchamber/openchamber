import { describe, expect, test } from 'bun:test';
import {
  collectPromptInputs,
  defaultPromptValues,
  describeOAuthError,
  firstUnansweredPrompt,
  isPromptVisible,
  parseAuthPrompts,
  parseAuthorization,
  visiblePrompts,
  type AuthPrompt,
  type ProviderOAuthTranslator,
} from './provider-oauth';

/** Mirrors the github-copilot auth method shipped by OpenCode. */
const copilotPrompts = [
  {
    type: 'select',
    key: 'deploymentType',
    message: 'Select GitHub deployment type',
    options: [
      { label: 'GitHub.com', value: 'github.com', hint: 'Public' },
      { label: 'GitHub Enterprise', value: 'enterprise' },
    ],
  },
  {
    type: 'text',
    key: 'enterpriseUrl',
    message: 'Enter your GitHub Enterprise URL or domain',
    placeholder: 'company.ghe.com',
    when: { key: 'deploymentType', op: 'eq', value: 'enterprise' },
  },
];

describe('parseAuthPrompts', () => {
  test('parses select and conditional text prompts', () => {
    const prompts = parseAuthPrompts(copilotPrompts);

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toEqual({
      type: 'select',
      key: 'deploymentType',
      message: 'Select GitHub deployment type',
      options: [
        { value: 'github.com', label: 'GitHub.com', hint: 'Public' },
        { value: 'enterprise', label: 'GitHub Enterprise' },
      ],
    });
    expect(prompts[1]).toEqual({
      type: 'text',
      key: 'enterpriseUrl',
      message: 'Enter your GitHub Enterprise URL or domain',
      options: [],
      placeholder: 'company.ghe.com',
      when: { key: 'deploymentType', op: 'eq', value: 'enterprise' },
    });
  });

  test('returns an empty list for a method without prompts', () => {
    expect(parseAuthPrompts(undefined)).toEqual([]);
    expect(parseAuthPrompts(null)).toEqual([]);
    expect(parseAuthPrompts({})).toEqual([]);
  });

  test('drops entries that could never be answered', () => {
    const prompts = parseAuthPrompts([
      { type: 'text', message: 'no key' },
      { type: 'select', key: 'empty', message: 'no options', options: [] },
      { type: 'text', key: 'keep', message: 'keep me' },
    ]);

    expect(prompts.map((prompt) => prompt.key)).toEqual(['keep']);
  });

  test('falls back to the key when a message is missing', () => {
    expect(parseAuthPrompts([{ type: 'text', key: 'token' }])[0]?.message).toBe('token');
  });

  test('ignores a malformed when condition instead of hiding the prompt', () => {
    const [prompt] = parseAuthPrompts([
      { type: 'text', key: 'url', message: 'URL', when: { key: 'other', op: 'contains', value: 'x' } },
    ]);

    expect(prompt.when).toBe(undefined);
    expect(isPromptVisible(prompt, {})).toBe(true);
  });
});

describe('prompt visibility', () => {
  const prompts = parseAuthPrompts(copilotPrompts);

  test('hides a conditional prompt until its branch is selected', () => {
    expect(visiblePrompts(prompts, { deploymentType: 'github.com' }).map((p) => p.key))
      .toEqual(['deploymentType']);
    expect(visiblePrompts(prompts, { deploymentType: 'enterprise' }).map((p) => p.key))
      .toEqual(['deploymentType', 'enterpriseUrl']);
  });

  test('supports neq conditions', () => {
    const prompt: AuthPrompt = {
      type: 'text',
      key: 'custom',
      message: 'Custom',
      options: [],
      when: { key: 'mode', op: 'neq', value: 'default' },
    };

    expect(isPromptVisible(prompt, { mode: 'default' })).toBe(false);
    expect(isPromptVisible(prompt, { mode: 'other' })).toBe(true);
    expect(isPromptVisible(prompt, {})).toBe(true);
  });
});

describe('prompt answers', () => {
  const prompts = parseAuthPrompts(copilotPrompts);

  test('preselects the first select option so the form starts answerable', () => {
    expect(defaultPromptValues(prompts)).toEqual({ deploymentType: 'github.com', enterpriseUrl: '' });
    expect(firstUnansweredPrompt(prompts, defaultPromptValues(prompts))).toBeNull();
  });

  test('reports the hidden-then-revealed field as unanswered', () => {
    const values = { deploymentType: 'enterprise', enterpriseUrl: '   ' };

    expect(firstUnansweredPrompt(prompts, values)?.key).toBe('enterpriseUrl');
  });

  test('omits answers whose prompt is no longer visible', () => {
    const values = { deploymentType: 'github.com', enterpriseUrl: 'left-over.ghe.com' };

    expect(collectPromptInputs(prompts, values)).toEqual({ deploymentType: 'github.com' });
  });

  test('trims submitted answers', () => {
    const values = { deploymentType: 'enterprise', enterpriseUrl: '  company.ghe.com  ' };

    expect(collectPromptInputs(prompts, values)).toEqual({
      deploymentType: 'enterprise',
      enterpriseUrl: 'company.ghe.com',
    });
  });
});

describe('parseAuthorization', () => {
  test('reads a device-code authorization and recovers the code from instructions', () => {
    const authorization = parseAuthorization({
      url: 'https://github.com/login/device',
      instructions: 'Enter code: 1A2B-3C4D',
      method: 'auto',
    });

    expect(authorization).toEqual({
      method: 'auto',
      url: 'https://github.com/login/device',
      instructions: 'Enter code: 1A2B-3C4D',
      userCode: '1A2B-3C4D',
    });
  });

  test('keeps an explicitly reported code over the instructions match', () => {
    expect(parseAuthorization({
      url: 'https://example.com',
      instructions: 'Enter code: AAAA-BBBB',
      user_code: 'ZZZZ-9999',
      method: 'auto',
    })?.userCode).toBe('ZZZZ-9999');
  });

  test('preserves the code method', () => {
    expect(parseAuthorization({ url: 'https://example.com', method: 'code' })?.method).toBe('code');
  });

  test('treats a missing or unknown method as auto', () => {
    expect(parseAuthorization({ url: 'https://example.com' })?.method).toBe('auto');
    expect(parseAuthorization({ url: 'https://example.com', method: 'device' })?.method).toBe('auto');
  });

  test('unwraps a nested data envelope', () => {
    expect(parseAuthorization({ data: { url: 'https://example.com', method: 'code' } })).toEqual({
      method: 'code',
      url: 'https://example.com',
    });
  });

  test('accepts device-authorization field names', () => {
    expect(parseAuthorization({
      verification_uri_complete: 'https://example.com/activate?code=1',
      message: 'Open the link',
    })).toEqual({
      method: 'auto',
      url: 'https://example.com/activate?code=1',
      instructions: 'Open the link',
    });
  });

  test('returns null when nothing is actionable', () => {
    expect(parseAuthorization(null)).toBeNull();
    expect(parseAuthorization({})).toBeNull();
    expect(parseAuthorization({ method: 'auto' })).toBeNull();
  });
});

describe('describeOAuthError', () => {
  const t: ProviderOAuthTranslator = (key) => key;
  const fallback = 'settings.providers.page.toast.oauthCompleteFailed';

  /** Names come from OpenCode's ProviderAuthApiError schema. */
  test('maps each provider auth error name to its own message', () => {
    expect(describeOAuthError({ name: 'ProviderAuthOauthMissing', data: {} }, t, fallback))
      .toBe('settings.providers.page.auth.oauth.error.sessionExpired');
    expect(describeOAuthError({ name: 'ProviderAuthOauthCodeMissing', data: {} }, t, fallback))
      .toBe('settings.providers.page.auth.oauth.error.codeRequired');
    expect(describeOAuthError({ name: 'ProviderAuthOauthCallbackFailed', data: {} }, t, fallback))
      .toBe('settings.providers.page.auth.oauth.error.declined');
  });

  test('surfaces the plugin-authored validation message verbatim', () => {
    const error = {
      name: 'ProviderAuthValidationFailed',
      data: { field: 'enterpriseUrl', message: 'URL or domain is required' },
    };

    expect(describeOAuthError(error, t, fallback)).toBe('URL or domain is required');
  });

  test('falls back when a validation failure carries no message', () => {
    expect(describeOAuthError({ name: 'ProviderAuthValidationFailed', data: {} }, t, fallback))
      .toBe('settings.providers.page.auth.oauth.error.invalidInput');
  });

  test('falls back for unknown, empty, and non-object errors', () => {
    expect(describeOAuthError({ name: 'BadRequest', data: {} }, t, fallback)).toBe(fallback);
    expect(describeOAuthError(new Error('network down'), t, fallback)).toBe(fallback);
    expect(describeOAuthError(undefined, t, fallback)).toBe(fallback);
  });
});
