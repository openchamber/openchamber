import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadGhosttyRuntime } from './runtime';

const vendorDir = join(dirname(fileURLToPath(import.meta.url)), 'vendor');

describe('vendored libghostty-vt WebAssembly', () => {
  test('stays pinned to VERSION and inside the size budget', async () => {
    const wasm = readFileSync(join(vendorDir, 'ghostty-vt.wasm'));
    expect(wasm.byteLength).toBeLessThan(750_000);

    // The build embeds the pinned revision as semver build metadata, so VERSION
    // is the single source of truth and drift between the two is caught here.
    const runtime = await loadGhosttyRuntime();
    const out = runtime.alloc(8);
    expect(runtime.call('ghostty_build_info', 10, out)).toBe(0);
    const view = runtime.view(out, 8);
    const embeddedRevision = new TextDecoder().decode(
      runtime.bytes(view.getUint32(0, true), view.getUint32(4, true)),
    );
    runtime.free(out, 8);
    expect(embeddedRevision).toBe(readFileSync(join(vendorDir, 'VERSION'), 'utf8').trim());
  });

  test('routes terminal replies through the embedded trampoline to the attached writer', async () => {
    const runtime = await loadGhosttyRuntime();
    const optionsSize = runtime.layout('GhosttyTerminalOptions').size;
    const options = runtime.alloc(optionsSize);
    runtime.setField(options, 'GhosttyTerminalOptions', 'cols', 20);
    runtime.setField(options, 'GhosttyTerminalOptions', 'rows', 4);
    const slot = runtime.allocOpaque();
    expect(runtime.call('ghostty_terminal_new', 0, slot, options)).toBe(0);
    runtime.free(options, optionsSize);
    const terminal = runtime.readPointer(slot);

    const replies: string[] = [];
    const writerId = runtime.attachPtyWriter(terminal, (data) => replies.push(data));
    const input = new TextEncoder().encode('\x1b[6n');
    const pointer = runtime.alloc(input.length);
    runtime.bytes(pointer, input.length).set(input);
    runtime.call('ghostty_terminal_vt_write', terminal, pointer, input.length);
    runtime.free(pointer, input.length);
    expect(replies).toEqual(['\x1b[1;1R']);

    runtime.detachPtyWriter(terminal, writerId);
    runtime.call('ghostty_terminal_free', terminal);
    runtime.freeOpaque(slot);
  });
});
