import { describe, expect, test } from 'bun:test';

import { HIGHLIGHT_REQUEST_TIMEOUT_MS } from './markdown-worker-timeout';

describe('markdown-worker hang safety', () => {
  test('exposes a finite highlight timeout budget', () => {
    // Catastrophic Oniguruma backtracking must not run unbounded; the main
    // thread terminates the worker after this budget (openchamber/openchamber#2587).
    expect(HIGHLIGHT_REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
    expect(HIGHLIGHT_REQUEST_TIMEOUT_MS).toBeLessThan(15_001);
  });
});
