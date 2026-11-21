import { describe, expect, test } from 'bun:test';
import { providerLogoIds } from './useProviderLogo';

describe('provider logo aliases', () => {
    test('maps rotating exe.dev proxy provider IDs to the local exe.dev logo', () => {
        expect(providerLogoIds('exe-proxy-123')[1]).toBe('exe-dev');
    });

    test('aliases the copilot provider id to the bundled github-copilot logo', () => {
        expect(providerLogoIds('copilot')[1]).toBe('github-copilot');
    });
});
