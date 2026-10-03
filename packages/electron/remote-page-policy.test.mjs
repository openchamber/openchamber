import { describe, expect, test } from 'bun:test';
import { isSplashColor, redactHostsConfigForRemote } from './remote-page-policy.mjs';

describe('isSplashColor', () => {
  test('accepts the colour forms themes produce', () => {
    for (const value of ['#151313', '#fff', '#FFFCF0cc', 'rgb(21, 19, 19)', 'rgba(21 19 19 / 0.5)', 'hsl(20 5% 8%)', 'oklch(0.2 0.01 30)']) {
      expect(isSplashColor(value)).toBe(true);
    }
  });

  test('refuses anything that could leave the CSS declaration', () => {
    for (const value of [
      'red;}</style><script>alert(1)</script>',
      '#fff;background:url(https://example.test/x)',
      'url(https://example.test/x)',
      'rgb(1,2,3)}',
      'var(--x)',
      '',
      null,
    ]) {
      expect(isSplashColor(value)).toBe(false);
    }
  });
});

describe('redactHostsConfigForRemote', () => {
  test('keeps the host list but drops every credential', () => {
    const config = {
      hosts: [
        { id: 'a', label: 'Work', url: 'https://work.test', clientToken: 'secret-a', requestHeaders: { 'CF-Access-Client-Secret': 's' } },
        { id: 'b', label: 'Relay', url: 'relay://b', relay: { serverId: 'b' }, clientToken: 'secret-b' },
      ],
      defaultHostId: 'a',
      initialHostChoiceCompleted: true,
      localOrigin: 'http://127.0.0.1:3000',
    };

    expect(redactHostsConfigForRemote(config)).toEqual({
      hosts: [
        { id: 'a', label: 'Work', url: 'https://work.test' },
        { id: 'b', label: 'Relay', url: 'relay://b', relay: { serverId: 'b' } },
      ],
      defaultHostId: 'a',
      initialHostChoiceCompleted: true,
      localOrigin: 'http://127.0.0.1:3000',
    });
  });
});
