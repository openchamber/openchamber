import { describe, expect, test } from 'bun:test';

import { openCodePluginNotice } from './opencode-plugin';
import type { InstalledGuest, OpenCodePlugins } from './types';

const guest: InstalledGuest = {
  id: 'teapot-tools', name: 'Teapot Tools', icon: 'cup', source: 'path', enabled: true, opencodePlugin: true,
  capabilities: { requested: ['opencodePlugin'], granted: ['opencodePlugin'] },
};
const plugins = (delivery: OpenCodePlugins['delivery'], inGlobalConfig: string[] = []): OpenCodePlugins => ({
  delivery, globalConfigPath: '/home/me/.config/opencode/opencode.json', inGlobalConfig,
});

describe('what the detail screen says about an OpenCode plugin', () => {
  test('a managed OpenCode reading our file shows nothing; the two states our file does not reach offer the button', () => {
    expect(openCodePluginNotice({ guest, plugins: plugins('file'), active: true, added: null })).toBeNull();
    expect(openCodePluginNotice({ guest, plugins: plugins('restart'), active: true, added: null })).toEqual({ kind: 'offer', delivery: 'restart' });
    expect(openCodePluginNotice({ guest, plugins: plugins('none'), active: true, added: null })).toEqual({ kind: 'offer', delivery: 'none' });
    expect(openCodePluginNotice({ guest, plugins: plugins('remote'), active: true, added: null })).toEqual({ kind: 'remote' });
  });

  test('the entry the global config already lists is named in every extension state, and the written path right after the click', () => {
    for (const delivery of ['file', 'restart', 'none', 'remote'] as const) {
      for (const active of [true, false]) {
        expect(openCodePluginNotice({ guest, plugins: plugins(delivery, ['teapot-tools']), active, added: null }))
          .toEqual({ kind: 'inGlobalConfig', path: '/home/me/.config/opencode/opencode.json' });
      }
    }
    expect(openCodePluginNotice({ guest, plugins: plugins('none', ['teapot-tools']), active: true, added: '/written/opencode.json' }))
      .toEqual({ kind: 'added', path: '/written/opencode.json' });
  });

  test('an extension that is off, waiting for approval or refused offers nothing, and so does one without a plugin', () => {
    for (const delivery of ['restart', 'none', 'remote'] as const) {
      expect(openCodePluginNotice({ guest, plugins: plugins(delivery), active: false, added: null })).toBeNull();
    }
    const plain = { ...guest, opencodePlugin: undefined };
    expect(openCodePluginNotice({ guest: plain, plugins: plugins('none', ['teapot-tools']), active: true, added: null })).toBeNull();
    // No listing has said yet how plugins reach OpenCode.
    expect(openCodePluginNotice({ guest, plugins: null, active: true, added: null })).toBeNull();
  });
});
