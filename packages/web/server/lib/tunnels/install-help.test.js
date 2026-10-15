import { describe, expect, it } from 'bun:test';

import { getTunnelDependencyInstallInfo } from './install-help.js';
import {
  TUNNEL_PROVIDER_CLOUDFLARE,
  TUNNEL_PROVIDER_NGROK,
  TUNNEL_PROVIDER_TAILSCALE,
} from './types.js';

describe('getTunnelDependencyInstallInfo', () => {
  it('returns Windows cloudflared winget guidance', () => {
    const info = getTunnelDependencyInstallInfo(TUNNEL_PROVIDER_CLOUDFLARE, 'win32');

    expect(info.dependency).toBe('cloudflared');
    expect(info.installCommand).toBe('winget install --id Cloudflare.cloudflared');
    expect(info.message).toContain('Cloudflare.cloudflared');
  });

  it('returns Windows ngrok winget guidance', () => {
    const info = getTunnelDependencyInstallInfo(TUNNEL_PROVIDER_NGROK, 'win32');

    expect(info.dependency).toBe('ngrok');
    expect(info.installCommand).toBe('winget install ngrok -s msstore');
    expect(info.message).toContain('ngrok -s msstore');
  });

  it('keeps macOS Homebrew guidance', () => {
    const info = getTunnelDependencyInstallInfo(TUNNEL_PROVIDER_CLOUDFLARE, 'darwin');

    expect(info.installCommand).toBe('brew install cloudflared');
  });

  it('returns the current Linux cloudflared download guidance', () => {
    const info = getTunnelDependencyInstallInfo(TUNNEL_PROVIDER_CLOUDFLARE, 'linux');
    const downloadUrl = 'https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/';

    expect(info.installUrl).toBe(downloadUrl);
    expect(info.installCommand).toBe(`Download cloudflared from ${downloadUrl}`);
    expect(info.message).toContain(downloadUrl);
  });

  it('returns Tailscale install guidance across platforms', () => {
    const macInfo = getTunnelDependencyInstallInfo(TUNNEL_PROVIDER_TAILSCALE, 'darwin');
    expect(macInfo.dependency).toBe('tailscale');
    expect(macInfo.installCommand).toBe('brew install tailscale');

    const winInfo = getTunnelDependencyInstallInfo(TUNNEL_PROVIDER_TAILSCALE, 'win32');
    expect(winInfo.dependency).toBe('tailscale');
    expect(winInfo.installCommand).toBe('winget install Tailscale.Tailscale');

    const linuxInfo = getTunnelDependencyInstallInfo(TUNNEL_PROVIDER_TAILSCALE, 'linux');
    expect(linuxInfo.dependency).toBe('tailscale');
    expect(linuxInfo.installCommand).toBe('Download Tailscale from https://tailscale.com/download');
  });
});

