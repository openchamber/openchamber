import { describe, expect, test } from 'bun:test';

import { guestFramePolicy } from './frame-policy.ts';

const directive = (policy: string, name: string) => policy.split('; ').find((entry) => entry.startsWith(`${name} `));

describe('guestFramePolicy', () => {
  test('keeps a guest off the network by default', () => {
    const policy = guestFramePolicy(null);
    expect(directive(policy, 'default-src')).toBe("default-src 'none'");
    expect(directive(policy, 'connect-src')).toBe("connect-src 'none'");
    expect(directive(policy, 'img-src')).toBe("img-src 'self' data: blob:");
  });

  test('lets connections reach only the package path it is given', () => {
    expect(directive(guestFramePolicy('oc.test:3000/api/guests/demo/'), 'connect-src')).toBe('connect-src oc.test:3000/api/guests/demo/');
  });

  test('opens approved origins for data and assets, never for code', () => {
    const policy = guestFramePolicy('oc.test/api/guests/demo/', ['https://fonts.example.com']);
    for (const name of ['connect-src', 'img-src', 'font-src', 'style-src', 'media-src']) {
      expect(directive(policy, name)).toContain('https://fonts.example.com');
    }
    for (const name of ['script-src', 'worker-src', 'frame-src']) {
      expect(directive(policy, name)).not.toContain('https://fonts.example.com');
    }
    expect(directive(guestFramePolicy(null, ['https://a.test']), 'connect-src')).toBe('connect-src https://a.test');
  });
});
