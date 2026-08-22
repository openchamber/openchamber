import { describe, expect, it } from 'vitest';

import { parseServeCliOptions } from './cli-options.js';

const parse = (argv = [], env = {}) => parseServeCliOptions({
  argv,
  env,
  defaultPort: 3000,
  cloudflareProvider: 'cloudflare',
  managedLocalMode: 'managed-local',
});

describe('serve CLI Tailscale HTTPS port options', () => {
  it('reads the Tailscale HTTPS port from the server environment', () => {
    expect(parse([], { OPENCHAMBER_TAILSCALE_HTTPS_PORT: '9443' }).tailscaleHttpsPort).toBe('9443');
  });

  it('parses the Tailscale HTTPS port flag in inline and separate forms', () => {
    expect(parse(['--tailscale-https-port=10000']).tailscaleHttpsPort).toBe('10000');
    expect(parse(['--tailscale-https-port', '9443']).tailscaleHttpsPort).toBe('9443');
  });
});
