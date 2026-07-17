import { describe, expect, test } from 'bun:test';

import { resolveRevealPaddingClass } from './sessionNodeItemUtils';

// Minimal, non-VS Code, quick-archive available, no permission badge.
const base = {
  isMinimalMode: true,
  isVSCode: false,
  showQuickArchiveAction: true,
  showOpenInEditorAction: false,
  hasPendingPermissionBadge: false,
};

describe('resolveRevealPaddingClass', () => {
  describe('minimal, non-VS Code', () => {
    test('reserves only pr-2 when no permission badge is shown', () => {
      expect(resolveRevealPaddingClass(base)).toBe('group-hover:pr-2 group-focus-within:pr-2');
    });

    test('widens to pr-14 so the permission badge clears the hover actions (#2284)', () => {
      expect(resolveRevealPaddingClass({ ...base, hasPendingPermissionBadge: true })).toBe(
        'group-hover:pr-14 group-focus-within:pr-14',
      );
    });

    test('badge padding does not depend on the quick-archive action', () => {
      expect(
        resolveRevealPaddingClass({ ...base, showQuickArchiveAction: false, hasPendingPermissionBadge: true }),
      ).toBe('group-hover:pr-14 group-focus-within:pr-14');
    });
  });

  describe('standard, non-VS Code (badge does not change padding)', () => {
    const standard = { ...base, isMinimalMode: false };

    test('keeps pr-12 with the quick-archive action, with or without a badge', () => {
      expect(resolveRevealPaddingClass(standard)).toBe('group-hover:pr-12 group-focus-within:pr-12');
      expect(resolveRevealPaddingClass({ ...standard, hasPendingPermissionBadge: true })).toBe(
        'group-hover:pr-12 group-focus-within:pr-12',
      );
    });

    test('falls back to pr-5 without the quick-archive action', () => {
      expect(resolveRevealPaddingClass({ ...standard, showQuickArchiveAction: false })).toBe(
        'group-hover:pr-5 group-focus-within:pr-5',
      );
    });
  });

  describe('VS Code (badge does not change padding)', () => {
    // Open-in-editor is always present in VS Code.
    const vscode = { ...base, isVSCode: true, showOpenInEditorAction: true };

    test('minimal reserves pr-18 for open-in-editor + quick-archive + menu', () => {
      expect(resolveRevealPaddingClass(vscode)).toBe('group-hover:pr-18');
    });

    test('minimal reserves pr-14 for a single action + menu', () => {
      expect(resolveRevealPaddingClass({ ...vscode, showQuickArchiveAction: false })).toBe('group-hover:pr-14');
    });

    test('a permission badge does not alter VS Code minimal padding', () => {
      expect(resolveRevealPaddingClass({ ...vscode, hasPendingPermissionBadge: true })).toBe('group-hover:pr-18');
    });

    test('standard reserves pr-12 for a single action + menu', () => {
      expect(resolveRevealPaddingClass({ ...vscode, isMinimalMode: false, showQuickArchiveAction: false })).toBe(
        'group-hover:pr-12',
      );
    });
  });
});
