import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// Every provider module is linked when the registry loads. One stale import
// (an export main removed) fails the whole registry and every quota route with
// it, while each provider's own tests can still pass with injected readers.
// Vitest's module transform does not reject a missing named export, so the
// registry is linked by Node itself.
describe('quota provider registry', () => {
  it('links every provider module under Node', () => {
    const registryUrl = new URL('./index.js', import.meta.url).href;
    const output = execFileSync(process.execPath, [
      '--input-type=module',
      '-e',
      `const registry = await import(${JSON.stringify(registryUrl)}); console.log(typeof registry.fetchQuotaForProvider);`,
    ], { encoding: 'utf8' });
    expect(output.trim()).toBe('function');
  }, 20_000);
});
