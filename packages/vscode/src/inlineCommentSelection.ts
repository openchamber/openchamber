/**
 * Pure selection and identity logic for editor comment threads. Kept free of
 * the `vscode` dependency so it can be unit tested in isolation.
 */

export interface LineRange {
    startLine: number;
    endLine: number;
}

interface SelectionLike {
    start: { line: number; character: number };
    end: { line: number; character: number };
}

/**
 * The 1-based inclusive line range a selection covers, as a reader sees it.
 *
 * Dragging to the start of the next line selects a trailing newline but shows
 * nothing on that line, so counting it would label a one-line comment as two
 * and send a range that does not match the highlight.
 */
export function selectionLineRange(selection: SelectionLike): LineRange {
    const startLine = selection.start.line + 1;
    const spansLines = selection.end.line > selection.start.line;
    const stopsAtLineStart = selection.end.character === 0 && spansLines;
    const endLine = (stopsAtLineStart ? selection.end.line - 1 : selection.end.line) + 1;
    return { startLine, endLine };
}

/**
 * A draft id in the shared store's format.
 *
 * The extension mints it so the thread and the composer chip agree on identity
 * without a round trip; the store accepts a caller-provided id for exactly this.
 */
export function nextDraftId(now: number, randomFraction: number): string {
    return `icd-${now}-${randomFraction.toString(36).substring(2, 9)}`;
}

/** An empty body is a cancel, not a comment worth keeping on screen. */
export function shouldDisposeOnEmptyBody(body: string): boolean {
    return body.trim().length === 0;
}

/**
 * The real file a comment target refers to.
 *
 * A diff opened from Source Control shows one pane per side, and the original
 * side is not a file on disk: it is a `git:` document carrying the real path in
 * its JSON query. Labelling a comment with the raw URI path would name a file
 * the composer cannot match, so the query wins when it has one.
 *
 * @param path the URI path (already query-free, as `fsPath` gives it)
 * @param query the URI query, empty for ordinary files
 */
export function resolveCommentFilePath(path: string, query: string): string {
    if (!query) return path;
    try {
        const parsed = JSON.parse(query) as unknown;
        const candidate = (parsed as { path?: unknown })?.path;
        return typeof candidate === 'string' && candidate.trim() ? candidate : path;
    } catch {
        return path;
    }
}

/** What a draft-list snapshot says should happen to one editor thread. */
export type ThreadFate = 'wait' | 'dispose' | 'show';

/**
 * Decides a thread's fate from the composer's current draft list.
 *
 * `confirmed` records whether the composer has ever reported holding this
 * draft. Until it has, absence means the delivery is still in flight, not that
 * the comment was removed: opening a session tab produces a first snapshot
 * describing the composer as it was before the comment that opened it arrived.
 *
 * @param text the draft's text in the snapshot, or undefined when absent
 */
export function reconcileThreadFate(text: string | undefined, confirmed: boolean): ThreadFate {
    if (text === undefined) return confirmed ? 'dispose' : 'wait';
    if (shouldDisposeOnEmptyBody(text)) return 'dispose';
    return 'show';
}
