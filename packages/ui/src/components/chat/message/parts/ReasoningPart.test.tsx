import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import { getNextReasoningExpansionForSearch, getReasoningSearchContext, ReasoningTimelineBlock, shouldExpandReasoningForSearch } from './ReasoningPart';

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
  test('detects active thinking search matches that should open collapsed reasoning', () => {
    expect(shouldExpandReasoningForSearch({
      searchIsOpen: true,
      query: 'needle',
      includeThinking: true,
      activeMessageId: 'message-1',
      messageId: 'message-1',
    })).toBe(true);

    expect(shouldExpandReasoningForSearch({
      searchIsOpen: true,
      query: 'needle',
      includeThinking: false,
      activeMessageId: 'message-1',
      messageId: 'message-1',
    })).toBe(false);

    expect(shouldExpandReasoningForSearch({
      searchIsOpen: true,
      query: 'needle',
      includeThinking: true,
      activeMessageId: 'message-2',
      messageId: 'message-1',
    })).toBe(false);
  });

  test('creates reasoning search context only when thinking search is enabled', () => {
    expect(getReasoningSearchContext({
      searchIsOpen: true,
      query: 'needle',
      includeThinking: true,
      caseSensitive: false,
      wholeWord: false,
      isRegex: false,
      messageId: 'message-1',
    })).toEqual({
      query: 'needle',
      caseSensitive: false,
      wholeWord: false,
      isRegex: false,
      messageId: 'message-1',
    });

    expect(getReasoningSearchContext({
      searchIsOpen: true,
      query: 'needle',
      includeThinking: false,
      caseSensitive: false,
      wholeWord: false,
      isRegex: false,
      messageId: 'message-1',
    })).toBe(undefined);
  });

  test('closes search-opened reasoning when the active thinking match moves away', () => {
    expect(getNextReasoningExpansionForSearch({
      current: { expanded: true, source: 'search' },
      shouldExpandForSearch: false,
      canAutoExpand: false,
    })).toEqual({ expanded: false, source: 'auto' });

    expect(getNextReasoningExpansionForSearch({
      current: { expanded: true, source: 'user' },
      shouldExpandForSearch: false,
      canAutoExpand: false,
    })).toEqual({ expanded: true, source: 'user' });

    expect(getNextReasoningExpansionForSearch({
      current: { expanded: false, source: 'auto' },
      shouldExpandForSearch: true,
      canAutoExpand: false,
    })).toEqual({ expanded: true, source: 'search' });
  });

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
});
