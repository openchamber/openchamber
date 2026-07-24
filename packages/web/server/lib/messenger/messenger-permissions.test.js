import { describe, it, expect } from 'vitest';
import {
  PERMISSION_MODES,
  DEFAULT_PERMISSION_MODE,
  parsePermissionMode,
  normalizePermissionMode,
  resolveAgentToolAction,
  shouldAutoApprove,
  shouldAutoDeny,
} from './messenger-permissions.js';

describe('parsePermissionMode', () => {
  it('maps canonical values to themselves', () => {
    for (const mode of PERMISSION_MODES) {
      expect(parsePermissionMode(mode)).toBe(mode);
    }
  });

  it('maps aliases to canonical modes', () => {
    expect(parsePermissionMode('ASK')).toBe('ask');
    expect(parsePermissionMode('ask-all')).toBe('ask');
    expect(parsePermissionMode('manual')).toBe('ask');
    expect(parsePermissionMode('off')).toBe('ask');
    expect(parsePermissionMode('YOLO')).toBe('yolo');
    expect(parsePermissionMode('allow-all')).toBe('yolo');
    expect(parsePermissionMode('all')).toBe('yolo');
    expect(parsePermissionMode('on')).toBe('yolo');
    expect(parsePermissionMode('follow')).toBe('agent');
    expect(parsePermissionMode('follow-agent')).toBe('agent');
    expect(parsePermissionMode('agent-settings')).toBe('agent');
    // Legacy auto-edit maps to follow-agent
    expect(parsePermissionMode('safe')).toBe('agent');
    expect(parsePermissionMode('edits')).toBe('agent');
    expect(parsePermissionMode('auto')).toBe('agent');
    expect(parsePermissionMode('auto-edit')).toBe('agent');
  });

  it('returns null for unknown / empty input', () => {
    expect(parsePermissionMode('nonsense')).toBeNull();
    expect(parsePermissionMode('')).toBeNull();
    expect(parsePermissionMode('   ')).toBeNull();
    expect(parsePermissionMode(null)).toBeNull();
    expect(parsePermissionMode(42)).toBeNull();
  });
});

describe('normalizePermissionMode', () => {
  it('passes through valid modes and defaults the rest', () => {
    expect(normalizePermissionMode('yolo')).toBe('yolo');
    expect(normalizePermissionMode('agent')).toBe('agent');
    expect(normalizePermissionMode('auto-edit')).toBe('agent');
    expect(normalizePermissionMode('bogus')).toBe(DEFAULT_PERMISSION_MODE);
    expect(normalizePermissionMode(undefined)).toBe('agent');
  });
});

describe('resolveAgentToolAction', () => {
  it('reads effective rule arrays', () => {
    const rules = [
      { permission: '*', pattern: '*', action: 'ask' },
      { permission: 'edit', pattern: '*', action: 'allow' },
      { permission: 'bash', pattern: '*', action: 'deny' },
    ];
    expect(resolveAgentToolAction(rules, 'edit')).toBe('allow');
    expect(resolveAgentToolAction(rules, 'bash')).toBe('deny');
    expect(resolveAgentToolAction(rules, 'webfetch')).toBe('ask');
  });

  it('reads permission config maps', () => {
    const config = {
      '*': 'ask',
      edit: 'allow',
      bash: { '*': 'deny' },
    };
    expect(resolveAgentToolAction(config, 'edit')).toBe('allow');
    expect(resolveAgentToolAction(config, 'bash')).toBe('deny');
    expect(resolveAgentToolAction(config, 'read')).toBe('ask');
  });

  it('falls back to ask when config is missing', () => {
    expect(resolveAgentToolAction(null, 'edit')).toBe('ask');
    expect(resolveAgentToolAction(undefined, 'edit')).toBe('ask');
    expect(resolveAgentToolAction({}, 'edit')).toBe('ask');
  });
});

describe('shouldAutoApprove', () => {
  it('never auto-approves in ask mode', () => {
    expect(shouldAutoApprove('ask', 'edit')).toBe(false);
    expect(shouldAutoApprove('ask', 'bash')).toBe(false);
  });

  it('auto-approves everything in yolo mode', () => {
    expect(shouldAutoApprove('yolo', 'bash')).toBe(true);
    expect(shouldAutoApprove('yolo', 'edit')).toBe(true);
    expect(shouldAutoApprove('yolo', 'anything-else')).toBe(true);
  });

  it('follows agent action in agent mode', () => {
    expect(shouldAutoApprove('agent', 'edit', 'allow')).toBe(true);
    expect(shouldAutoApprove('agent', 'edit', 'ask')).toBe(false);
    expect(shouldAutoApprove('agent', 'edit', 'deny')).toBe(false);
    expect(shouldAutoApprove('agent', 'edit', null)).toBe(false);
    // Legacy stored mode still resolves through normalize
    expect(shouldAutoApprove('auto-edit', 'edit', 'allow')).toBe(true);
  });
});

describe('shouldAutoDeny', () => {
  it('only denies in agent mode when action is deny', () => {
    expect(shouldAutoDeny('agent', 'deny')).toBe(true);
    expect(shouldAutoDeny('agent', 'allow')).toBe(false);
    expect(shouldAutoDeny('yolo', 'deny')).toBe(false);
    expect(shouldAutoDeny('ask', 'deny')).toBe(false);
  });
});
