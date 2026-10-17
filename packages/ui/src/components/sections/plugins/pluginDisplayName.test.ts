import { describe, expect, test } from 'bun:test';

import { pluginDisplayName } from './pluginDisplayName';

describe('pluginDisplayName', () => {
  test('a local path shows its last segment', () => {
    expect(pluginDisplayName('/Users/me/projects/openchamber/packages/opencode-plugin')).toBe('opencode-plugin');
    expect(pluginDisplayName('/Users/me/plugins/notify/')).toBe('notify');
    expect(pluginDisplayName('./plugins/session-logger.ts')).toBe('session-logger.ts');
    expect(pluginDisplayName('file:///Users/me/tools/guard')).toBe('guard');
    expect(pluginDisplayName('C:\\Users\\me\\plugins\\guard')).toBe('guard');
  });

  test('an index entry file shows the folder that holds it', () => {
    expect(pluginDisplayName('/Users/me/plugins/guard/index.ts')).toBe('guard');
    expect(pluginDisplayName('../guard/index.mjs')).toBe('guard');
  });

  test('a package spec drops its version or tag', () => {
    expect(pluginDisplayName('opencode-wakatime')).toBe('opencode-wakatime');
    expect(pluginDisplayName('opencode-wakatime@1.2.3')).toBe('opencode-wakatime');
    expect(pluginDisplayName('@openchamber/opencode-claude@^0.4.0')).toBe('@openchamber/opencode-claude');
    expect(pluginDisplayName('@scope/plugin')).toBe('@scope/plugin');
  });

  test('a Git spec shows the repository name', () => {
    expect(pluginDisplayName('github:owner/opencode-guard')).toBe('opencode-guard');
    expect(pluginDisplayName('git+https://github.com/owner/opencode-guard.git#v2')).toBe('opencode-guard');
  });
});
