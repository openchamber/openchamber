import { describe, expect, test } from 'bun:test';
import type { FormField } from '@opencode/client';
import {
  collectFieldAnswer,
  defaultFieldValues,
  describeOAuthError,
  extractUserCode,
  fieldLabel,
  firstUnansweredField,
  isFieldVisible,
  shouldOpenAuthorizationUrl,
  visibleFields,
  type ProviderOAuthTranslator,
} from './provider-oauth';

describe('shouldOpenAuthorizationUrl', () => {
  test('lets Claude Code CLI own browser launch', () => {
    expect(shouldOpenAuthorizationUrl('claude-code', 'https://docs.example')).toBe(false);
    expect(shouldOpenAuthorizationUrl('github-copilot', 'https://github.com/login')).toBe(true);
  });
});

/** Mirrors the github-copilot integration method shipped by OpenCode. */
const copilotFields: FormField[] = [
  {
    type: 'string',
    key: 'deploymentType',
    title: 'Select GitHub deployment type',
    required: true,
    options: [
      { label: 'GitHub.com', value: 'github.com', description: 'Public' },
      { label: 'GitHub Enterprise', value: 'enterprise' },
    ],
  },
  {
    type: 'string',
    key: 'enterpriseUrl',
    title: 'Enter your GitHub Enterprise URL or domain',
    required: true,
    placeholder: 'company.ghe.com',
    when: [{ key: 'deploymentType', op: 'eq', value: 'enterprise' }],
  },
];

describe('fieldLabel', () => {
  test('falls back to the key when a field has no title', () => {
    expect(fieldLabel({ type: 'string', key: 'token' })).toBe('token');
    expect(fieldLabel(copilotFields[0])).toBe('Select GitHub deployment type');
  });
});

describe('field visibility', () => {
  test('hides a conditional field until its branch is selected', () => {
    expect(visibleFields(copilotFields, { deploymentType: 'github.com' }).map((f) => f.key))
      .toEqual(['deploymentType']);
    expect(visibleFields(copilotFields, { deploymentType: 'enterprise' }).map((f) => f.key))
      .toEqual(['deploymentType', 'enterpriseUrl']);
  });

  test('supports neq conditions', () => {
    const field: FormField = {
      type: 'string',
      key: 'custom',
      title: 'Custom',
      when: [{ key: 'mode', op: 'neq', value: 'default' }],
    };

    expect(isFieldVisible(field, { mode: 'default' })).toBe(false);
    expect(isFieldVisible(field, { mode: 'other' })).toBe(true);
    // An unanswered controlling field satisfies neither `eq` nor `neq`, as on the server.
    expect(isFieldVisible(field, {})).toBe(false);
  });

  test('a hidden field cannot reveal a later one through its value', () => {
    const fields: FormField[] = [
      { type: 'string', key: 'mode', title: 'Mode' },
      { type: 'string', key: 'region', title: 'Region', when: [{ key: 'mode', op: 'eq', value: 'cloud' }] },
      { type: 'string', key: 'endpoint', title: 'Endpoint', when: [{ key: 'region', op: 'eq', value: 'eu' }] },
    ];
    expect(visibleFields(fields, { mode: 'local', region: 'eu' }).map((f) => f.key)).toEqual(['mode']);
    expect(visibleFields(fields, { mode: 'cloud', region: 'eu' }).map((f) => f.key)).toEqual(['mode', 'region', 'endpoint']);
  });

  test('an external field carries no conditions and always shows', () => {
    expect(isFieldVisible({ type: 'external', key: 'docs', url: 'https://example.com' }, {})).toBe(true);
  });
});

describe('field answers', () => {
  test('preselects the first option so the form starts answerable', () => {
    expect(defaultFieldValues(copilotFields)).toEqual({ deploymentType: 'github.com', enterpriseUrl: '' });
    expect(firstUnansweredField(copilotFields, defaultFieldValues(copilotFields))).toBeNull();
  });

  test('honours a declared default over the first option', () => {
    const values = defaultFieldValues([
      { type: 'string', key: 'region', default: 'eu', options: [{ label: 'US', value: 'us' }] },
      { type: 'boolean', key: 'beta', default: true },
      { type: 'integer', key: 'retries', default: 3 },
      { type: 'multiselect', key: 'scopes', options: [{ label: 'Read', value: 'read' }] },
    ]);

    expect(values).toEqual({ region: 'eu', beta: true, retries: 3, scopes: [] });
  });

  test('reports the hidden-then-revealed required field as unanswered', () => {
    const values = { deploymentType: 'enterprise', enterpriseUrl: '   ' };

    expect(firstUnansweredField(copilotFields, values)?.key).toBe('enterpriseUrl');
  });

  test('never blocks on an optional field left blank', () => {
    const optional: FormField[] = [{ type: 'string', key: 'note' }];

    expect(firstUnansweredField(optional, { note: '' })).toBeNull();
  });

  test('omits answers whose field is no longer visible', () => {
    const values = { deploymentType: 'github.com', enterpriseUrl: 'left-over.ghe.com' };

    expect(collectFieldAnswer(copilotFields, values)).toEqual({ deploymentType: 'github.com' });
  });

  test('trims submitted answers and drops blanks', () => {
    const values = { deploymentType: 'enterprise', enterpriseUrl: '  company.ghe.com  ' };

    expect(collectFieldAnswer(copilotFields, values)).toEqual({
      deploymentType: 'enterprise',
      enterpriseUrl: 'company.ghe.com',
    });
    expect(collectFieldAnswer(copilotFields, { deploymentType: '  ' })).toEqual({});
  });

  test('keeps non-string answers as they are', () => {
    const fields: FormField[] = [
      { type: 'boolean', key: 'beta' },
      { type: 'multiselect', key: 'scopes', options: [{ label: 'Read', value: 'read' }] },
    ];

    expect(collectFieldAnswer(fields, { beta: false, scopes: ['read'] })).toEqual({
      beta: false,
      scopes: ['read'],
    });
  });
});

describe('extractUserCode', () => {
  test('recovers a device code out of the instructions', () => {
    expect(extractUserCode('Enter code: 1A2B-3C4D')).toBe('1A2B-3C4D');
    expect(extractUserCode('Open the link')).toBe(undefined);
  });
});

describe('describeOAuthError', () => {
  const t: ProviderOAuthTranslator = (key) => key;
  const fallback = 'settings.providers.page.toast.oauthCompleteFailed';

  /** Names come from OpenCode's integration OAuth error schema. */
  test('maps each integration OAuth error name to its own message', () => {
    expect(describeOAuthError({ name: 'IntegrationOauthAttemptMissing', data: {} }, t, fallback))
      .toBe('settings.providers.page.auth.oauth.error.sessionExpired');
    expect(describeOAuthError({ name: 'IntegrationOauthCodeMissing', data: {} }, t, fallback))
      .toBe('settings.providers.page.auth.oauth.error.codeRequired');
    expect(describeOAuthError({ name: 'IntegrationOauthFailed', data: {} }, t, fallback))
      .toBe('settings.providers.page.auth.oauth.error.declined');
  });

  test('surfaces the integration-authored validation message verbatim', () => {
    const error = {
      name: 'IntegrationValidationFailed',
      data: { field: 'enterpriseUrl', message: 'URL or domain is required' },
    };

    expect(describeOAuthError(error, t, fallback)).toBe('URL or domain is required');
  });

  test('falls back when a validation failure carries no message', () => {
    expect(describeOAuthError({ name: 'IntegrationValidationFailed', data: {} }, t, fallback))
      .toBe('settings.providers.page.auth.oauth.error.invalidInput');
  });

  test('prefers a server-authored message over the fallback key', () => {
    expect(describeOAuthError({ message: 'network down' }, t, fallback)).toBe('network down');
  });

  test('falls back for unknown, empty, and non-object errors', () => {
    expect(describeOAuthError({ name: 'BadRequest', data: {} }, t, fallback)).toBe(fallback);
    expect(describeOAuthError(undefined, t, fallback)).toBe(fallback);
    expect(describeOAuthError({}, t, fallback)).toBe(fallback);
  });
});
