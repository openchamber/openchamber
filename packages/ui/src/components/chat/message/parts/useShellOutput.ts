import React from 'react';
import { opencodeClient } from '@/lib/opencode/client';

const POLL_INTERVAL_MS = 1_000;
/** A quiet command, such as an idle dev server, is read at most this often. */
const MAX_POLL_INTERVAL_MS = 4_000;
/** The live view keeps the newest output only, like a terminal's scrollback. */
const MAX_OUTPUT_CHARS = 256 * 1024;

const keepTail = (text: string): string => {
    if (text.length <= MAX_OUTPUT_CHARS) return text;
    const cut = text.slice(text.length - MAX_OUTPUT_CHARS);
    const lineStart = cut.indexOf('\n');
    return lineStart === -1 ? cut : cut.slice(lineStart + 1);
};

/**
 * The output of a running shell command, read while `enabled`: a background
 * command, or one the turn still waits for.
 *
 * OpenCode streams the output to a file and serves it by byte cursor; there is
 * no output event, so the view reads on from its cursor once a second. Each
 * read that brings nothing doubles the wait, up to 4 s, and new output brings
 * it back to 1 s, so a command that has gone quiet is not read every second
 * for hours. It starts from the tail of a long output and drops the first,
 * partial line. A failed read keeps what was shown and tries again on the
 * next tick.
 */
export const useShellOutput = (shellID: string, directory: string | undefined, enabled: boolean): string => {
    const [output, setOutput] = React.useState('');

    React.useEffect(() => {
        if (!enabled || !directory) return;
        let cancelled = false;
        let cursor: number | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let delay = POLL_INTERVAL_MS;

        const read = async () => {
            try {
                const page = await opencodeClient.readShellOutput(shellID, directory, cursor);
                if (cancelled) return;
                const first = cursor === undefined;
                cursor = page.cursor;
                let text = page.output;
                if (first && page.skipped) {
                    const lineStart = text.indexOf('\n');
                    text = lineStart === -1 ? '' : text.slice(lineStart + 1);
                }
                if (first) setOutput(keepTail(text));
                else if (text) setOutput((previous) => keepTail(previous + text));
                delay = first || text ? POLL_INTERVAL_MS : Math.min(delay * 2, MAX_POLL_INTERVAL_MS);
            } catch {
                // The next tick retries; the command's end is reported by the shell index.
            }
            if (!cancelled) timer = setTimeout(read, delay);
        };
        void read();

        return () => {
            cancelled = true;
            if (timer !== undefined) clearTimeout(timer);
        };
    }, [directory, enabled, shellID]);

    return output;
};
