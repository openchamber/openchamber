import { describe, expect, test } from 'bun:test';

import {
    extractFirstChangedLineFromDiff,
    getApplyPatchFilePath,
    getDiffPatchEntries,
    getFirstChangedLineFromMetadata,
    getMutatedToolPaths,
    getPrimaryDiffFromMetadata,
    getPrimaryToolPath,
    getRenderablePatchInfo,
    resolveToolQuickOpenTarget,
} from './toolDiffUtils';

const identity = (path: string) => path;

describe('toolDiffUtils', () => {
    test('prefers the absolute apply_patch path over its worktree-relative label', () => {
        expect(getPrimaryToolPath('apply_patch', undefined, {
            files: [{
                filePath: '/workspace/project/src/file.ts',
                relativePath: 'workspace/project/src/file.ts',
                type: 'update',
            }],
        })).toBe('/workspace/project/src/file.ts');
    });

    test('opens the move destination and skips deleted apply_patch files', () => {
        expect(getPrimaryToolPath('apply_patch', undefined, {
            files: [
                { filePath: '/workspace/deleted.ts', relativePath: 'deleted.ts', type: 'delete' },
                {
                    filePath: '/workspace/old.ts',
                    relativePath: 'new.ts',
                    movePath: '/workspace/new.ts',
                    type: 'move',
                },
            ],
        })).toBe('/workspace/new.ts');
    });

    test('falls back to the relative apply_patch path for legacy metadata', () => {
        expect(getPrimaryToolPath('apply_patch', undefined, {
            files: [{ relativePath: 'src/file.ts', type: 'update' }],
        })).toBe('src/file.ts');
    });

    test('resolves each apply_patch file independently', () => {
        expect(getApplyPatchFilePath({
            filePath: '/workspace/project/src/first.ts',
            relativePath: 'workspace/project/src/first.ts',
        })).toBe('/workspace/project/src/first.ts');
        expect(getApplyPatchFilePath({
            filePath: '/workspace/project/src/old.ts',
            movePath: '/workspace/project/src/second.ts',
            relativePath: 'src/second.ts',
        })).toBe('/workspace/project/src/second.ts');
    });

    test('lists every apply_patch mutation path, including both sides of a move', () => {
        expect(getMutatedToolPaths('apply_patch', undefined, {
            files: [
                { filePath: '/workspace/project/src/deleted.ts', type: 'delete' },
                {
                    filePath: '/workspace/project/src/old.ts',
                    movePath: '/workspace/project/src/new.ts',
                    type: 'move',
                },
            ],
        })).toEqual([
            '/workspace/project/src/deleted.ts',
            '/workspace/project/src/new.ts',
            '/workspace/project/src/old.ts',
        ]);
    });

    test('does not invent paths for bash or task tools', () => {
        expect(getMutatedToolPaths('bash', { command: 'date' }, undefined)).toEqual([]);
        expect(getMutatedToolPaths('task', { description: 'inspect' }, undefined)).toEqual([]);
    });

    test('selects the move patch and line from the same non-deleted file', () => {
        const deletedPatch = '@@ -3 +3 @@\n-old\n+deleted';
        const movedPatch = '@@ -42 +42 @@\n-before\n+after';
        const metadata = {
            patch: deletedPatch,
            files: [
                {
                    filePath: '/workspace/project/src/deleted.ts',
                    relativePath: 'src/deleted.ts',
                    patch: deletedPatch,
                    type: 'delete',
                },
                {
                    filePath: '/workspace/project/src/old.ts',
                    movePath: '/workspace/project/src/moved.ts',
                    relativePath: 'src/moved.ts',
                    patch: movedPatch,
                    type: 'move',
                },
            ],
        };

        expect(getPrimaryDiffFromMetadata('apply_patch', metadata, '/workspace/project/src/moved.ts'))
            .toBe(movedPatch);
        expect(getFirstChangedLineFromMetadata('apply_patch', metadata, '/workspace/project/src/moved.ts'))
            .toBe(42);
    });

    test('treats raw apply_patch envelopes as text, not visual diffs', () => {
        const entries = getDiffPatchEntries(undefined, [
            '*** Begin Patch',
            '*** Update File: src/app.ts',
            '@@ -1 +1 @@',
            '-old',
            '+new',
            '*** End Patch',
        ].join('\n'), identity);

        expect(entries).toHaveLength(1);
        expect(entries[0]?.renderMode).toBe('text');
        expect(entries[0]?.patch).toContain('*** Begin Patch');
    });

    test('splits multi-file unified patches into one renderable entry per file', () => {
        const entries = getDiffPatchEntries(undefined, [
            '--- a/src/a.ts',
            '+++ b/src/a.ts',
            '@@ -1 +1 @@',
            '-old',
            '+new',
            '--- a/src/b.ts',
            '+++ b/src/b.ts',
            '@@ -1 +1 @@',
            '-left',
            '+right',
        ].join('\n'), identity);

        expect(entries.map((entry) => entry.renderMode)).toEqual(['diff', 'diff']);
        expect(entries.map((entry) => entry.title)).toEqual(['src/a.ts', 'src/b.ts']);
    });

    test('uses metadata.files patches before top-level fallback diffs', () => {
        const entries = getDiffPatchEntries({
            files: [{
                relativePath: 'src/file.ts',
                patch: [
                    '--- a/src/file.ts',
                    '+++ b/src/file.ts',
                    '@@ -1 +1 @@',
                    '-old',
                    '+new',
                ].join('\n'),
            }],
        }, 'not a diff', identity);

        expect(entries).toHaveLength(1);
        expect(entries[0]?.renderMode).toBe('diff');
        expect(entries[0]?.title).toBe('src/file.ts');
    });

    test('keeps the authoritative path for every metadata file entry', () => {
        const patch = [
            '--- a/src/file.ts',
            '+++ b/src/file.ts',
            '@@ -1 +1 @@',
            '-old',
            '+new',
        ].join('\n');
        const entries = getDiffPatchEntries({
            files: [
                { filePath: '/workspace/project/src/first.ts', relativePath: 'src/first.ts', patch },
                { filePath: '/workspace/project/src/second.ts', relativePath: 'src/second.ts', patch },
            ],
        }, undefined, identity);

        expect(entries.map((entry) => entry.filePath)).toEqual([
            '/workspace/project/src/first.ts',
            '/workspace/project/src/second.ts',
        ]);
    });

    test('synthesizes headers for valid headerless hunks', () => {
        const entries = getDiffPatchEntries(undefined, [
            '@@ -1 +1 @@',
            '-old',
            '+new',
        ].join('\n'), identity);

        expect(entries).toHaveLength(1);
        expect(entries[0]?.renderMode).toBe('diff');
        expect(getRenderablePatchInfo(entries[0]?.patch ?? '')).not.toBeNull();
    });

    test('keeps malformed unified patches as text fallbacks', () => {
        const entries = getDiffPatchEntries(undefined, [
            '--- a/src/file.ts',
            '+++ b/src/file.ts',
            '@@',
            '-old',
            '+new',
        ].join('\n'), identity);

        expect(entries).toHaveLength(1);
        expect(entries[0]?.renderMode).toBe('text');
        expect(entries[0]?.patch).toContain('@@');
    });
    test('resolves the quick-open target from the same entry the expanded card renders', () => {
        const patch = [
            '--- a/src/file.ts',
            '+++ b/src/file.ts',
            '@@ -10,3 +12,4 @@',
            ' context',
            '+added',
        ].join('\n');
        const metadata = {
            files: [{
                filePath: '/workspace/project/src/file.ts',
                relativePath: 'src/file.ts',
                patch,
                type: 'update',
            }],
        };
        const entries = getDiffPatchEntries(metadata, undefined, identity);

        expect(resolveToolQuickOpenTarget('apply_patch', undefined, metadata)).toEqual({
            filePath: '/workspace/project/src/file.ts',
            line: extractFirstChangedLineFromDiff(entries[0]?.patch ?? ''),
            patch: entries[0]?.patch,
        });
    });

    test('picks the entry matching the primary path in a multi-file apply_patch', () => {
        const firstPatch = ['--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,2 +1,3 @@', ' a', '+first'].join('\n');
        const secondPatch = ['--- a/src/b.ts', '+++ b/src/b.ts', '@@ -30,2 +40,3 @@', ' b', '+second'].join('\n');
        const metadata = {
            files: [
                { filePath: '/workspace/project/src/a.ts', relativePath: 'src/a.ts', patch: firstPatch, type: 'delete' },
                { filePath: '/workspace/project/src/b.ts', relativePath: 'src/b.ts', patch: secondPatch, type: 'update' },
            ],
        };
        const target = resolveToolQuickOpenTarget('apply_patch', undefined, metadata);

        expect(target?.filePath).toBe('/workspace/project/src/b.ts');
        expect(target?.line).toBe(41);
    });

    test('reports no line when the tool has no diff entry', () => {
        expect(resolveToolQuickOpenTarget('write', { filePath: '/workspace/project/src/new.ts' }, undefined))
            .toEqual({ filePath: '/workspace/project/src/new.ts', line: undefined, patch: undefined });
    });

    test('returns no quick-open target without a primary path', () => {
        expect(resolveToolQuickOpenTarget('bash', { command: 'ls' }, undefined)).toBeNull();
    });
});
