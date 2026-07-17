import { describe, expect, test } from 'bun:test';
import fsp from 'node:fs/promises';

describe('preload runtime bootstrap source', () => {
  test('does not read credential argv and gates bootstrap to its local page decision', async () => {
    const source = await fsp.readFile(new URL('./preload.mjs', import.meta.url), 'utf8');
    expect(source).not.toContain("readArgValue('--openchamber-client-token')");
    expect(source).not.toContain("readArgValue('--openchamber-runtime-headers')");
    expect(source).not.toContain("readArgValue('--openchamber-relay-host-id')");
    expect(source).toContain("const runtimeBootstrap = isLocalPage\n  ? ipcRenderer.sendSync('openchamber:runtime-bootstrap')\n  : null;");
  });
});
