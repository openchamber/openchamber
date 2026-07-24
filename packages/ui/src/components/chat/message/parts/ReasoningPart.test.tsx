import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import { ReasoningTimelineBlock } from './ReasoningPart';
import { isPartStreaming } from './partStreaming';

// A reasoning text whose summary (first 120 chars) fits in the header but
// whose expanded body content should only appear when the disclosure is open.
const LONG_REASONING =
  'First thought about the task at hand and how to approach it carefully.\n' +
  'This second line goes into much deeper detail about the internal reasoning ' +
  'process that should remain hidden in the collapsed header view.';

// A long text that should render the collapsible header with a label
const LONG_JUSTIFICATION =
  'Sorting by activity first because the active session needs immediate attention.\n' +
  'Secondary sort by last updated timestamp ensures a stable deterministic ordering ' +
  'when multiple sessions have the same activity state.';

describe('ReasoningTimelineBlock', () => {
  test('renders reasoning traces behind an accessible collapsed disclosure by default', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ReasoningTimelineBlock
          text={LONG_REASONING}
          variant="thinking"
          blockId="reasoning-test"
          showDuration={false}
        />
      </I18nProvider>,
    );

    // Accessible toggle row is rendered
    expect(markup).toContain('role="button"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Expand reasoning trace"');

    // Summary preview (beginning of text) is visible in the header
    expect(markup).toContain('First thought');

    // Historical collapsed blocks do not mount the expanded body, avoiding a
    // first-frame flash when Activity reveals previously hidden rows.
    expect(markup).not.toContain('data-message-text-export-source');
  });

  test('renders "Justification" label for justification variant when pre-expanded and not streaming', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ReasoningTimelineBlock
          text={LONG_JUSTIFICATION}
          variant="justification"
          blockId="justification-test"
          showDuration={false}
          defaultExpanded={true}
        />
      </I18nProvider>,
    );

    // Label shown in expanded header should be "Justification" not "Thinking"
    expect(markup).toContain('Justification');
    expect(markup).not.toContain('Thinking');
  });

  test('renders "Thinking" label for thinking variant when pre-expanded and not streaming', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ReasoningTimelineBlock
          text={LONG_REASONING}
          variant="thinking"
          blockId="thinking-test"
          showDuration={false}
          defaultExpanded={true}
        />
      </I18nProvider>,
    );

    // Label shown in expanded header should be "Thinking"
    expect(markup).toContain('Thinking');
  });

  test('header summary is a truncated excerpt from the beginning', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ReasoningTimelineBlock
          text={LONG_REASONING}
          variant="thinking"
          blockId="reasoning-test"
          showDuration={false}
        />
      </I18nProvider>,
    );

    // Deep body content beyond 120 chars should be cut from the summary span
    expect(markup).not.toContain('remain hidden in the collapsed header view');
    // The ellipsis character marks that the text was truncated
    expect(markup).toContain('…');
  });

  test('a completed reasoning block mounts its expanded body content (no streaming gate)', () => {
    // The expanded body container is present for a completed (non-streaming)
    // block, confirming it is not held in a paced/sliced streaming state.
    // (MarkdownRenderer fills its DOM via a client-side morphdom effect, so the
    // streamed-vs-full text decision is covered by the isPartStreaming
    // unit tests below.)
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ReasoningTimelineBlock
          text={LONG_REASONING}
          variant="thinking"
          blockId="reasoning-completed"
          showDuration={false}
          isStreaming={false}
          time={{ start: 1, end: 2 }}
          defaultExpanded={true}
        />
      </I18nProvider>,
    );

    expect(markup).toContain('data-message-text-export-source');
  });

  test('omits trailing empty HTML comments from the header summary', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ReasoningTimelineBlock
          text={'Planning accessible icon labels with translations <!-- -->'}
          variant="thinking"
          blockId="reasoning-comment-test"
          showDuration={false}
        />
      </I18nProvider>,
    );

    expect(markup).toContain('Planning accessible icon labels with translations');
    expect(markup).not.toContain('&lt;!-- --&gt;');
  });
});

describe('isPartStreaming', () => {
  test('a part whose time.end is set is never streaming', () => {
    // Even mid-stream phase, an ended part renders in full. This covers
    // reasoning (AC #2) and assistant text that is complete while the turn
    // stays busy with a later tool call or pending question/permission.
    expect(isPartStreaming('live', 'streaming', true)).toBe(false);
    expect(isPartStreaming('live', 'cooldown', true)).toBe(false);
    expect(isPartStreaming('live', 'completed', true)).toBe(false);
    expect(isPartStreaming('live', undefined, true)).toBe(false);
  });

  test('a completed session (completed phase) does not stream', () => {
    // AC #1: opening an already-completed session renders content in full.
    expect(isPartStreaming('live', 'completed', false)).toBe(false);
  });

  test('an unknown phase is not treated as streaming', () => {
    // Do not infer live activity from a missing phase signal (regression guard
    // for the old `streamPhase === undefined || ...` permissive default).
    expect(isPartStreaming('live', undefined, false)).toBe(false);
  });

  test('live, in-progress content still streams', () => {
    // AC #3: progressive reveal is preserved for genuinely streaming turns.
    expect(isPartStreaming('live', 'streaming', false)).toBe(true);
    expect(isPartStreaming('live', 'cooldown', false)).toBe(true);
  });

  test('sorted render mode never streams', () => {
    expect(isPartStreaming('sorted', 'streaming', false)).toBe(false);
  });
});
