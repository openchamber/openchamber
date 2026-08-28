import { describe, expect, it, vi } from 'vitest';

// Every export is auto-stubbed from the real module. The previous hand-written
// list of ~70 names silently fell behind the source: `getGitRangeDiff` was added
// upstream, the list was not, and the whole file failed on an unrelated change.
vi.mock('@openchamber/ui/lib/gitApiHttp', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(Object.keys(actual).map((name) => [name, vi.fn()]));
});

describe('createWebGitAPI', () => {
  it('exposes bulk stage and unstage methods', async () => {
    const { createWebGitAPI } = await import('./git');
    const api = createWebGitAPI();

    expect(typeof api.stageGitFiles).toBe('function');
    expect(typeof api.unstageGitFiles).toBe('function');
    expect(typeof api.stageGitHunk).toBe('function');
    expect(typeof api.unstageGitHunk).toBe('function');
    expect(typeof api.revertGitHunk).toBe('function');
  });
});
