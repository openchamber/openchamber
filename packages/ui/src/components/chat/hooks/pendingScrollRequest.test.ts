import { describe, expect, test } from 'bun:test';

import { decidePendingScrollFailure, shouldReportScrollAttemptComplete } from './pendingScrollRequest';

describe('decidePendingScrollFailure', () => {
    test('keeps a hidden target pending until the turn window reveals it', () => {
        expect(decidePendingScrollFailure({
            targetIndex: 2,
            turnStart: 7,
            visibleFailureCount: 0,
        })).toBe('wait-hidden');
    });

    test('retries after a visible target fails to scroll once because refs or virtual rows may still be settling', () => {
        expect(decidePendingScrollFailure({
            targetIndex: 2,
            turnStart: 2,
            visibleFailureCount: 0,
        })).toBe('retry-visible');
    });

    test('resolves failed after the visible-target retry budget is exhausted', () => {
        expect(decidePendingScrollFailure({
            targetIndex: 2,
            turnStart: 2,
            visibleFailureCount: 3,
            visibleRetryLimit: 3,
        })).toBe('resolve-failed');
    });
});

describe('shouldReportScrollAttemptComplete', () => {
    test('reports complete when the target DOM element was scrolled into view', () => {
        expect(shouldReportScrollAttemptComplete({
            elementScrolled: true,
            virtualIndexScrollRequested: false,
        })).toBe(true);
    });

    test('does not report complete when only a virtual index scroll was requested', () => {
        expect(shouldReportScrollAttemptComplete({
            elementScrolled: false,
            virtualIndexScrollRequested: true,
        })).toBe(false);
    });
});
