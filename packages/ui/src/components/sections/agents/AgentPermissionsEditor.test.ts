import { describe, expect, test } from 'bun:test';

import { parsePermissionConfig, serializePermissionModel } from './agentPermissionModel';

const roundTrip = (config: unknown) => serializePermissionModel(parsePermissionConfig(config));

describe('agent permission source round-trip', () => {
  test('null and empty configs stay unset', () => {
    expect(roundTrip(null)).toBeNull();
    expect(roundTrip(undefined)).toBeNull();
    expect(roundTrip({})).toBeNull();
  });

  test('bare action string becomes the * key', () => {
    expect(roundTrip('ask')).toEqual({ '*': 'ask' });
  });

  test('flat per-key actions survive verbatim', () => {
    const config = { '*': 'allow', bash: 'ask', edit: 'deny' };
    expect(roundTrip(config)).toEqual(config);
  });

  test('nested pattern maps survive verbatim, including wildcard inside', () => {
    const config = {
      '*': 'ask',
      bash: { '*': 'ask', 'rm -rf *': 'deny', 'git status': 'allow' },
      external_directory: { '/tmp/**': 'allow' },
    };
    expect(roundTrip(config)).toEqual(config);
  });

  test('pattern-only key without wildcard stays pattern-only (no synthesized default)', () => {
    const config = { read: { '/secret/**': 'deny' } };
    expect(roundTrip(config)).toEqual(config);
  });

  test('explicit allow is preserved — not conflated with unset', () => {
    expect(roundTrip({ bash: 'allow' })).toEqual({ bash: 'allow' });
    expect(roundTrip({ '*': 'allow' })).toEqual({ '*': 'allow' });
  });

  test('unknown junk values are dropped, valid siblings kept', () => {
    expect(roundTrip({ bash: 'ask', broken: 42, worse: ['deny'] })).toEqual({ bash: 'ask' });
  });

  test('clearing everything serializes to null (key removed from config)', () => {
    const model = parsePermissionConfig({ bash: 'ask' });
    model.keys = {};
    model.global = null;
    expect(serializePermissionModel(model)).toBeNull();
  });

  test('blank patterns are not persisted', () => {
    const model = parsePermissionConfig({});
    model.keys.bash = { action: 'ask', patterns: [{ pattern: '   ', action: 'deny' }] };
    expect(serializePermissionModel(model)).toEqual({ bash: 'ask' });
  });
});
