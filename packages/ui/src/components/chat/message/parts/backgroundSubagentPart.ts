/**
 * A subagent call that went to the background, shown as the subagent row it
 * came from.
 *
 * OpenCode settles such a call at once (see `readBackgroundSubagentChildID`),
 * so its own part says "completed" while the child keeps working. The row
 * instead follows the child: running while the child session runs, then the
 * report OpenCode handed back to the agent. The report itself is not shown as
 * a row of its own (`keepCommandSubagentReports`), so the subagent stays
 * where it was started instead of reappearing at the end of the chat.
 */

import type { ToolPart } from '@/lib/opencode/model';
import type { SubagentRun } from '@/lib/opencode/subagent-run';

export type BackgroundSubagentPhase =
    | { kind: 'running' }
    | { kind: 'finished'; run: SubagentRun }
    /** The child is idle and no report arrived (history from before a restart). */
    | { kind: 'unknown' };

export const toBackgroundSubagentPart = (part: ToolPart, phase: BackgroundSubagentPhase): ToolPart => {
    const state = part.state;
    if (state.status !== 'completed') return part;
    const { input, metadata } = state;
    const start = state.time.start;

    switch (phase.kind) {
        case 'running':
            return { ...part, state: { status: 'running', input, metadata, time: { start } } };
        case 'finished': {
            const { run } = phase;
            const time = { start, end: Math.max(start, run.reportedAt) };
            if (run.state === 'error') {
                return { ...part, state: { status: 'error', input, metadata, error: run.output, time } };
            }
            return { ...part, state: { ...state, output: run.output, time } };
        }
        case 'unknown':
            return part;
    }
};
