import { describe, expect, test } from 'bun:test';

import { ChatErrorBoundaryView } from '../ChatErrorBoundary';

const texts = {
  title: 'Chat Error',
  description: 'Description',
  sessionLabel: 'Session',
  detailsSummary: 'Error details',
  resetAction: 'Reset chat',
  persistentHint: 'Refresh the page',
};

describe('ChatErrorBoundaryView', () => {
  test('resets a latched error when the selected session changes', () => {
    const boundary = new ChatErrorBoundaryView({
      children: null,
      sessionId: 'next-session',
      texts,
    });
    let resetCalls = 0;
    boundary.state = { hasError: true, error: new Error('failed') };
    boundary.handleReset = () => { resetCalls += 1; };

    boundary.componentDidUpdate({
      children: null,
      sessionId: 'failed-session',
      texts,
    });

    expect(resetCalls).toBe(1);
  });

  test('keeps the fallback mounted for the session that failed', () => {
    const boundary = new ChatErrorBoundaryView({
      children: null,
      sessionId: 'failed-session',
      texts,
    });
    let resetCalls = 0;
    boundary.state = { hasError: true, error: new Error('failed') };
    boundary.handleReset = () => { resetCalls += 1; };

    boundary.componentDidUpdate({
      children: null,
      sessionId: 'failed-session',
      texts,
    });

    expect(resetCalls).toBe(0);
  });
});
