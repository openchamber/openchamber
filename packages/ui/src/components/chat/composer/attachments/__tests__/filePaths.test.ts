import { describe, expect, test } from 'bun:test';

import {
    encodeFilePath,
    isLikelyAbsolutePath,
    normalizeDroppedPath,
    normalizePath,
    parseDroppedFileReferences,
    toLikelyFileDropReference,
    toProjectRelativeMentionPath,
    toServerFileUrl,
} from '../filePaths';

describe('encodeFilePath', () => {
    test('encodes segments but keeps separators', () => {
        expect(encodeFilePath('/a/b c/d.txt')).toBe('/a/b%20c/d.txt');
    });

    test('backslashes become forward slashes', () => {
        expect(encodeFilePath('a\\b\\c.txt')).toBe('a/b/c.txt');
    });

    test('a Windows drive letter is preserved unencoded', () => {
        expect(encodeFilePath('C:\\Users\\me\\a b.txt')).toBe('/C:/Users/me/a%20b.txt');
    });

    test('special characters in a name are encoded', () => {
        expect(encodeFilePath('/a/b#c?d.txt')).toBe('/a/b%23c%3Fd.txt');
    });
});

describe('toServerFileUrl', () => {
    test('wraps a plain path', () => {
        expect(toServerFileUrl('/repo/a.ts')).toBe('file:///repo/a.ts');
    });

    test('an existing file URL is passed through unchanged', () => {
        expect(toServerFileUrl('file:///repo/a.ts')).toBe('file:///repo/a.ts');
        expect(toServerFileUrl('FILE:///repo/a.ts')).toBe('FILE:///repo/a.ts');
    });

    test('a Windows path becomes a valid file URL', () => {
        expect(toServerFileUrl('C:\\repo\\a.ts')).toBe('file:///C:/repo/a.ts');
    });
});

describe('isLikelyAbsolutePath', () => {
    test('recognizes posix, UNC and Windows roots', () => {
        expect(isLikelyAbsolutePath('/repo/a.ts')).toBe(true);
        expect(isLikelyAbsolutePath('\\\\share\\a.ts')).toBe(true);
        expect(isLikelyAbsolutePath('C:/repo')).toBe(true);
        expect(isLikelyAbsolutePath('C:\\repo')).toBe(true);
    });

    test('relative paths are not absolute', () => {
        expect(isLikelyAbsolutePath('src/a.ts')).toBe(false);
        expect(isLikelyAbsolutePath('./a.ts')).toBe(false);
    });
});

describe('toLikelyFileDropReference', () => {
    test('accepts an absolute path and a file URL', () => {
        expect(toLikelyFileDropReference('/repo/a.ts')).toBe('/repo/a.ts');
        expect(toLikelyFileDropReference('file:///repo/a.ts')).toBe('file:///repo/a.ts');
    });

    test('strips surrounding quotes and whitespace', () => {
        expect(toLikelyFileDropReference('  "/repo/a.ts"  ')).toBe('/repo/a.ts');
    });

    test('rejects relative paths, prose and empty input', () => {
        expect(toLikelyFileDropReference('src/a.ts')).toBeNull();
        expect(toLikelyFileDropReference('some dropped sentence')).toBeNull();
        expect(toLikelyFileDropReference('   ')).toBeNull();
    });

    test('rejects a multi-line value, which is a document not a path', () => {
        expect(toLikelyFileDropReference('/repo/a.ts\n/repo/b.ts')).toBeNull();
    });
});

describe('parseDroppedFileReferences', () => {
    test('reads a single path', () => {
        expect(parseDroppedFileReferences('/repo/a.ts')).toEqual(['/repo/a.ts']);
    });

    test('reads a newline-separated URI list', () => {
        expect(parseDroppedFileReferences('file:///repo/a.ts\nfile:///repo/b.ts'))
            .toEqual(['file:///repo/a.ts', 'file:///repo/b.ts']);
    });

    test('finds paths nested inside a JSON payload', () => {
        const payload = JSON.stringify({ items: [{ resource: { path: '/repo/a.ts' } }] });
        expect(parseDroppedFileReferences(payload)).toEqual(['/repo/a.ts']);
    });

    test('duplicates across passes are collapsed', () => {
        expect(parseDroppedFileReferences('/repo/a.ts\n/repo/a.ts')).toEqual(['/repo/a.ts']);
    });

    test('a payload with no paths yields nothing', () => {
        expect(parseDroppedFileReferences('just some text')).toEqual([]);
        expect(parseDroppedFileReferences('')).toEqual([]);
    });

    test('deeply buried paths beyond the depth bound are not searched forever', () => {
        let nested: unknown = '/repo/deep.ts';
        for (let i = 0; i < 20; i += 1) nested = { nested };
        expect(parseDroppedFileReferences(JSON.stringify(nested))).toEqual([]);
    });
});

describe('normalizeDroppedPath', () => {
    test('a plain path is returned as-is', () => {
        expect(normalizeDroppedPath('/repo/a.ts')).toBe('/repo/a.ts');
    });

    test('a file URL is decoded back to a path', () => {
        expect(normalizeDroppedPath('file:///repo/a%20b.ts')).toBe('/repo/a b.ts');
    });

    test('a Windows file URL drops the slash before the drive letter', () => {
        expect(normalizeDroppedPath('file:///C:/repo/a.ts')).toBe('C:/repo/a.ts');
    });

    test('a malformed file URL still yields something usable', () => {
        expect(normalizeDroppedPath('file://%%%')).toBe('%%%');
    });
});

describe('normalizePath', () => {
    test('trims and drops a trailing separator', () => {
        expect(normalizePath('  /repo/dir/  ')).toBe('/repo/dir');
        expect(normalizePath('/repo/dir///')).toBe('/repo/dir');
    });

    test('backslashes become forward slashes', () => {
        expect(normalizePath('C:\\repo\\dir')).toBe('C:/repo/dir');
    });

    test('the root keeps its slash', () => {
        expect(normalizePath('/')).toBe('/');
    });

    test('blank and non-string input yield null', () => {
        expect(normalizePath('')).toBeNull();
        expect(normalizePath('   ')).toBeNull();
        expect(normalizePath(null)).toBeNull();
        expect(normalizePath(undefined)).toBeNull();
    });
});

describe('toProjectRelativeMentionPath', () => {
    test('strips the project root', () => {
        expect(toProjectRelativeMentionPath('/repo/src/a.ts', '/repo')).toBe('src/a.ts');
    });

    test('tolerates a trailing slash on the root', () => {
        expect(toProjectRelativeMentionPath('/repo/src/a.ts', '/repo/')).toBe('src/a.ts');
    });

    test('a path outside the root stays absolute', () => {
        expect(toProjectRelativeMentionPath('/other/a.ts', '/repo')).toBe('/other/a.ts');
    });

    test('a sibling directory sharing a prefix is not treated as inside', () => {
        expect(toProjectRelativeMentionPath('/repo-other/a.ts', '/repo')).toBe('/repo-other/a.ts');
    });

    test('the root itself is returned unchanged', () => {
        expect(toProjectRelativeMentionPath('/repo', '/repo')).toBe('/repo');
    });

    test('with no root the path is left alone', () => {
        expect(toProjectRelativeMentionPath('/repo/src/a.ts', '')).toBe('/repo/src/a.ts');
    });
});
