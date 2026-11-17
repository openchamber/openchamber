
import { z } from 'zod';
import { shellCompletionFailed, type ShellCompletion } from '@/lib/opencode/background-shell';
import type { ToolPart } from '@/lib/opencode/model';

export type BackgroundShellPhase =
    | { kind: 'running'; output: string }
    | { kind: 'finished'; completion: ShellCompletion }
    | { kind: 'stopped'; endedAt: number; notice: string }
    | { kind: 'unknown' };

const MODEL_INSTRUCTION_START = '\n\nYou will be notified automatically';

const withoutModelInstruction = (output: string): string => {
    const index = output.indexOf(MODEL_INSTRUCTION_START);
    return index === -1 ? output : output.slice(0, index);
};

const failureReason = (completion: ShellCompletion): string => {
    if (completion.state !== 'completed') return completion.state;
    if (completion.timeout) return 'timeout';
    if (completion.signal !== undefined) return `killed (${completion.signal})`;
    return `exited (${completion.exit ?? 'unknown'})`;
};

export const toBackgroundShellPart = (part: ToolPart, phase: BackgroundShellPhase): ToolPart => {
    const state = part.state;
    if (state.status !== 'completed') return part;
    const { input } = state;
    const start = state.time.start;

    switch (phase.kind) {
        case 'running':
            return { ...part, state: { status: 'running', input, metadata: { output: phase.output }, time: { start } } };
        case 'finished': {
            const { completion } = phase;
            const time = { start, end: Math.max(start, completion.endedAt) };
            if (shellCompletionFailed(completion)) {
                return { ...part, state: { status: 'error', input, error: failureReason(completion), output: completion.output, time } };
            }
            return { ...part, state: { ...state, output: completion.output, time } };
        }
        case 'stopped':
            return { ...part, state: { ...state, output: phase.notice, time: { start, end: Math.max(start, phase.endedAt) } } };
        case 'unknown':
            return { ...part, state: { ...state, output: withoutModelInstruction(state.output) } };
    }
};

export const toInterruptedShellPart = (part: ToolPart, notice: string): ToolPart => {
    const state = part.state;
    if (state.status !== 'error' || state.metadata?.interrupted !== true) return part;
    const { input, metadata, time } = state;
    const text = state.output ?? state.error;
    const modelNotice = z.string().safeParse(metadata.notice).data ?? '';
    const output = modelNotice && text.endsWith(modelNotice) ? text.slice(0, -modelNotice.length).trimEnd() : text;
    return { ...part, state: { status: 'completed', input, output: output || notice, metadata, time } };
};
