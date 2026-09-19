import { describe, expect, it } from 'vitest';
import { detectOpenCodeCliProtocol } from './cli-protocol.js';

const versionFixture = (version) => ({
  binary: process.execPath,
  args: ['-e', `process.stdout.write(${JSON.stringify(version)})`, '--'],
});

describe('OpenCode CLI protocol selection', () => {
  it.each([['1.18.31\n', 'legacy'], ['2.0.10\n', 'opencode2'], ['opencode v2.0.9\n', 'opencode2']])('recognizes %s independently of the executable name', async (version, protocol) => {
    await expect(detectOpenCodeCliProtocol(versionFixture(version))).resolves.toBe(protocol);
  });

  it.each(['', 'not a version', '0.0.0-beta-17639', '3.0.0'])('rejects unknown version output %s without selecting a managed lifecycle', async (version) => {
    await expect(detectOpenCodeCliProtocol(versionFixture(version))).rejects.toThrow('supported V1 or V2 version');
  });

  it('cancels a stalled version probe', async () => {
    const controller = new AbortController();
    const probe = detectOpenCodeCliProtocol({ binary: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)', '--'] }, { signal: controller.signal });
    controller.abort();
    await expect(probe).rejects.toThrow('Could not determine');
  });
});
