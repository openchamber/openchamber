import { describe, expect, test } from 'bun:test';

import { LARGE_DIFF_CHANGED_LINES } from './diffContextLines';
import {
    LARGE_PATCH_CHARS,
    comparisonResultDiffData,
    countPatchChangedLines,
    createComparisonDiffFromPatch,
    createComparisonDiffFromVersions,
    patchShowsLine,
} from './diffData';

const patchOf = (lines: string[]) => [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    `@@ -1,${lines.length} +1,${lines.length} @@`,
    ...lines,
    '',
].join('\n');

describe('countPatchChangedLines', () => {
    test('counts added and removed lines but not the file headers', () => {
        expect(countPatchChangedLines(patchOf(['+added', '-removed', ' context', '--- removed dashes']))).toBe(3);
    });

    test('reads a patch that starts at its first hunk', () => {
        expect(countPatchChangedLines('@@ -1 +1 @@\n-a\n+b')).toBe(2);
    });

    test('a patch without hunks has no changed lines', () => {
        expect(countPatchChangedLines('diff --git a/x b/x\nBinary files differ\n')).toBe(0);
    });
});

describe('createComparisonDiffFromPatch', () => {
    test('parses a patch within the limits', () => {
        const result = createComparisonDiffFromPatch('src/a.ts', patchOf(['+one', '-two']), 'patch');
        expect(result.status).toBe('ready');
        expect(result.status === 'ready' && result.data.fileDiff).toBeTruthy();
    });

    test('holds a patch with more changed lines than the large-diff limit unparsed', () => {
        // Branch rows carry no line counts, so the entry cannot ask before the patch arrives.
        const lines = Array.from({ length: LARGE_DIFF_CHANGED_LINES + 1 }, (_, index) => `+line ${index}`);
        const result = createComparisonDiffFromPatch('src/a.ts', patchOf(lines), 'patch');
        expect(result).toMatchObject({ status: 'large', changedLines: LARGE_DIFF_CHANGED_LINES + 1 });
    });

    test('holds one very long changed line unparsed', () => {
        const result = createComparisonDiffFromPatch('dist/app.min.js', patchOf([`+${'x'.repeat(LARGE_PATCH_CHARS)}`]), 'patch');
        expect(result).toMatchObject({ status: 'large', changedLines: 1 });
    });

    test('parses a full-context read the user asked for', () => {
        const lines = Array.from({ length: LARGE_DIFF_CHANGED_LINES + 1 }, (_, index) => `+line ${index}`);
        expect(createComparisonDiffFromPatch('src/a.ts', patchOf(lines), 'full').status).toBe('ready');
    });

    test('a large patch parses when its diff is read', () => {
        const lines = Array.from({ length: LARGE_DIFF_CHANGED_LINES + 1 }, (_, index) => `+line ${index}`);
        const result = createComparisonDiffFromPatch('src/a.ts', patchOf(lines), 'patch');
        expect(comparisonResultDiffData('src/a.ts', result)?.fileDiff).toBeTruthy();
        expect(comparisonResultDiffData('src/a.ts', { status: 'loading' })).toBeNull();
    });
});

describe('expanded reads', () => {
    test('holds a full-context read too big to parse until the user asks', () => {
        const patch = patchOf([`+${'x'.repeat(10)}`, ` ${'y'.repeat(LARGE_PATCH_CHARS)}`]);
        const result = createComparisonDiffFromPatch('src/a.ts', patch, 'full');
        expect(result).toMatchObject({ status: 'large', contextMode: 'full', changedLines: 1 });
        expect(comparisonResultDiffData('src/a.ts', result)?.contextMode).toBe('full');
    });

    test('holds a full-file pair too big to parse until the user asks', () => {
        const big = 'x\n'.repeat(LARGE_PATCH_CHARS / 2);
        const result = createComparisonDiffFromVersions('src/a.ts', big, `${big}y\n`, 0);
        expect(result).toMatchObject({ status: 'large', contextMode: 'full' });
        expect(comparisonResultDiffData('src/a.ts', result)?.fileDiff).toBeTruthy();
        expect(createComparisonDiffFromVersions('src/a.ts', 'a\n', 'b\n', 0).status).toBe('ready');
    });
});

describe('patchShowsLine', () => {
    const patch = '@@ -10,5 +12,6 @@\n ctx\n@@ -40 +43 @@\n-a\n+b\n';

    test('reads each side from the hunk headers', () => {
        expect(patchShowsLine(patch, 12, 'additions')).toBe(true);
        expect(patchShowsLine(patch, 17, 'additions')).toBe(true);
        expect(patchShowsLine(patch, 18, 'additions')).toBe(false);
        expect(patchShowsLine(patch, 14, 'deletions')).toBe(true);
        expect(patchShowsLine(patch, 15, 'deletions')).toBe(false);
    });

    test('a header without a count covers one line', () => {
        expect(patchShowsLine(patch, 43, 'additions')).toBe(true);
        expect(patchShowsLine(patch, 44, 'additions')).toBe(false);
        expect(patchShowsLine(patch, 40, 'deletions')).toBe(true);
    });
});
