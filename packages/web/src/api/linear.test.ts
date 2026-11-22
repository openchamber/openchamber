import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('createWebLinearAPI', () => {
  it('preserves labelsMore from issue summaries', async () => {
    const { createWebLinearAPI } = await import('./linear');
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      connected: true,
      issues: [{
        id: 'issue-1',
        identifier: 'ENG-1',
        title: 'Issue',
        url: 'https://linear.app/openchamber/issue/ENG-1',
        labels: [],
        labelsMore: true,
      }],
      cursor: null,
      hasMore: false,
    })));

    const result = await createWebLinearAPI().issuesList();

    expect(result.issues?.[0]?.labelsMore).toBe(true);
  });
});
