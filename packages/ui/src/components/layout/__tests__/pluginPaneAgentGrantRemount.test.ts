import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const pluginPaneSource = fs.readFileSync(
  path.join(import.meta.dir, '../PluginPane.tsx'),
  'utf8',
);

describe('PluginPane agent grant remount', () => {
  test('remounts the iframe when agent grant flips', () => {
    expect(pluginPaneSource).toContain('const frameKey = `${guestId}:agent-${guest?.agent?.granted ? \'1\' : \'0\'}`');
    expect(pluginPaneSource).toContain('key={frameKey}');
    expect(pluginPaneSource).toContain('[frameKey, onDismiss, postToGuest, pushHostState, refreshOauth, setOauthStatus, src, stopOauthPoll]');
  });

  test('resolves the live iframe from the ref on every message', () => {
    expect(pluginPaneSource).toContain('const frame = iframeRef.current;');
    expect(pluginPaneSource).toContain('if (!frame || event.source !== frame.contentWindow) return;');
    expect(pluginPaneSource).not.toContain('if (event.source !== frame.contentWindow) return;');
  });
});
