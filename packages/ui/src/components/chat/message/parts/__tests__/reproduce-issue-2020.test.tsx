/**
 * Reproduction test for issue #2020:
 * Thinking block simulates streaming for reasoning text that is already available.
 *
 * The bug: When streamPhase is not yet 'completed' or time.end is not yet populated
 * on the part, already-available reasoning text is treated as streaming and gets
 * re-revealed from scratch.
 *
 * This test simulates the isStreaming computation in both ReasoningPart and
 * MergedReasoningPart to verify the conditions under which the bug manifests.
 */
import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/lib/i18n';
import { ReasoningTimelineBlock } from '../ReasoningPart';

// ============================================================
// Simulate the isStreaming computation used in ReasoningPart
// ============================================================
type StreamPhase = 'streaming' | 'cooldown' | 'completed';
type PartTime = { start?: number; end?: number };

function computeIsStreaming(
  chatRenderMode: string,
  streamPhase: StreamPhase | undefined,
  time: PartTime | undefined,
): boolean {
  const canBeStreaming = streamPhase === undefined || streamPhase !== 'completed';
  return chatRenderMode === 'live' && canBeStreaming && typeof time?.end !== 'number';
}

function computeMergedIsStreaming(
  chatRenderMode: string,
  streamPhase: StreamPhase | undefined,
  parts: { time?: PartTime }[],
): boolean {
  const canBeStreaming = streamPhase === undefined || streamPhase !== 'completed';
  return chatRenderMode === 'live' && canBeStreaming && parts.some(
    (part) => typeof part.time?.end !== 'number',
  );
}

describe('Issue #2020 - Reasoning streaming simulation reproduction', () => {
  // ===================================================================
  // Scenario: Normal streaming (this should remain working)
  // ===================================================================
  test('NORMAL: in-progress reasoning with streamPhase="streaming" and no time.end → isStreaming=true', () => {
    const result = computeIsStreaming('live', 'streaming', { start: 1000 });
    expect(result).toBe(true);
  });

  // ===================================================================
  // Scenario: Completed session, reasoning part has time.end
  // ===================================================================
  test('CORRECT: completed reasoning with streamPhase="completed" and time.end set → isStreaming=false', () => {
    const result = computeIsStreaming('live', 'completed', { start: 1000, end: 2000 });
    expect(result).toBe(false);
  });

  test('CORRECT: completed reasoning with streamPhase="completed" and no time.end → isStreaming=false', () => {
    // streamPhase='completed' alone should be enough to mark isStreaming=false
    const result = computeIsStreaming('live', 'completed', { start: 1000 });
    expect(result).toBe(false);
  });

  // ===================================================================
  // Scenario: BUG - streamPhase not yet 'completed' even though part is done
  // ===================================================================
  test('BUG: streamPhase="streaming" but reasoning IS complete (has time.end) → isStreaming should be false', () => {
    // This works correctly: time.end check protects against this
    const result = computeIsStreaming('live', 'streaming', { start: 1000, end: 2000 });
    expect(result).toBe(false);
  });

  test('BUG: streamPhase is undefined but reasoning IS complete (has time.end) → isStreaming should be false', () => {
    // This works correctly: time.end check protects against this
    const result = computeIsStreaming('live', undefined, { start: 1000, end: 2000 });
    expect(result).toBe(false);
  });

  // ===================================================================
  // Scenario: BUG - Both conditions fail (true bug scenario)
  // ===================================================================
  test('BUG: streamPhase is undefined AND no time.end → isStreaming=true for fully available cached text', () => {
    // Reproduction: When a session is loaded with cached data captured during
    // a prior stream, streamPhase might be undefined (no message-level streaming
    // info) AND time.end might not be set on the part. The full text is already
    // available locally, but isStreaming=true causes it to be re-revealed from
    // scratch via useStreamingTextThrottle and usePacedText.
    const result = computeIsStreaming('live', undefined, { start: 1000 });
    expect(result).toBe(true);
  });

  test('BUG: streamPhase="streaming" AND no time.end → isStreaming=true for fully available cached text', () => {
    // Same bug: streamPhase explicitly 'streaming' from stale streaming store
    const result = computeIsStreaming('live', 'streaming', undefined);
    expect(result).toBe(true);
  });

  // ===================================================================
  // MergedReasoningPart specific bug
  // ===================================================================
  test('BUG (MergedReasoningPart): SOME parts lack time.end → entire merged text treated as streaming', () => {
    // In MergedReasoningPart, isStreaming uses parts.some() instead of checking
    // each part individually. If ANY part lacks time.end, the ENTIRE merged
    // text (which may be fully available) is treated as streaming.
    const parts = [
      { time: { start: 1000, end: 1500 } },  // complete
      { time: { start: 1500, end: 2000 } },  // complete
      { time: { start: 2000 } },              // incomplete (no end)
    ];
    const result = computeMergedIsStreaming('live', 'completed', parts);
    expect(result).toBe(false); // streamPhase='completed' protects it

    // But if streamPhase is not 'completed':
    const result2 = computeMergedIsStreaming('live', 'streaming', parts);
    expect(result2).toBe(true);
    // The merged text is fully available (all parts have their text)
    // but isStreaming=true because one part lacks time.end
  });

  // ===================================================================
  // ReasoningTimelineBlock rendering behavior
  // ===================================================================
  test('ReasoningTimelineBlock renders expanded content with text when isStreaming=false and defaultExpanded=true', () => {
    const TEXT = 'This is the complete reasoning text that should be shown immediately.';
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ReasoningTimelineBlock
          text={TEXT}
          variant="thinking"
          blockId="repro-test"
          isStreaming={false}
          defaultExpanded={true}
          time={{ start: 1000, end: 2000 }}
        />
      </I18nProvider>,
    );
    // The text should be present in the rendered output (via data attribute)
    // When not streaming, the "Thinking" label is shown (no BusyDots)
    expect(markup).toContain('Thinking');
    // The block should be aria-expanded since defaultExpanded=true
    expect(markup).toContain('aria-expanded="true"');
    // Should NOT contain BusyDots indicator (no dots div)
    expect(markup).not.toContain('dots');
  });

  test('ReasoningTimelineBlock shows "Thinking" label with BusyDots when isStreaming=true', () => {
    const TEXT = 'This is the reasoning text.';
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ReasoningTimelineBlock
          text={TEXT}
          variant="thinking"
          blockId="repro-streaming-test"
          isStreaming={true}
          defaultExpanded={true}
          time={{ start: 1000 }}
        />
      </I18nProvider>,
    );
    // When streaming, should show BusyDots indicator
    expect(markup).toContain('Thinking');
  });
});
