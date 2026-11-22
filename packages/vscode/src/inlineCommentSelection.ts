
export interface LineRange {
    startLine: number;
    endLine: number;
}

interface SelectionLike {
    start: { line: number; character: number };
    end: { line: number; character: number };
}

export function selectionLineRange(selection: SelectionLike): LineRange {
    const startLine = selection.start.line + 1;
    const spansLines = selection.end.line > selection.start.line;
    const stopsAtLineStart = selection.end.character === 0 && spansLines;
    const endLine = (stopsAtLineStart ? selection.end.line - 1 : selection.end.line) + 1;
    return { startLine, endLine };
}

export function nextDraftId(now: number, randomFraction: number): string {
    return `icd-${now}-${randomFraction.toString(36).substring(2, 9)}`;
}

export interface LineEdit {
    startLine: number;
    endLine: number;
    insertedLines: number;
    endsAtLineStart?: boolean;
}

export function shiftLineRangeOnEdits(range: LineRange, edits: readonly LineEdit[]): LineRange {
    let { startLine, endLine } = range;
    for (const edit of [...edits].sort((left, right) => right.startLine - left.startLine)) {
        const removedLines = edit.endLine - edit.startLine + 1;
        const delta = edit.insertedLines - removedLines;
        const endsBeforeAnchor = edit.endLine < startLine || (edit.endLine === startLine && edit.endsAtLineStart === true);
        if (endsBeforeAnchor) {
            startLine += delta;
            endLine += delta;
        } else if (edit.startLine <= endLine) {
            startLine = edit.startLine;
            endLine = edit.startLine;
        }
    }
    return { startLine: Math.max(startLine, 1), endLine: Math.max(endLine, startLine, 1) };
}

export function shouldDisposeOnEmptyBody(body: string): boolean {
    return body.trim().length === 0;
}

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

export function canCommentOnDocument(scheme: string, isInWorkspace: boolean): boolean {
    if (scheme === 'comment') return false;
    return isInWorkspace;
}

export function drainPending<T>(pending: T[]): T[] {
    return pending.splice(0, pending.length);
}

export function dropPendingById<T extends { draftId?: string }>(pending: T[], draftId: string): boolean {
    const index = pending.findIndex((entry) => entry.draftId === draftId);
    if (index < 0) return false;
    pending.splice(index, 1);
    return true;
}

export const DELIVERY_CONFIRMATION_TIMEOUT_MS = 30_000;

export function shouldAbandonUnconfirmed(confirmed: boolean | undefined): boolean {
    return !confirmed;
}

export interface RemovalTarget {
    pendingLineComments: Array<{ draftId?: string }>;
    notify: () => void;
}

export function broadcastRemoval(targets: Iterable<RemovalTarget>, draftId: string): void {
    for (const target of targets) {
        dropPendingById(target.pendingLineComments, draftId);
        target.notify();
    }
}

export function snapshotOwnsThread(threadSurfaceId: string | undefined, snapshotSurfaceId: string): boolean {
    return Boolean(threadSurfaceId) && threadSurfaceId === snapshotSurfaceId;
}

export type ThreadFate = 'wait' | 'dispose' | 'show';

export function reconcileThreadFate(text: string | undefined, confirmed: boolean): ThreadFate {
    if (text === undefined) return confirmed ? 'dispose' : 'wait';
    if (shouldDisposeOnEmptyBody(text)) return 'dispose';
    return 'show';
}

export type ComposingThreadFate = 'wait' | 'create' | 'drop';

export function composingThreadFate(text: string | undefined, confirmed: boolean): ComposingThreadFate {
    if (text === undefined) return confirmed ? 'drop' : 'wait';
    return shouldDisposeOnEmptyBody(text) ? 'wait' : 'create';
}
