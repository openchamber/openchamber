/**
 * A background shell command, shown as the shell tool row it came from.
 *
 * OpenCode settles a background call at once (see
 * `@/lib/opencode/background-shell`), so its own part says "completed" in a
 * tenth of a second while the command keeps running. The row instead shows
 * the command's real life: running with its live output while the shell
 * service lists it, then finished with the result OpenCode handed back to the
 * agent. The row keeps the tool row's look in both states, so a background
 * command reads like any other command.
 */

import { shellCompletionFailed, type ShellCompletion } from '@/lib/opencode/background-shell';
import type { ToolPart } from '@/lib/opencode/model';

export type BackgroundShellPhase =
    /** The shell service still runs the command. */
    | { kind: 'running'; output: string }
    /** OpenCode reported how the command ended. */
    | { kind: 'finished'; completion: ShellCompletion }
    /**
     * The user stopped it. OpenCode reports that as an error, which is not
     * what happened, so the row shows the stop instead (`notice`, translated).
     */
    | { kind: 'stopped'; endedAt: number; notice: string }
    /**
     * Neither: the command ended and its report has not arrived yet, or the
     * list of running commands has not been read.
     */
    | { kind: 'unknown' };

// The call's own text is a notice for the model: where the output streams
// and an instruction not to poll. Only the notice is worth showing.
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
