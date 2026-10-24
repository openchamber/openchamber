/**
 * A subagent call, shown as the row it came from, following its child session.
 *
 * A call that went to the background (`readBackgroundSubagentChildID`) has
 * already settled in its own part while the child keeps working, so the row is
 * rebuilt from the child: running while the child runs, then the report OpenCode
 * hands back. A foreground call needs none of that until it fails.
 *
 * What matters in both cases is that the child outlives any report. Sending a
 * failed child a new prompt (oh-my-opencode-slim's `task revive`) continues the
 * same session without a second report from OpenCode, so a running child always
 * wins over the report of an earlier run; otherwise the row keeps a failure and
 * a stopped clock while the child works again.
 *
 * The report itself is not shown as a row of its own
 * (`keepCommandSubagentReports`), so the subagent stays where it was started
 * instead of reappearing at the end of the chat.
 */

import type { ToolPart } from '@/lib/opencode/model';
import type { SubagentRun } from '@/lib/opencode/subagent-run';

export type SubagentCallPhase =
    /** `startedAt` is the running turn's start; the call's own start predates a revived run. */
    | { kind: 'running'; startedAt?: number }
    /** `durationMs` is the run's length when the child recorded its turn, else this device's measure of it. */
    | { kind: 'finished'; run: SubagentRun; durationMs?: number }
    /** Nothing to say about the child: the row stays as OpenCode left it. */
    | { kind: 'unknown' };

/**
 * What the row shows: the child running now, else the report of the run that
 * finished, else what OpenCode left. A report cannot describe a child that is
 * running again, so the live state is asked first. `run` is the report to show,
 * which the caller drops when it predates a failure of its own call.
 */
export const resolveSubagentCallPhase = (input: {
    run: SubagentRun | undefined;
    childRunning: boolean;
    childStartedAt: number | undefined;
    childDurationMs: number | undefined;
}): SubagentCallPhase => {
    if (input.childRunning) return { kind: 'running', startedAt: input.childStartedAt };
    if (input.run) return { kind: 'finished', run: input.run, durationMs: input.childDurationMs };
    return { kind: 'unknown' };
};

export const toSubagentCallPart = (part: ToolPart, phase: SubagentCallPhase): ToolPart => {
    const state = part.state;
    // OpenCode's own "running" or undecided call is already the row; only a
    // settled one is rebuilt.
    if (state.status !== 'completed' && state.status !== 'error') return part;
    const { input, metadata } = state;
    const start = state.time.start;

    switch (phase.kind) {
        case 'running':
            return { ...part, state: { status: 'running', input, metadata, time: { start: phase.startedAt ?? start } } };
        case 'finished': {
            const { run, durationMs } = phase;
            // The report's own time ends the row. A run of known length is
            // drawn back from it, so a revived run reads as long as it ran
            // rather than as long as the child session has existed; it never
            // starts before the call that started it.
            const end = Math.max(start, run.reportedAt);
            const began = durationMs === undefined ? start : Math.max(start, end - durationMs);
            const time = { start: began, end };
            if (run.state === 'error') {
                return { ...part, state: { status: 'error', input, metadata, error: run.output, time } };
            }
            return { ...part, state: { status: 'completed', input, output: run.output, metadata, time } };
        }
        case 'unknown':
            return part;
    }
};

/**
 * A foreground subagent the user stopped. OpenCode fails the call with
 * "Subagent cancelled"; the row shows it as stopped, not as a failure.
 */
export const toStoppedSubagentPart = (part: ToolPart, notice: string): ToolPart => {
    const state = part.state;
    if (state.status !== 'error') return part;
    const { input, metadata, time } = state;
    return { ...part, state: { status: 'completed', input, output: notice, metadata, time } };
};
