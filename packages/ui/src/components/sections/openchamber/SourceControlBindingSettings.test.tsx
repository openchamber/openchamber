import { expect, test } from 'bun:test';

test('every locale supplies repository context copy', async () => {
  const keys = ['configure', 'description', 'needsAttention', 'settings'];
  for (const locale of ['en', 'de', 'es', 'fr', 'ja', 'ko', 'pl', 'pt-BR', 'uk', 'zh-CN', 'zh-TW']) {
    const { dict } = await import(`../../../lib/i18n/messages/${locale}.ts`);
    for (const key of keys) expect(dict[`gitView.context.${key}`]).toBeTruthy();
  }
});

test('every locale supplies checkout hydration repair copy', async () => {
  const keys = [
    'title', 'description', 'parentRemote', 'retry', 'endpoint', 'chooseEndpoint',
    'identity', 'authorizationNeeded', 'systemConfirmation', 'lfsMissing', 'kind.submodule', 'kind.lfs',
    'status.succeeded', 'status.failed', 'status.cancelled', 'status.authorization-required',
    'status.invalid', 'status.client-missing', 'status.not-needed',
  ] as const;
  const { dict: english } = await import('../../../lib/i18n/messages/en.ts');
  for (const locale of ['en', 'de', 'es', 'fr', 'ja', 'ko', 'pl', 'pt-BR', 'uk', 'zh-CN', 'zh-TW']) {
    const { dict } = await import(`../../../lib/i18n/messages/${locale}.ts`);
    for (const key of keys) {
      const messageKey = `gitView.hydration.${key}` as const;
      expect(dict[messageKey]).toBeTruthy();
      if (locale !== 'en' && !['kind.lfs'].includes(key)) expect(dict[messageKey]).not.toBe(english[messageKey]);
    }
  }
});

test('every locale supplies the copy for a repository\u2019s other remotes', async () => {
  const { dict: english } = await import('../../../lib/i18n/messages/en.ts');
  for (const locale of ['en', 'de', 'es', 'fr', 'ja', 'ko', 'pl', 'pt-BR', 'tr', 'uk', 'zh-CN', 'zh-TW']) {
    const { dict } = await import(`../../../lib/i18n/messages/${locale}.ts`);
    for (const key of ['title', 'description', 'grant'] as const) {
      const messageKey = `gitView.remotes.${key}` as const;
      expect(dict[messageKey]).toBeTruthy();
      if (locale !== 'en') expect(dict[messageKey]).not.toBe(english[messageKey]);
    }
    // The button names the identity it would answer as.
    expect(dict['gitView.remotes.grant']).toContain('{identity}');
    // The hydration editor asks for an identity per endpoint, and says what a
    // stopped run needs; Turkish is covered here because the older lists above
    // exempt it over Git terms it keeps untranslated.
    for (const key of ['gitView.hydration.identity', 'gitView.hydration.authorizationNeeded'] as const) {
      expect(dict[key]).toBeTruthy();
      if (locale !== 'en') expect(dict[key]).not.toBe(english[key]);
    }
    // And the identity strip says what a stale binding needs, not only that it does.
    expect(dict['gitView.identity.configChanged']).toBeTruthy();
    if (locale !== 'en') {
      expect(dict['gitView.identity.configChanged']).not.toBe(english['gitView.identity.configChanged']);
    }
  }
});
