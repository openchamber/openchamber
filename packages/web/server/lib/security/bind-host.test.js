import { describe, expect, it, vi } from 'vitest';
import {
  isLoopbackBindHost,
  isNetworkExposedBindHost,
  readAdvertisedLanUrl,
} from './bind-host.js';

describe('bind host exposure classification', () => {
  it('allows only proven loopback bind hosts without authentication', () => {
    for (const host of ['localhost', '127.0.0.1', '127.25.1.2', '::1', '[::1]', '::ffff:127.0.0.1']) {
      expect(isLoopbackBindHost(host), host).toBe(true);
      expect(isNetworkExposedBindHost(host), host).toBe(false);
    }
  });

  it('treats wildcard, LAN, IPv6 local, and unknown hosts as exposed', () => {
    for (const host of [
      '0.0.0.0',
      '0',
      '0x0',
      '::',
      '[::]',
      '192.168.1.10',
      '10.0.0.5',
      '172.16.0.2',
      '::ffff:192.168.1.10',
      'fe80::1',
      'fc00::1',
      'openchamber.local',
      'example.com',
      '',
    ]) {
      expect(isLoopbackBindHost(host), host).toBe(false);
      expect(isNetworkExposedBindHost(host), host).toBe(true);
    }
  });
});

describe('readAdvertisedLanUrl', () => {
  it('returns the origin of a valid http(s) URL', () => {
    const logger = { warn: vi.fn() };
    expect(readAdvertisedLanUrl({ OPENCHAMBER_LAN_URL: ' http://192.168.1.20:3000/ ' }, logger)).toBe('http://192.168.1.20:3000');
    expect(readAdvertisedLanUrl({ OPENCHAMBER_LAN_URL: 'https://nas.local' }, logger)).toBe('https://nas.local');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('is null when unset', () => {
    expect(readAdvertisedLanUrl({})).toBeNull();
  });

  it('ignores values that are not an origin, with a warning', () => {
    for (const value of ['192.168.1.20:3000', 'ftp://host', 'http://host:3000/app', 'http://host?x=1']) {
      const logger = { warn: vi.fn() };
      expect(readAdvertisedLanUrl({ OPENCHAMBER_LAN_URL: value }, logger), value).toBeNull();
      expect(logger.warn).toHaveBeenCalledOnce();
    }
  });
});
