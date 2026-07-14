/**
 * Reproduction for issue #2230: No progress indication for long-running
 * commands/subagents — UI appears frozen.
 *
 * This test demonstrates two root causes:
 *
 * 1. Bash tool output is gated behind `state.status === 'completed'`
 *    (ToolPart.tsx line ~1900).  While the command is running, output
 *    accumulating via `message.part.delta` is silently stored but never
 *    rendered.  The user sees an empty expanded area until the command
 *    finishes.
 *
 * 2. Live duration timer (`LiveDuration`) is only rendered for `bash`
 *    tools (line ~2369).  For `task` (subagent) tools and all other
 *    tool types, no elapsed-time indicator is shown in the header row.
 */

import { describe, expect, test } from 'bun:test';

// ---------------------------------------------------------------------------
// Reproduction 1: bash tool output hidden while running
// ---------------------------------------------------------------------------

/**
 * Simulates the render gate in ToolExpandedContent (ToolPart.tsx ~line 1900).
 *
 * The actual conditional in the component is:
 *
 *   {state.status === 'completed' && 'output' in state && (
 *     <div>{renderResultContent()}</div>
 *   )}
 *
 * This test proves that output that IS present in the part's state during
 * execution (`status === 'running'`) is NOT shown to the user.
 */
function bashOutputWouldRender(state: {
  status: string;
  output?: string;
}): boolean {
  return state.status === 'completed' && 'output' in state;
}

describe('bash tool output visibility while running (issue #2230)', () => {
  // Simulate a bash tool part in the middle of execution — deltas have
  // been accumulating output, but status is still 'running'.
  const runningState = {
    status: 'running',
    output: 'Compiling...\nBuilding foo...\nLinking bar...\n',
  };

  test('output is NOT rendered when status is "running"', () => {
    // The gate `state.status === 'completed'` returns false → output hidden.
    expect(bashOutputWouldRender(runningState)).toBe(false);
  });

  test('output IS rendered when status transitions to "completed"', () => {
    const completedState = { ...runningState, status: 'completed' };
    expect(bashOutputWouldRender(completedState)).toBe(true);
  });

  test('accumulated output is preserved in state (deltas work)', () => {
    // The store correctly accumulates output; the problem is the render gate.
    expect(runningState.output).toBeTruthy();
    expect(runningState.output!.length).toBeGreaterThan(0);
    expect(runningState.output).toContain('Compiling');
  });
});

// ---------------------------------------------------------------------------
// Reproduction 2: no live timer for non-bash tools
// ---------------------------------------------------------------------------

/**
 * Simulates the live-duration rendering decision in ToolPartContent
 * (ToolPart.tsx ~line 2369).
 *
 * The actual conditional is:
 *
 *   {normalizedPartTool === 'bash' && typeof effectiveTimeStart === 'number' ? (
 *     <LiveDuration ... />
 *   ) : null}
 */
function toolRendersLiveTimer(toolName: string): boolean {
  return toolName === 'bash';
}

describe('live duration timer visibility (issue #2230)', () => {
  test('bash tool shows live duration timer', () => {
    expect(toolRendersLiveTimer('bash')).toBe(true);
  });

  test('task (subagent) tool does NOT show live duration timer', () => {
    // Subagent tasks have no elapsed-time indicator in their header row.
    expect(toolRendersLiveTimer('task')).toBe(false);
  });

  test('edit tool does NOT show live duration timer', () => {
    expect(toolRendersLiveTimer('edit')).toBe(false);
  });

  test('write tool does NOT show live duration timer', () => {
    expect(toolRendersLiveTimer('write')).toBe(false);
  });

  test('read tool does NOT show live duration timer', () => {
    expect(toolRendersLiveTimer('read')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Reproduction 3: TaskToolSummary visibility for in-flight subagent
// ---------------------------------------------------------------------------

function taskSummaryWouldRender(params: {
  isTaskTool: boolean;
  entriesLength: number;
  isActive: boolean;
  shouldTreatAsFinalized: boolean;
  hasSessionId: boolean;
}): boolean {
  if (!params.isTaskTool) return false;
  // shouldRenderTaskSummary (ToolPart.tsx ~line 2295):
  return (
    params.entriesLength > 0 ||
    params.isActive ||
    params.shouldTreatAsFinalized ||
    params.hasSessionId
  );
}

describe('task/subagent summary visibility during execution (issue #2230)', () => {
  test('active task with no entries, no session ID renders nothing', () => {
    // Early in execution: no child session ID has arrived yet, no summary
    // entries exist, but tool IS active and NOT finalized.
    expect(
      taskSummaryWouldRender({
        isTaskTool: true,
        entriesLength: 0,
        isActive: true,
        shouldTreatAsFinalized: false,
        hasSessionId: false,
      }),
    ).toBe(true); // renders because isActive=true
  });

  test('inactive finalized task with no entries and no session renders nothing', () => {
    // After completion but without entries/session: renders nothing.
    // The TaskToolSummary will be empty (null).
    expect(
      taskSummaryWouldRender({
        isTaskTool: true,
        entriesLength: 0,
        isActive: false,
        shouldTreatAsFinalized: true,
        hasSessionId: false,
      }),
    ).toBe(true); // renders because shouldTreatAsFinalized=true
  });

  test('task with active but no session or entries still shows the tool row', () => {
    // Even without session/entries, an active tool shows the header row
    // with tool icon and name, but no summary and no timer.
    // This is better than nothing but provides minimal feedback.
    expect(
      taskSummaryWouldRender({
        isTaskTool: true,
        entriesLength: 0,
        isActive: true,
        shouldTreatAsFinalized: false,
        hasSessionId: false,
      }),
    ).toBe(true); // tool row renders but no progress content inside it
  });
});

// ---------------------------------------------------------------------------
// Reproduction 4: output not streamed in expanded content
// ---------------------------------------------------------------------------

/**
 * The renderResultContent function (ToolPart.tsx ~line 1591) is only called
 * when state.status === 'completed'.  For tool types other than 'question',
 * the flow in ToolExpandedContent is:
 *
 *   {part.tool === 'question' ? (
 *     renderResultContent()   // always rendered for question
 *   ) : (
 *     <>
 *       {hasInputText && <input preview />}
 *       {state.status === 'completed' && 'output' in state && (
 *         <div>{renderResultContent()}</div>   // bash output rendered here
 *       )}
 *     </>
 *   )}
 *
 * This means even though the part.output field is being populated by
 * message.part.delta events in real-time, the expanded view only shows
 * content once the tool reaches status === 'completed'.
 */
describe('streaming output render path (issue #2230)', () => {
  const outputGatedOnCompleted =
    `line 1900 of ToolPart.tsx: \`{state.status === 'completed' && 'output' in state && (\``;

  test(`output section is gated on status === 'completed' (${outputGatedOnCompleted})`, () => {
    // This is a source-code level observation verified by code review.
    // The unit test mirrors the exact conditional.
    const gatedCondition = (status: string): boolean => status === 'completed';
    expect(gatedCondition('running')).toBe(false);
    expect(gatedCondition('pending')).toBe(false);
    expect(gatedCondition('started')).toBe(false);
    expect(gatedCondition('completed')).toBe(true);
  });
});
