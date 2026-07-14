import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';

const serverSource = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8');

const productionCall = (marker) => {
  const start = serverSource.indexOf(marker);
  if (start < 0) return '';
  const end = serverSource.indexOf('\n  });', start);
  return end < 0 ? '' : serverSource.slice(start, end + 5);
};

describe('production relay identity wiring', () => {
  it('constructs one shared runtime and injects it into both production consumers', () => {
    expect(serverSource.match(/createRelayIdentityRuntime\s*\(\s*\{/g)).toHaveLength(1);
    expect(serverSource).toMatch(/const relayIdentityRuntime = createRelayIdentityRuntime\(\{[\s\S]*?readSettingsStrict: readSettingsFromDiskStrict,[\s\S]*?\}\);/);
    expect(productionCall('const directE2eeRuntime = createDirectE2eeRuntime({')).toContain('identityRuntime: relayIdentityRuntime,');
    expect(productionCall('const relayService = createRelayService({')).toContain('identityRuntime: relayIdentityRuntime,');
  });
});
