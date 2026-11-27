import { describe, expect, test } from 'bun:test';
import { parseDeepLink } from './deepLinks';

describe('Usage provider deep-links for Android home widgets', () => {
  test('opens a built-in quota provider', () => {
    expect(parseDeepLink('openchamber://settings/usage?provider=cursor')).toEqual({
      type: 'settings', section: 'usage', providerId: 'cursor',
    });
  });

  test('opens extension-supplied quota providers without the SDK guest', () => {
    expect(parseDeepLink('openchamber://settings/usage?provider=ext-antigravity-usage')).toEqual({
      type: 'settings', section: 'usage', providerId: 'ext-antigravity-usage',
    });
  });

  test('keeps the ordinary Usage destination without a provider', () => {
    expect(parseDeepLink('openchamber://settings/usage')).toEqual({
      type: 'settings', section: 'usage',
    });
  });

  test('ignores provider selection outside Usage and malformed provider ids', () => {
    expect(parseDeepLink('openchamber://settings/appearance?provider=cursor')).toEqual({
      type: 'settings', section: 'appearance',
    });
    expect(parseDeepLink('openchamber://settings/usage?provider=..%2Fsecrets')).toEqual({
      type: 'settings', section: 'usage',
    });
  });
});

describe('New session deep-links', () => {
  test('a link cannot ask the new draft to record', () => {
    // Any app or web page can open a link; the app icon's Dictate action uses the native shortcut channel.
    expect(parseDeepLink('openchamber://new-session?dictate=1')).toEqual({
      type: 'new-session', directory: undefined, projectId: undefined, agent: undefined, model: undefined,
    });
  });
});

describe('Tracker item deep-links from pull request notifications', () => {
  test('reads the pull request and the project folder the sealed push carries', () => {
    expect(parseDeepLink('openchamber://tracker-item?url=https%3A%2F%2Fgithub.com%2Facme%2Fapp%2Fpull%2F7&dir=%2Fwork%2Fapp')).toEqual({
      type: 'tracker-item', url: 'https://github.com/acme/app/pull/7', directory: '/work/app',
    });
    expect(parseDeepLink('openchamber://tracker-item?url=https%3A%2F%2Fgithub.com%2Facme%2Fapp%2Fpull%2F7')).toEqual({
      type: 'tracker-item', url: 'https://github.com/acme/app/pull/7',
    });
  });

  test('needs an address', () => {
    expect(parseDeepLink('openchamber://tracker-item?dir=%2Fwork%2Fapp')).toBeNull();
  });
});
