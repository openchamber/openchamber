import { describe, expect, it } from 'vitest';

import { dockerHostOf, sshHostSchema } from './ssh-host.js';

describe('the machine of the Docker over SSH place', () => {
  it('takes an SSH destination, with a user and a port or without, and makes the docker host of it', () => {
    expect(dockerHostOf('debian-box')).toBe('ssh://debian-box');
    expect(dockerHostOf(' me@box.local:2222 ')).toBe('ssh://me@box.local:2222');
    expect(dockerHostOf('192.168.1.20')).toBe('ssh://192.168.1.20');
  });

  it('means no place for the empty string, nothing, or anything that is not a destination', () => {
    expect(dockerHostOf('')).toBeNull();
    expect(dockerHostOf(undefined)).toBeNull();
    expect(dockerHostOf(null)).toBeNull();
    // An option, a second word, a shell character, a scheme, a port that is not one: none is a destination.
    for (const bad of ['-oProxyCommand=evil', '-Jhost', 'me@-Jhost', '-J@host', 'box -p 22', 'box;rm -rf', 'ssh://box', 'box:0', 'box:123456', 'a'.repeat(254), '@box', 'box@']) {
      expect(dockerHostOf(bad), bad).toBeNull();
      expect(sshHostSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});
