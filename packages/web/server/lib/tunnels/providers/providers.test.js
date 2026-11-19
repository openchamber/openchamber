import { describe, expect, it } from 'vitest';
import { normalizeTunnelStartRequest, validateTunnelStartRequest } from '../types.js';
import { createCloudflareTunnelProvider } from './cloudflare.js';
import { createNgrokTunnelProvider } from './ngrok.js';
import { createTailscaleTunnelProvider } from './tailscale.js';

const providers = [
  ['cloudflare', createCloudflareTunnelProvider],
  ['ngrok', createNgrokTunnelProvider],
  ['tailscale', createTailscaleTunnelProvider],
];

describe('tunnel provider contracts', () => {
  it.each(providers)('%s tolerates absent controllers and optional methods', (id, createProvider) => {
    const provider = createProvider();
    expect(provider.id).toBe(id);
    expect(provider.resolvePublicUrl(null)).toBeNull();
    expect(provider.resolvePublicUrl({})).toBeNull();
    expect(provider.stop(null)).toBeUndefined();
    let stopped = false;
    provider.stop({ stop: () => { stopped = true; } });
    expect(stopped).toBe(true);
    expect(provider.resolvePublicUrl({ getPublicUrl: () => 'https://example.com' })).toBe('https://example.com');
  });

  it.each([['tailscale', createTailscaleTunnelProvider]])('%s advertises a valid default mode', (id, createProvider) => {
    const { capabilities } = createProvider();
    expect(capabilities.provider).toBe(id);
    const request = normalizeTunnelStartRequest({ provider: id, mode: capabilities.defaults.mode });
    expect(() => validateTunnelStartRequest(request, capabilities)).not.toThrow();
  });

  it('keeps Cloudflare metadata absent when the controller has none', () => {
    const provider = createCloudflareTunnelProvider();
    expect(provider.getMetadata(null)).toEqual({ configPath: null, resolvedHostname: null });
    expect(provider.getMetadata({ getEffectiveConfigPath: () => 'config.yml', getResolvedHostname: () => 'example.com' }))
      .toEqual({ configPath: 'config.yml', resolvedHostname: 'example.com' });
  });

  it('requires an origin before starting a Cloudflare quick tunnel', async () => {
    await expect(createCloudflareTunnelProvider().start({ mode: 'quick' }))
      .rejects.toMatchObject({ code: 'validation_error', message: 'originUrl is required for quick tunnel mode' });
  });

  it('refuses unsupported ngrok modes before starting a process', async () => {
    await expect(createNgrokTunnelProvider().start({ mode: 'serve' }))
      .rejects.toMatchObject({ code: 'mode_unsupported' });
  });

  it.each([undefined, null, 3.5, NaN, Infinity])('refuses a noninteger local Tailscale port: %j', async (activePort) => {
    await expect(createTailscaleTunnelProvider().start({ mode: 'serve' }, { activePort }))
      .rejects.toMatchObject({ code: 'startup_failed', message: 'OpenChamber has no local port to share yet' });
  });

  it('refuses a missing Tailscale context before resolving an executable', async () => {
    await expect(createTailscaleTunnelProvider().start({ mode: 'serve' }))
      .rejects.toMatchObject({ code: 'startup_failed' });
  });

  it('shares the same HTTPS ports between Tailscale modes', () => {
    const { capabilities } = createTailscaleTunnelProvider();
    expect(capabilities.modes.map(({ key, httpsPorts }) => ({ key, httpsPorts }))).toEqual([
      { key: 'serve', httpsPorts: [443, 8443, 10000] },
      { key: 'funnel', httpsPorts: [443, 8443, 10000] },
    ]);
    expect(createTailscaleTunnelProvider().getMetadata()).toBeNull();
  });
});
