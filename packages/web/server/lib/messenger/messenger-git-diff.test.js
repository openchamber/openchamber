import { describe, expect, it, vi } from 'vitest';
import { buildMessengerGitDiffReply } from './messenger-git-diff.js';

describe('buildMessengerGitDiffReply', () => {
  it('reports a clean working tree', async () => {
    const result = await buildMessengerGitDiffReply({
      projectPath: '/repo/project',
      getStatusFn: vi.fn(async () => ({ isClean: true, files: [], diffStats: {} })),
      getDiffFn: vi.fn(async () => ''),
      uploadDiffFn: vi.fn(async () => ({ error: 'should not run' })),
    });

    expect(result.ok).toBe(true);
    expect(result.reply).toContain('**Git diff**');
    expect(result.reply).toContain('Working tree is clean');
  });

  it('summarizes changed files with a shareable critique URL and preview', async () => {
    const uploadDiffFn = vi.fn(async () => ({
      url: 'https://critique.work/v/abc123',
      id: 'abc123',
    }));
    const result = await buildMessengerGitDiffReply({
      projectPath: '/repo/project',
      getStatusFn: vi.fn(async () => ({
        isClean: false,
        files: [{ path: 'src/app.ts', index: 'M', working_dir: 'M' }],
        diffStats: { 'src/app.ts': { insertions: 3, deletions: 1 } },
      })),
      getDiffFn: vi.fn(async (_projectPath, options) =>
        options?.staged
          ? 'diff --git a/src/app.ts b/src/app.ts\n+const staged = true;'
          : 'diff --git a/src/app.ts b/src/app.ts\n-const old = false;\n+const next = true;',
      ),
      uploadDiffFn,
    });

    expect(result.ok).toBe(true);
    expect(uploadDiffFn).toHaveBeenCalledWith({
      title: 'project: Discord /diff',
      cwd: '/repo/project',
    });
    expect(result.reply).toContain('Files changed: 1 · +3 / -1');
    expect(result.reply).toContain('`src/app.ts` MM');
    expect(result.reply).toContain('Review: https://critique.work/v/abc123');
    expect(result.reply).toContain('```diff');
    expect(result.reply).toContain('--- staged ---');
    expect(result.reply).toContain('--- unstaged ---');
    expect(result.critiqueUrl).toBe('https://critique.work/v/abc123');
  });

  it('keeps the inline preview when critique upload fails', async () => {
    const result = await buildMessengerGitDiffReply({
      projectPath: '/repo/project',
      getStatusFn: vi.fn(async () => ({
        isClean: false,
        files: [{ path: 'a.ts', index: ' ', working_dir: 'M' }],
        diffStats: {},
      })),
      getDiffFn: vi.fn(async () => 'diff --git a/a.ts b/a.ts\n+x'),
      uploadDiffFn: vi.fn(async () => ({ error: 'critique not available (need bun/bunx)' })),
    });
    expect(result.ok).toBe(true);
    expect(result.reply).toContain('```diff');
    expect(result.reply).not.toContain('Review:');
  });
});
