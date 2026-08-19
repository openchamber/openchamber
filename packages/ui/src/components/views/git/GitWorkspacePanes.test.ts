import { describe, expect, test } from 'bun:test';
import { clampGitGraphPaneHeight } from './gitWorkspacePanesModel';

describe('GitWorkspacePanes helpers', () => {
  test('clamps graph pane height to supported bounds', () => {
    expect(clampGitGraphPaneHeight(10)).toBe(180);
    expect(clampGitGraphPaneHeight(280)).toBe(280);
    expect(clampGitGraphPaneHeight(999)).toBe(720);
  });
});
