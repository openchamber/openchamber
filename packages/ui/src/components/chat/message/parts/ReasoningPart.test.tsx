import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Part } from '@opencode-ai/sdk/v2';

import { I18nProvider } from '@/lib/i18n';
import ReasoningPart, { ReasoningTimelineBlock } from './ReasoningPart';
import type { StreamPhase } from '../types';

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

// Regression tests for issue #2020: a persisted reasoning part must not be
// presented as live streaming just because cached data lacks `time.end` or a
// stream phase. Live activity derives from the live stream phase only.
describe('ReasoningPart streaming gating (issue #2020)', () => {
  // Short enough (< 80 chars) that the collapsed header summary contains the
  // complete text, letting us assert full content on first paint.
  const SHORT_REASONING = 'Persisted reasoning text that is already fully available.';

  const BUSY_INDICATOR = 'animate-busy-pulse';

  const makeReasoningPart = (time?: { start?: number; end?: number }): Part =>
    ({
      id: 'prt_reasoning_2020',
      sessionID: 'ses_2020',
      messageID: 'msg_2020',
      type: 'reasoning',
      text: SHORT_REASONING,
      time,
    }) as unknown as Part;

  // Server rendering reads the UI store's initial state, which is
  // chatRenderMode 'live' — the mode in which the streaming presentation is
  // reachable and the issue reproduces.
  const renderPart = (part: Part, streamPhase?: StreamPhase): string =>
    renderToStaticMarkup(
      <I18nProvider>
        <ReasoningPart part={part} messageId="msg_2020" streamPhase={streamPhase} />
      </I18nProvider>,
    );

  test('reasoning without time.end and without a live stream phase renders complete, not streaming', () => {
    // Freshly opened completed session: cached part never received `time.end`
    // and no message-level stream phase is available. The full text is already
    // local, so the block must render as finished content on first paint.
    const markup = renderPart(makeReasoningPart({ start: 1_000 }), undefined);

    expect(markup).not.toContain(BUSY_INDICATOR);
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain(SHORT_REASONING);
  });

  test('reasoning without time.end in a completed message renders complete, not streaming', () => {
    const markup = renderPart(makeReasoningPart({ start: 1_000 }), 'completed');

    expect(markup).not.toContain(BUSY_INDICATOR);
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain(SHORT_REASONING);
  });

  test('reasoning with time.end is never treated as streaming, even when the phase claims streaming', () => {
    const markup = renderPart(makeReasoningPart({ start: 1_000, end: 2_000 }), 'streaming');

    expect(markup).not.toContain(BUSY_INDICATOR);
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain(SHORT_REASONING);
  });

  test('live in-progress reasoning still renders as streaming', () => {
    // Genuinely live: the message-level stream phase reports streaming and the
    // part has not ended. The block auto-expands and shows the busy indicator.
    const markup = renderPart(makeReasoningPart({ start: 1_000 }), 'streaming');

    expect(markup).toContain(BUSY_INDICATOR);
    expect(markup).toContain('aria-expanded="true"');
  });

  test('remounting a completed reasoning part does not re-trigger the streaming presentation', () => {
    const part = makeReasoningPart({ start: 1_000 });
    const first = renderPart(part, undefined);
    const second = renderPart(part, undefined);

    expect(second).toBe(first);
    expect(second).not.toContain(BUSY_INDICATOR);
    expect(second).toContain(SHORT_REASONING);
  });
});
