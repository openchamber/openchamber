import { describe, expect, it } from 'vitest';
import {
  resolveDiscordGatewayProxy,
  shouldBypassProxy,
} from './discord-proxy-agent.js';

describe('Discord gateway proxy resolution', () => {
  it('honors NO_PROXY wildcard, suffix, and port-specific rules', () => {
    expect(shouldBypassProxy({ hostname: 'gateway.discord.gg', port: 443, noProxy: '*' })).toBe(true);
    expect(shouldBypassProxy({ hostname: 'gateway.discord.gg', port: 443, noProxy: '.discord.gg' })).toBe(true);
    expect(shouldBypassProxy({ hostname: 'gateway.discord.gg', port: 443, noProxy: 'discord.gg:80' })).toBe(false);
    expect(shouldBypassProxy({ hostname: 'gateway.discord.gg', port: 443, noProxy: 'discord.gg:443' })).toBe(true);
  });

  it('uses HTTPS_PROXY for wss gateway targets and ALL_PROXY as fallback', () => {
    expect(resolveDiscordGatewayProxy({
      targetUrl: 'wss://gateway.discord.gg/?v=10&encoding=json',
      env: {
        HTTPS_PROXY: 'http://proxy.example:8080',
        HTTP_PROXY: 'http://wrong.example:8080',
      },
    })?.toString()).toBe('http://proxy.example:8080/');

    expect(resolveDiscordGatewayProxy({
      targetUrl: 'wss://gateway.discord.gg/?v=10&encoding=json',
      env: {
        ALL_PROXY: 'https://fallback.example:8443',
      },
    })?.toString()).toBe('https://fallback.example:8443/');
  });

  it('returns null when NO_PROXY matches the Discord gateway target', () => {
    expect(resolveDiscordGatewayProxy({
      targetUrl: 'wss://gateway.discord.gg/?v=10&encoding=json',
      env: {
        HTTPS_PROXY: 'http://proxy.example:8080',
        NO_PROXY: 'gateway.discord.gg',
      },
    })).toBeNull();
  });
});
