import { describe, expect, test } from 'bun:test';
import { COMMANDS_SAFE_FOR_REMOTE, isSplashColor, parseTrayLocale, redactHostsConfigForRemote } from './remote-page-policy.mjs';

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

  test('strips URL-embedded basic-auth credentials from url and apiUrl', () => {
    const config = {
      hosts: [
        {
          id: 'a',
          label: 'Work',
          url: 'https://user:pass@work.test:8443/base',
          apiUrl: 'https://user:pass@work.test:8443/api',
          clientToken: 'secret-a',
        },
        { id: 'b', label: 'Plain', url: 'https://plain.test', apiUrl: 'https://plain.test/api' },
      ],
      defaultHostId: 'a',
    };

    const redacted = redactHostsConfigForRemote(config);

    expect(redacted.hosts[0]).toEqual({
      id: 'a',
      label: 'Work',
      url: 'https://work.test:8443/base',
      apiUrl: 'https://work.test:8443/api',
    });
    expect(redacted.hosts[1]).toEqual({ id: 'b', label: 'Plain', url: 'https://plain.test', apiUrl: 'https://plain.test/api' });
    expect(JSON.stringify(redacted)).not.toContain('pass');
    // The stored config keeps its credentials: local callers and probing
    // at use time are unaffected.
    expect(config.hosts[0].url).toContain('user:pass@');
  });

  test('strips credentials from a label generated from the URL', () => {
    const config = {
      hosts: [{ id: 'c', label: 'https://user:pass@auto.test/base', url: 'https://user:pass@auto.test/base' }],
    };

    const redacted = redactHostsConfigForRemote(config);

    expect(redacted.hosts[0].label).toBe('https://auto.test/base');
    expect(JSON.stringify(redacted)).not.toContain('pass');
  });
});

describe('COMMANDS_SAFE_FOR_REMOTE', () => {
  test('lets a remote page move the tray to its language but not the native menus', () => {
    expect(COMMANDS_SAFE_FOR_REMOTE.has('desktop_set_tray_locale')).toBe(true);
    expect(COMMANDS_SAFE_FOR_REMOTE.has('desktop_set_locale')).toBe(false);
  });
});

describe('parseTrayLocale', () => {
  test('accepts the UI locale codes the tray has labels for', () => {
    for (const value of ['en', 'de', 'uk', 'pt-BR', 'zh-TW']) {
      expect(parseTrayLocale(value)).toBe(value);
    }
  });

  test('refuses anything else a remote page could send', () => {
    for (const value of ['xx', 'pt-br', '__proto__', 'toString', '', null, undefined, 42, ['de'], { locale: 'de' }]) {
      expect(parseTrayLocale(value)).toBeNull();
    }
  });
});
