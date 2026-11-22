import { describe, expect, it, vi } from 'vitest';

import { applySystemCertificates } from './system-ca.js';

const tlsWith = ({ defaults, system }) => ({
  getCACertificates: (store) => (store === 'system' ? system : defaults),
  setDefaultCACertificates: vi.fn(),
});

const apply = (tlsModule, { execArgv = [], nodeOptions = '' } = {}) =>
  applySystemCertificates({ tlsModule, execArgv, nodeOptions });

describe('applySystemCertificates', () => {
  it('adds the system certificates the defaults lack', () => {
    const tlsModule = tlsWith({ defaults: ['bundled', 'shared'], system: ['shared', 'company'] });
    expect(apply(tlsModule)).toBe(true);
    expect(tlsModule.setDefaultCACertificates).toHaveBeenCalledWith(['bundled', 'shared', 'company']);
  });

  it('leaves the defaults alone when the system adds nothing', () => {
    const tlsModule = tlsWith({ defaults: ['bundled'], system: ['bundled'] });
    expect(apply(tlsModule)).toBe(false);
    expect(tlsModule.setDefaultCACertificates).not.toHaveBeenCalled();
  });

  it('keeps the OpenSSL store a process started with --use-openssl-ca chose', () => {
    const tlsModule = tlsWith({ defaults: ['bundled'], system: ['company'] });
    expect(apply(tlsModule, { execArgv: ['--use-openssl-ca'] })).toBe(false);
    expect(apply(tlsModule, { nodeOptions: '--max-old-space-size=4096 --use-openssl-ca' })).toBe(false);
    expect(tlsModule.setDefaultCACertificates).not.toHaveBeenCalled();
  });

  it('is a no-op on runtimes without the API', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(apply({})).toBe(false);
    warn.mockRestore();
  });
});
