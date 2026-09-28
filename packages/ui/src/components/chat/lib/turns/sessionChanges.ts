/**
 * Session-wide file changes for the diff panel when the directory is not a Git
 * repository.
 *
 * The detection is `summarizeLiveActivity` — the same transcript walk that
 * powers the per-turn "Changed files" list — so a non-Git review sees exactly
 * the files the turn list sees, with the same path handling and rename
 * merging. This module only adapts that output for the diff panel: paths
 * relative to the session directory, and one rendered patch per file.
 *
 * The diff panel otherwise reads `git status` and OpenCode's turn snapshots
 * (`session.diff`), both of which need a Git repository. The transcript's own
 * edit/write/patch calls are the one record that survives without one.
 *
 * What it can and cannot see:
 * - `edit`/`patch` results carry a unified diff per file, which makes the
 *   review show line changes.
 * - `write` results carry no diff, only the written body, so those files show
 *   the body as their "after" side.
 * - Subagent edits live in child sessions, not in one session's transcript.
 *   Pass the whole session tree (see `collectDescendantSessionIds`) to include
 *   them.
 */

import { getRelativeFilePath, normalizeFilePath } from '@/lib/path-utils';
import type { Session } from '@/lib/opencode/model';
import { summarizeLiveActivity, type SessionFileChangeDetail } from './liveActivitySummary';
import type { ChatMessageEntry } from './types';

/** What the diff panel calls a reviewable session change. */
export type SessionFileChange = SessionFileChangeDetail;

const FIRST_HUNK_PATTERN = /^@@\s/m;

const comparablePath = (path: string): string =>
    /^[A-Za-z]:\//.test(path) || path.startsWith('//') ? path.toLowerCase() : path;

const containsBinaryPatch = (patch: string): boolean =>
    /^Binary files .+ differ$/m.test(patch) || /^GIT binary patch$/m.test(patch);

const patchHeader = (patch: string): string => {
    const firstHunk = patch.search(FIRST_HUNK_PATTERN);
    return firstHunk < 0 ? '' : patch.slice(0, firstHunk);
};

const patchBody = (patch: string): string => {
    const firstHunk = patch.search(FIRST_HUNK_PATTERN);
    return firstHunk < 0 ? '' : patch.slice(firstHunk);
};

/**
 * The unified diff to render for a file's session changes.
 *
 * A file edited several times has one patch per edit, each against its own base
 * state. Their hunks are concatenated under the first patch's header so the
 * review shows every added and removed line; hunk line numbers after the first
 * edit are only approximate, which the diff renderer tolerates. A single patch
 * (and any binary patch) is returned untouched.
 */
export const sessionChangePatch = (change: SessionFileChange): string | undefined => {
    const patches = change.patches.filter((patch) => patch.trim().length > 0);
    if (patches.length === 0) return undefined;
    if (patches.length === 1) return patches[0];

    const textual = patches.filter((patch) => !containsBinaryPatch(patch));
    if (textual.length === 0) return patches[0];
    if (textual.length === 1) return textual[0];

    const header = patchHeader(textual[0]) || `--- ${change.path}\n+++ ${change.path}\n`;
    const body = textual
        .map((patch) => {
            const hunks = patchBody(patch);
            if (!hunks) return '';
            return hunks.endsWith('\n') ? hunks : `${hunks}\n`;
        })
        .join('');
    return body ? `${header}${body}` : textual[0];
};

const mergeChangeStatus = (
    previous: SessionFileChange['status'],
    next: SessionFileChange['status'],
): SessionFileChange['status'] => {
    if (previous === 'modified' || previous === next) return next;
    return next === 'modified' ? previous : next;
};

/**
 * Every file the session changed, in first-touch order, from its own tool calls.
 *
 * `directory` is the session directory; a path the transcript reported
 * absolutely is made relative to it for display, and spellings that resolve to
 * the same file (a relative and an absolute one) collapse to a single entry.
 */
export function collectSessionFileChanges(
    messages: readonly ChatMessageEntry[],
    directory: string | null | undefined,
): SessionFileChange[] {
    const merged = new Map<string, SessionFileChange>();

    for (const detail of summarizeLiveActivity(messages).changedFileDetails) {
        const path = getRelativeFilePath(detail.path, directory) || normalizeFilePath(detail.path);
        const key = comparablePath(path);
        const existing = merged.get(key);
        if (!existing) {
            merged.set(key, { ...detail, path, patches: [...detail.patches] });
            continue;
        }
        existing.additions += detail.additions;
        existing.deletions += detail.deletions;
        existing.patches.push(...detail.patches);
        existing.status = mergeChangeStatus(existing.status, detail.status);
        if (detail.writtenContent !== undefined) existing.writtenContent = detail.writtenContent;
    }

    return Array.from(merged.values()).sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Every descendant session of `rootId`, breadth-first.
 *
 * A subagent runs in a child session (`session.parentID`) and edits the same
 * working tree, so a complete review has to include its transcript and any
 * descendants of its own.
 */
export function collectDescendantSessionIds(
    sessions: readonly Session[],
    rootId: string,
): string[] {
    const childrenByParent = new Map<string, string[]>();
    for (const session of sessions) {
        if (!session.parentID) continue;
        const siblings = childrenByParent.get(session.parentID);
        if (siblings) siblings.push(session.id);
        else childrenByParent.set(session.parentID, [session.id]);
    }

    const descendants: string[] = [];
    const seen = new Set([rootId]);
    const queue = [rootId];
    while (queue.length > 0) {
        const parent = queue.shift() as string;
        for (const child of childrenByParent.get(parent) ?? []) {
            if (seen.has(child)) continue;
            seen.add(child);
            descendants.push(child);
            queue.push(child);
        }
    }
    return descendants;
}
