import { z } from 'zod';
import { normalizeFilePath, toAbsoluteFilePath } from '@/lib/path-utils';
import type { ChatMessageEntry } from './types';

const patchTextSchema = z.string().regex(/\S/);
const patchSchema = z.union([patchTextSchema, z.object({ patch: patchTextSchema }).transform((value) => value.patch)]);
const optionalText = z.string().trim().min(1).optional().catch(undefined);
const optionalCount = z.number().int().nonnegative().optional().catch(undefined);
const fileSchema = z.object({
    file: optionalText,
    filePath: optionalText,
    relativePath: optionalText,
    movePath: optionalText,
    type: optionalText,
    patch: patchSchema.optional().catch(undefined),
    diff: patchSchema.optional().catch(undefined),
    additions: optionalCount,
    deletions: optionalCount,
});
// Tool metadata is an external boundary. Parse only the fields whose meaning
// is established by our edit/patch renderers; unrelated or malformed fields
// must not erase other valid calls from the report.
const metadataSchema = z.object({
    files: z.array(fileSchema.nullable().catch(null)).optional().catch(undefined),
    filediff: fileSchema.optional().catch(undefined),
    patch: patchSchema.optional().catch(undefined),
    diff: patchSchema.optional().catch(undefined),
    sessionId: optionalText,
    exit: z.number().optional().catch(undefined),
});
const inputSchema = z.object({
    filePath: optionalText,
    file_path: optionalText,
    path: optionalText,
});

const changeTools = new Set(['edit', 'multiedit', 'write', 'apply_patch']);
const explorationTools = new Set(['read', 'list', 'grep', 'glob', 'lsp', 'skill']);
const webTools = new Set(['websearch', 'perplexity', 'codesearch', 'webfetch']);
const commandTools = new Set(['bash', 'shell', 'cmd', 'terminal']);

export interface LiveActivitySummary {
    files: number;
    additions: number;
    deletions: number;
    hasCompleteDiff: boolean;
    explored: boolean;
    commands: number;
    researched: boolean;
    subagents: number;
}

function countPatch(patch: string | undefined): { additions: number; deletions: number } | undefined {
    if (!patch) return undefined;
    let additions = 0;
    let deletions = 0;
    let hasHunk = false;
    let oldRemaining = 0;
    let newRemaining = 0;
    // Count hunk bodies, not file headers. A source line beginning with ++ or
    // -- is still a real added/deleted line inside a hunk.
    for (const line of patch.split('\n')) {
        const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (hunk) {
            if (oldRemaining !== 0 || newRemaining !== 0) return undefined;
            hasHunk = true;
            oldRemaining = Number(hunk[2] ?? 1);
            newRemaining = Number(hunk[4] ?? 1);
        } else if (oldRemaining > 0 || newRemaining > 0) {
            if (line.startsWith('+') && newRemaining > 0) {
                additions++;
                newRemaining--;
            } else if (line.startsWith('-') && oldRemaining > 0) {
                deletions++;
                oldRemaining--;
            } else if (line.startsWith(' ') && oldRemaining > 0 && newRemaining > 0) {
                oldRemaining--;
                newRemaining--;
            } else if (!line.startsWith('\\ No newline')) {
                return undefined;
            }
        }
    }
    return hasHunk && oldRemaining === 0 && newRemaining === 0 ? { additions, deletions } : undefined;
}

export function summarizeLiveActivity(messages: readonly ChatMessageEntry[]): LiveActivitySummary {
    const summary: LiveActivitySummary = {
        files: 0, additions: 0, deletions: 0, hasCompleteDiff: true,
        explored: false, commands: 0, researched: false, subagents: 0,
    };
    const changedFiles = new Set<string>();
    const subagents = new Set<string>();
    const seenCalls = new Set<string>();
    for (const message of messages) {
        const cwd = message.info.role === 'assistant' ? message.info.path?.cwd ?? '' : '';
        const resolvePath = (path: string) => {
            const absolute = normalizeFilePath(cwd ? toAbsoluteFilePath(cwd, path) : path);
            if (/^[A-Za-z]:\//.test(absolute)) {
                return toAbsoluteFilePath(absolute.slice(0, 3), absolute.slice(3)).toLowerCase();
            }
            if (absolute.startsWith('//')) {
                const [server, share, ...parts] = absolute.slice(2).split('/');
                return toAbsoluteFilePath(`//${server}/${share}`, parts.join('/')).toLowerCase();
            }
            return absolute.startsWith('/') ? toAbsoluteFilePath('/', absolute.slice(1)) : absolute;
        };
        for (const part of message.parts) {
            if (part.type !== 'tool') continue;
            const callKey = `${message.info.id}:${part.callID || part.id}`;
            if (seenCalls.has(callKey)) continue;
            seenCalls.add(callKey);
            const state = part.state;
            if (state.status !== 'completed' && state.status !== 'error') continue;
            const tool = part.tool.trim().toLowerCase();
            const metadata = metadataSchema.safeParse(state.metadata).data;
            if (commandTools.has(tool) && (state.status === 'completed' || metadata?.exit !== undefined)) {
                summary.commands++;
            }
            if (state.status !== 'completed') continue;
            summary.explored ||= explorationTools.has(tool);
            summary.researched ||= webTools.has(tool);
            if (tool === 'task' && metadata?.sessionId) subagents.add(metadata.sessionId);
            if (!changeTools.has(tool)) continue;

            const input = inputSchema.safeParse(state.input).data;
            if (metadata?.files?.some((file) => file === null)) summary.hasCompleteDiff = false;
            const entries = metadata?.files?.filter((file) => file !== null);
            const files = entries?.length ? entries : [metadata?.filediff ?? {}];
            let missingFileDiff = false;
            let callAdditions = 0;
            let callDeletions = 0;
            const callPaths = new Set<string>();
            for (const file of files) {
                const originalPath = file.filePath ?? file.file ?? file.relativePath
                    ?? (tool !== 'apply_patch' ? input?.filePath ?? input?.file_path ?? input?.path : undefined);
                const path = file.movePath ?? originalPath;
                if (!path) {
                    summary.hasCompleteDiff = false;
                    continue;
                }
                const normalizedPath = resolvePath(path);
                if (callPaths.has(normalizedPath)) continue;
                callPaths.add(normalizedPath);
                const stats = countPatch(file.patch ?? file.diff)
                    ?? (file.additions !== undefined && file.deletions !== undefined
                        ? { additions: file.additions, deletions: file.deletions } : undefined);
                if (stats && stats.additions === 0 && stats.deletions === 0
                    && !file.movePath && file.type !== 'add' && file.type !== 'delete') continue;
                // A rename moves an existing identity rather than counting it
                // again when the same file was edited earlier in this turn.
                if (file.movePath && originalPath) changedFiles.delete(resolvePath(originalPath));
                changedFiles.add(normalizedPath);
                if (!stats) {
                    missingFileDiff = true;
                } else {
                    callAdditions += stats.additions;
                    callDeletions += stats.deletions;
                }
            }
            if (missingFileDiff) {
                // The top-level patch describes the entire call. Use it instead
                // of (never in addition to) any per-file numbers already found.
                const fallback = countPatch(metadata?.patch ?? metadata?.diff);
                if (fallback) {
                    callAdditions = fallback.additions;
                    callDeletions = fallback.deletions;
                } else {
                    summary.hasCompleteDiff = false;
                }
            }
            summary.additions += callAdditions;
            summary.deletions += callDeletions;
        }
    }
    summary.files = changedFiles.size;
    summary.subagents = subagents.size;
    return summary;
}
