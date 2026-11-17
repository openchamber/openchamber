
import type { ToolPart } from '@/lib/opencode/model';
import type { SubagentRun } from '@/lib/opencode/subagent-run';

export type BackgroundSubagentPhase =
    | { kind: 'running' }
    | { kind: 'finished'; run: SubagentRun }
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
            return { ...part, state: { ...state, output: '' } };
    }
};

export const toStoppedSubagentPart = (part: ToolPart, notice: string): ToolPart => {
    const state = part.state;
    if (state.status !== 'error') return part;
    const { input, metadata, time } = state;
    return { ...part, state: { status: 'completed', input, output: notice, metadata, time } };
};
