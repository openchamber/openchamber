import { describe, expect, test } from 'bun:test';

import type { JsonValue } from './contract.ts';
import { GUEST_TONES } from './manifest.ts';
import { serviceHostCallSchema } from './service-host-schemas.ts';
import { SERVICE_HOST_METHODS, SERVICE_MARK_TEXT_MAX, SERVICE_MARK_URL_MAX } from './service-host.ts';

describe('marks.set', () => {
  const mark = { icon: 'close-circle', tone: 'error', text: '2 tests failed in auth.spec.ts' };
  const parse = (input: JsonValue) => serviceHostCallSchema.safeParse({ method: 'marks.set', input });

  test('is a call the host knows', () => {
    expect(SERVICE_HOST_METHODS).toContain('marks.set');
  });

  test('takes a session, a branch of a repository folder, or a folder', () => {
    const targets: JsonValue[] = [
      { sessionId: 'ses_1' },
      { directory: '/repo', branch: 'feature/login' },
      { directory: '/repo/.worktrees/login' },
      { directory: 'C:\\repo', branch: 'main' },
    ];
    for (const target of targets) expect(parse({ target, mark }).success, JSON.stringify(target)).toBe(true);
  });

  test('refuses a target that is none of them', () => {
    const targets: JsonValue[] = [
      {},
      { branch: 'main' },
      { sessionId: 'ses_1', directory: '/repo' },
      { sessionId: 'ses_1', branch: 'main' },
      { sessionId: '' },
      { sessionId: 7 },
      { directory: '' },
      { directory: '   ' },
      { directory: '/repo', branch: '' },
      { directory: '/repo', branch: 'x'.repeat(257) },
      { directory: 'x'.repeat(4097) },
      { directory: '/repo', project: 'p' },
      { directory: ['/repo'] },
      'ses_1',
      null,
      ['ses_1'],
    ];
    for (const target of targets) expect(parse({ target, mark }).success, JSON.stringify(target)).toBe(false);
    expect(parse({ mark }).success).toBe(false);
  });

  test('takes every tone, a null mark, and an https address', () => {
    for (const tone of GUEST_TONES) expect(parse({ target: { sessionId: 's' }, mark: { ...mark, tone } }).success, tone).toBe(true);
    expect(parse({ target: { sessionId: 's' }, mark: null }).success).toBe(true);
    expect(parse({ target: { sessionId: 's' }, mark: { ...mark, url: 'https://ci.example/runs/7?job=2#log' } }).success).toBe(true);
    expect(parse({ target: { sessionId: 's' }, mark: { ...mark, text: 'x'.repeat(SERVICE_MARK_TEXT_MAX) } }).success).toBe(true);
  });

  test('trims what it stores', () => {
    const parsed = parse({ target: { sessionId: ' s ' }, mark: { ...mark, text: '  failed  ', url: ' https://ci.example/runs/7 ' } });
    expect(parsed.success && parsed.data).toEqual({ method: 'marks.set', input: { target: { sessionId: 's' }, mark: { ...mark, text: 'failed', url: 'https://ci.example/runs/7' } } });
  });

  test('refuses a mark the host would not draw as it is', () => {
    const marks: JsonValue[] = [
      {},
      { ...mark, icon: '' },
      { ...mark, icon: 'Close Circle' },
      { ...mark, icon: 'icons/x.svg' },
      { ...mark, icon: '<svg onload=alert(1)>' },
      { ...mark, icon: 'a'.repeat(41) },
      { ...mark, tone: 'red' },
      { ...mark, tone: 'Error' },
      { ...mark, tone: '#f00' },
      { ...mark, tone: 'toString' },
      { icon: mark.icon, text: mark.text },
      { ...mark, text: '' },
      { ...mark, text: '   ' },
      { ...mark, text: 'x'.repeat(SERVICE_MARK_TEXT_MAX + 1) },
      { ...mark, text: ['failed'] },
      { ...mark, html: '<b>failed</b>' },
      { ...mark, color: 'red' },
      { ...mark, href: 'https://ci.example' },
      'close-circle',
      [mark],
      false,
    ];
    for (const hostile of marks) expect(parse({ target: { sessionId: 's' }, mark: hostile }).success, JSON.stringify(hostile)).toBe(false);
    expect(parse({ target: { sessionId: 's' } }).success).toBe(false);
    expect(parse({ target: { sessionId: 's' }, mark, extra: true }).success).toBe(false);
  });

  test('refuses an address that is not https, carries credentials or is too long', () => {
    const urls: JsonValue[] = [
      'http://ci.example/runs/7',
      'https://user:pass@ci.example/runs/7',
      'https://user@ci.example/runs/7',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'openchamber://open',
      '//ci.example/runs/7',
      '/runs/7',
      'ci.example/runs/7',
      '',
      `https://ci.example/${'x'.repeat(SERVICE_MARK_URL_MAX)}`,
      7,
      null,
      { href: 'https://ci.example' },
    ];
    for (const url of urls) expect(parse({ target: { sessionId: 's' }, mark: { ...mark, url } }).success, JSON.stringify(url)).toBe(false);
  });
});
