import { describe, it, expect } from 'vitest';
import {
  PERMISSION_MODES,
  DEFAULT_PERMISSION_MODE,
  parsePermissionMode,
  normalizePermissionMode,
  shouldAutoApprove,
} from './messenger-permissions.js';

describe('parsePermissionMode', () => {
  it('maps canonical values to themselves', () => {
    for (const mode of PERMISSION_MODES) {
      expect(parsePermissionMode(mode)).toBe(mode);
    }
  });

  it('maps aliases to canonical modes', () => {
    expect(parsePermissionMode('ASK')).toBe('ask');
    expect(parsePermissionMode('manual')).toBe('ask');
    expect(parsePermissionMode('off')).toBe('ask');
    expect(parsePermissionMode('safe')).toBe('auto-edit');
    expect(parsePermissionMode('edits')).toBe('auto-edit');
    expect(parsePermissionMode('auto')).toBe('auto-edit');
    expect(parsePermissionMode('YOLO')).toBe('yolo');
    expect(parsePermissionMode('all')).toBe('yolo');
    expect(parsePermissionMode('on')).toBe('yolo');
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
    expect(normalizePermissionMode('auto-edit')).toBe('auto-edit');
    expect(normalizePermissionMode('bogus')).toBe(DEFAULT_PERMISSION_MODE);
    expect(normalizePermissionMode(undefined)).toBe('ask');
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

  it('auto-approves only low-risk tools in auto-edit mode', () => {
    expect(shouldAutoApprove('auto-edit', 'edit')).toBe(true);
    expect(shouldAutoApprove('auto-edit', 'write')).toBe(true);
    expect(shouldAutoApprove('auto-edit', 'read')).toBe(true);
    expect(shouldAutoApprove('auto-edit', 'webfetch')).toBe(true);
    // Shell / unknown tools still require an explicit approval.
    expect(shouldAutoApprove('auto-edit', 'bash')).toBe(false);
    expect(shouldAutoApprove('auto-edit', 'unknown-tool')).toBe(false);
  });

  it('is case-insensitive on the tool name', () => {
    expect(shouldAutoApprove('auto-edit', 'EDIT')).toBe(true);
    expect(shouldAutoApprove('auto-edit', 'Bash')).toBe(false);
  });
});
