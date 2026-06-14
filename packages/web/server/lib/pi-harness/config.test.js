import { describe, expect, test } from 'bun:test';
import { isPiHarnessRuntimeEnabled, resolvePiHarnessConfig } from './config.js';

describe('Pi-Harness config', () => {
  test('is enabled only by explicit runtime selector', () => {
    expect(isPiHarnessRuntimeEnabled({ OPENCHAMBER_BACKEND_RUNTIME: 'pi-harness' })).toBe(true);
    expect(isPiHarnessRuntimeEnabled({ OPENCHAMBER_BACKEND_RUNTIME: 'opencode' })).toBe(false);
    expect(isPiHarnessRuntimeEnabled({})).toBe(false);
  });

  test('normalizes config defaults', () => {
    const config = resolvePiHarnessConfig({ OPENCHAMBER_BACKEND_RUNTIME: 'pi-harness' });
    expect(config.enabled).toBe(true);
    expect(config.baseUrl).toBe('http://127.0.0.1:8080');
    expect(config.apiKey).toBe(null);
    expect(config.providerID).toBe('pi-harness');
    expect(config.modelID).toBe('pi-default');
  });

  test('normalizes configured URL and model fields', () => {
    const config = resolvePiHarnessConfig({
      OPENCHAMBER_BACKEND_RUNTIME: 'pi-harness',
      PI_HARNESS_URL: 'http://localhost:8080/',
      PI_HARNESS_API_KEY: 'secret',
      PI_HARNESS_PROVIDER: 'openrouter',
      PI_HARNESS_MODEL: 'claude-sonnet-4',
    });
    expect(config.baseUrl).toBe('http://localhost:8080');
    expect(config.apiKey).toBe('secret');
    expect(config.providerID).toBe('openrouter');
    expect(config.modelID).toBe('claude-sonnet-4');
  });
});
