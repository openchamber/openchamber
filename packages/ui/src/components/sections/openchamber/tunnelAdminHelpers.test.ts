import { describe, test, expect } from 'bun:test';
import { resolveTunnelAdminCapability, isLocked403Error, resolveTunnelActiveState } from './tunnelAdminHelpers';

describe('tunnelAdminHelpers', () => {
  describe('resolveTunnelAdminCapability', () => {
    test('returns true when true', () => {
      expect(resolveTunnelAdminCapability(true)).toBe(true);
    });

    test('returns false when false', () => {
      expect(resolveTunnelAdminCapability(false)).toBe(false);
    });

    test('returns null when missing or invalid', () => {
      expect(resolveTunnelAdminCapability(undefined)).toBe(null);
      expect(resolveTunnelAdminCapability(null)).toBe(null);
      expect(resolveTunnelAdminCapability('true')).toBe(null);
      expect(resolveTunnelAdminCapability(1)).toBe(null);
    });
  });

  describe('isLocked403Error', () => {
    test('returns true for exact 403 and message', () => {
      expect(isLocked403Error(403, { error: 'Tunnel administration requires host access.' })).toBe(true);
    });

    test('returns false for non-403', () => {
      expect(isLocked403Error(400, { error: 'Tunnel administration requires host access.' })).toBe(false);
      expect(isLocked403Error(500, { error: 'Tunnel administration requires host access.' })).toBe(false);
    });

    test('returns false for wrong message', () => {
      expect(isLocked403Error(403, { error: 'Some other error' })).toBe(false);
      expect(isLocked403Error(403, { message: 'Tunnel administration requires host access.' })).toBe(false);
    });

    test('returns false for invalid error data', () => {
      expect(isLocked403Error(403, null)).toBe(false);
      expect(isLocked403Error(403, undefined)).toBe(false);
      expect(isLocked403Error(403, 'Tunnel administration requires host access.')).toBe(false);
    });
  });
});

  describe('resolveTunnelActiveState', () => {
    test('returns true when active is true', () => {
      expect(resolveTunnelActiveState(true)).toBe(true);
    });

    test('returns false when active is false', () => {
      expect(resolveTunnelActiveState(false)).toBe(false);
    });

    test('returns false when active is missing or invalid', () => {
      expect(resolveTunnelActiveState(undefined)).toBe(false);
      expect(resolveTunnelActiveState(null)).toBe(false);
      expect(resolveTunnelActiveState('true')).toBe(false);
    });
  });
