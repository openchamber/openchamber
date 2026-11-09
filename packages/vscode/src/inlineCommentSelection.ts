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

/**
 * A text edit in line terms: the lines it replaces and the lines it inserts.
 *
 * Fed from VS Code's content changes so the pending anchor of a comment written
 * in the composer follows the document until its thread exists.
 */
export interface LineEdit {
    /** 1-based, inclusive: the first line the edit replaced. */
    startLine: number;
    /** 1-based, inclusive: the last line the edit replaced. */
    endLine: number;
    /** Lines the replacement text occupies; 1 for text without a newline. */
    insertedLines: number;
}

/**
 * Moves an anchor's lines across edits made while the comment is being typed.
 *
 * Edits entirely above the anchor shift it; edits below leave it alone. An edit
 * that rewrites the anchored lines themselves cannot be followed line by line,
 * so the comment moves to the first line of the rewrite instead of pointing at
 * unrelated code.
 */
export function shiftLineRangeOnEdits(range: LineRange, edits: readonly LineEdit[]): LineRange {
    let { startLine, endLine } = range;
    for (const edit of [...edits].sort((left, right) => left.startLine - right.startLine)) {
        const removedLines = edit.endLine - edit.startLine + 1;
        const delta = edit.insertedLines - removedLines;
        if (edit.endLine < startLine) {
            startLine += delta;
            endLine += delta;
        } else if (edit.startLine <= endLine) {
            startLine = edit.startLine;
            endLine = edit.startLine;
        }
    }
    return { startLine: Math.max(startLine, 1), endLine: Math.max(endLine, startLine, 1) };
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
        const parsed: { path?: string } = JSON.parse(query);
        return parsed.path?.trim() ? parsed.path : path;
    } catch {
        return path;
    }
}

export type CommentOrigin = {
    source: 'diff' | 'file';
    side?: 'original' | 'modified';
};

/** Preserves which side of an active diff supplied the selected code. */
export function resolveCommentOrigin(
    uri: string,
    scheme: string,
    activeDiff?: { original: string; modified: string },
): CommentOrigin {
    if (activeDiff?.original === uri) return { source: 'diff', side: 'original' };
    if (activeDiff?.modified === uri) return { source: 'diff', side: 'modified' };
    if (scheme === 'git') return { source: 'diff', side: 'original' };
    return { source: 'file' };
}

/**
 * Whether a document can take a comment.
 *
 * Both entry points ask this, so the gutter `+` and the right-click command
 * agree about where commenting is allowed. A comment is filed against a
 * workspace-relative path, so one written outside the workspace would name a
 * file the composer cannot resolve.
 */
export function canCommentOnDocument(scheme: string, isInWorkspace: boolean): boolean {
    if (scheme === 'comment') return false;
    return isInWorkspace;
}

/**
 * Empties a hold of comments waiting on a webview that had not booted.
 *
 * A hold is a list, not a single slot: a user can write a second comment while
 * the panel is still starting, and keeping only the newest silently dropped the
 * first after its thread had already reported success.
 */
export function drainPending<T>(pending: T[]): T[] {
    return pending.splice(0, pending.length);
}

/**
 * Removes a held comment the user dropped before it was ever delivered.
 *
 * A comment waiting on a booting webview is in no store yet, so asking that
 * webview to remove it finds nothing. Without dropping the hold too, the draft
 * would land after the user had already removed its thread.
 *
 * @returns whether a held comment was dropped
 */
export function dropPendingById<T extends { draftId?: string }>(pending: T[], draftId: string): boolean {
    const index = pending.findIndex((entry) => entry.draftId === draftId);
    if (index < 0) return false;
    pending.splice(index, 1);
    return true;
}

/**
 * How long a submitted comment may go unconfirmed before it is given up on.
 *
 * Long enough to outlast a cold webview boot plus the composer's own wait for a
 * directory, short enough that a thread does not sit there promising to send
 * something that never will.
 */
export const DELIVERY_CONFIRMATION_TIMEOUT_MS = 30_000;

/**
 * Whether a submitted comment should be abandoned once its deadline passes.
 *
 * Confirmation means the composer reported holding the draft. Without it the
 * comment reached no store: the panel's webview never booted, or the message
 * was dropped. Keeping the thread would show "Not sent yet" forever, for a
 * comment that cannot be sent and cannot be rewritten — only deleted.
 */
export function shouldAbandonUnconfirmed(confirmed: boolean | undefined): boolean {
    return !confirmed;
}

/** A chat surface that may be holding, or showing, a comment draft. */
export interface RemovalTarget {
    /** Comments still waiting on this surface's webview to boot. */
    pendingLineComments: Array<{ draftId?: string }>;
    /** Asks this surface's webview to drop the draft from its store. */
    notify: () => void;
}

/**
 * Tells every surface to drop a comment, wherever it currently lives.
 *
 * Each webview owns its own draft store, so the one holding the draft cannot be
 * known from here; every surface is told and the rest no-op. The hold is cleared
 * before notifying, because a comment that has not been delivered yet is in no
 * store for the notification to find, and would otherwise arrive afterwards as a
 * chip the user had already dropped.
 */
export function broadcastRemoval(targets: Iterable<RemovalTarget>, draftId: string): void {
    for (const target of targets) {
        dropPendingById(target.pendingLineComments, draftId);
        target.notify();
    }
}

/**
 * Whether a draft snapshot is authoritative for a thread.
 *
 * Every webview — the sidebar and each session tab — runs its own draft store
 * and publishes its whole list. Only the surface that accepted a comment knows
 * whether it still holds it; to any other surface the draft simply never
 * existed. Letting a foreign snapshot decide disposed threads that were alive
 * and about to be sent, which is what opening a second tab used to do.
 */
export function snapshotOwnsThread(threadSurfaceId: string | undefined, snapshotSurfaceId: string): boolean {
    return Boolean(threadSurfaceId) && threadSurfaceId === snapshotSurfaceId;
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

/** What a comment written in the composer asks of its editor anchor. */
export type ComposingThreadFate = 'wait' | 'create' | 'drop';

/**
 * Decides when a comment written in the composer earns its editor thread.
 *
 * The draft exists before it has text, and the thread shows the comment on the
 * code. An empty body says nothing — the composer's own rules discard one — so
 * the anchor is created the first time the draft carries text. A draft that
 * never arrives, or is cancelled before anything was written, leaves no thread
 * behind.
 *
 * @param text the draft's text in the snapshot, or undefined when absent
 * @param confirmed whether a snapshot has shown the draft at least once
 */
export function composingThreadFate(text: string | undefined, confirmed: boolean): ComposingThreadFate {
    if (text === undefined) return confirmed ? 'drop' : 'wait';
    return shouldDisposeOnEmptyBody(text) ? 'wait' : 'create';
}
