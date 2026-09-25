import { describe, expect, test } from 'bun:test';
import type { PluginRuntimeInfo } from '@/lib/opencode/plugins';
import {
  configEntryRuntimeTarget,
  findRuntimeMatches,
  pluginFileRuntimeTarget,
  resolveLoadState,
  resolveUpdateFlag,
} from './pluginLoadState';

const pkg = (target: string, extra: Partial<{ version: string; outdated: boolean; updating: boolean }> = {}): PluginRuntimeInfo => ({
  source: { kind: 'package', target, version: extra.version ?? null, outdated: extra.outdated ?? false, updating: extra.updating ?? false },
  state: { kind: 'active' },
});
const local = (path: string, state: PluginRuntimeInfo['state'] = { kind: 'active' }): PluginRuntimeInfo => ({
  source: { kind: 'local', path },
  state,
});

describe('configEntryRuntimeTarget', () => {
  test('keeps package specs verbatim, without an implied @latest', () => {
    expect(configEntryRuntimeTarget('opencode-foo', '/home/u/.config/opencode/opencode.json')).toEqual({ kind: 'package', target: 'opencode-foo' });
    expect(configEntryRuntimeTarget('@scope/foo@^1.2.0', undefined)).toEqual({ kind: 'package', target: '@scope/foo@^1.2.0' });
    expect(configEntryRuntimeTarget('github:owner/repo#main', undefined)).toEqual({ kind: 'package', target: 'github:owner/repo#main' });
  });

  test('treats ~ paths as package targets the way OpenCode does', () => {
    expect(configEntryRuntimeTarget('~/plugins/foo', undefined)).toEqual({ kind: 'package', target: '~/plugins/foo' });
  });

  test('resolves relative paths against the declaring config file', () => {
    expect(configEntryRuntimeTarget('./plugins/foo', '/repo/.opencode/opencode.json')).toEqual({ kind: 'local', path: '/repo/.opencode/plugins/foo' });
    expect(configEntryRuntimeTarget('../shared/foo/', '/repo/opencode.jsonc')).toEqual({ kind: 'local', path: '/shared/foo' });
    expect(configEntryRuntimeTarget('./foo', undefined)).toBeNull();
  });

  test('accepts absolute, file:// and Windows paths', () => {
    expect(configEntryRuntimeTarget('/opt/plugins/foo', undefined)).toEqual({ kind: 'local', path: '/opt/plugins/foo' });
    expect(configEntryRuntimeTarget('file:///opt/my%20plugin', undefined)).toEqual({ kind: 'local', path: '/opt/my plugin' });
    expect(configEntryRuntimeTarget('C:\\plugins\\foo', undefined)).toEqual({ kind: 'local', path: 'C:/plugins/foo' });
    expect(configEntryRuntimeTarget('.\\foo', 'C:\\repo\\opencode.json')).toEqual({ kind: 'package', target: '.\\foo' });
  });
});

describe('runtime matching', () => {
  test('a package matches only its exact target', () => {
    const inventory = [pkg('foo@latest'), pkg('foo', { version: '1.4.0' })];
    const target = configEntryRuntimeTarget('foo', undefined);
    if (!target) throw new Error('target missing');
    expect(resolveLoadState(findRuntimeMatches(target, inventory))).toEqual({ kind: 'active', version: '1.4.0' });
  });

  test('a loaded local plugin reports its entrypoint inside the configured directory', () => {
    const target = configEntryRuntimeTarget('./plugins/foo', '/repo/opencode.json');
    if (!target) throw new Error('target missing');
    const inventory = [local('/repo/plugins/foo/dist/index.js'), local('/repo/plugins/foobar/index.js')];
    expect(findRuntimeMatches(target, inventory)).toEqual([inventory[0]]);
  });

  test('a plugin file matches its own path', () => {
    const target = pluginFileRuntimeTarget('/home/u/.config/opencode/plugins/notify.ts');
    if (!target) throw new Error('target missing');
    expect(resolveLoadState(findRuntimeMatches(target, [local('/home/u/.config/opencode/plugins/notify.ts')]))).toEqual({ kind: 'active', version: null });
  });

  test('absent from a complete inventory reads as not reported', () => {
    expect(resolveLoadState([])).toEqual({ kind: 'notReported' });
  });

  test('a failure wins over the previous revision OpenCode keeps running', () => {
    const failed: PluginRuntimeInfo = { source: { kind: 'package', target: 'foo', version: null, outdated: false, updating: false }, state: { kind: 'failed', error: 'boom', ref: 'err_1' } };
    expect(resolveLoadState([pkg('foo'), failed])).toEqual({ kind: 'failed', error: 'boom', ref: 'err_1' });
  });

  test('update flag prefers an in-progress update over availability', () => {
    expect(resolveUpdateFlag([pkg('foo')])).toBe('none');
    expect(resolveUpdateFlag([pkg('foo', { outdated: true })])).toBe('available');
    expect(resolveUpdateFlag([pkg('foo', { outdated: true, updating: true })])).toBe('updating');
    expect(resolveUpdateFlag([local('/a')])).toBe('none');
  });
});
