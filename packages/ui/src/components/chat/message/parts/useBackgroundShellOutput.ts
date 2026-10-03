import React from 'react';
import { opencodeClient } from '@/lib/opencode/client';

const POLL_INTERVAL_MS = 1_000;
/** The live view keeps the newest output only, like a terminal's scrollback. */
const MAX_OUTPUT_CHARS = 256 * 1024;

const keepTail = (text: string): string => {
    if (text.length <= MAX_OUTPUT_CHARS) return text;
    const cut = text.slice(text.length - MAX_OUTPUT_CHARS);
    const lineStart = cut.indexOf('\n');
    return lineStart === -1 ? cut : cut.slice(lineStart + 1);
};

/**
 * The output of a running background command, read while `enabled`.
 *
 * OpenCode streams the output to a file and serves it by byte cursor; there is
 * no output event, so the view reads on from its cursor once a second. It
 * starts from the tail of a long output and drops the first, partial line.
 * A failed read keeps what was shown and tries again on the next tick.
 */
export const useBackgroundShellOutput = (shellID: string, directory: string | undefined, enabled: boolean): string => {
    const [output, setOutput] = React.useState('');

    React.useEffect(() => {
        if (!enabled || !directory) return;
        let cancelled = false;
        let cursor: number | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;

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
            } catch {
                // The next tick retries; the command's end is reported by the shell index.
            }
            if (!cancelled) timer = setTimeout(read, POLL_INTERVAL_MS);
        };
        void read();

        return () => {
            cancelled = true;
            if (timer !== undefined) clearTimeout(timer);
        };
    }, [directory, enabled, shellID]);

    return output;
};
