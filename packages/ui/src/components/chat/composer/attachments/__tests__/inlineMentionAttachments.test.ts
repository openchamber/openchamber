import { describe, expect, test } from 'bun:test';

import { FilesystemError } from '@/lib/api/files-errors';
import type { AttachedFile } from '@/stores/types/sessionTypes';

import {
    filterMissingInlineAttachments,
    isMentionAlreadyAttached,
    type DirectoryLister,
} from '../inlineMentionAttachments';

function inlineFile(id: string, serverPath: string, filename: string): AttachedFile {
    return {
        id: `inline-server-${id}`,
        file: new File([], filename, { type: 'text/plain' }),
        filename,
        mimeType: 'text/plain',
        size: 0,
        dataUrl: `file://${serverPath}`,
        source: 'server',
        serverPath,
    };
}

function pickedFile(id: string, serverPath: string, filename: string): AttachedFile {
    return { ...inlineFile(`picked-${id}`, serverPath, filename), id, source: 'server' };
}

function lister(
    listings: Record<string, string[]>,
    calls: string[],
    throws = false,
): DirectoryLister {
    return {
        listLocalDirectory: async (directory: string) => {
            calls.push(directory);
            if (throws) throw new Error('listing failed');
            return (listings[directory] ?? []).map((path) => ({ path }));
        },
    };
}

describe('filterMissingInlineAttachments', () => {
    test('keeps everything when no inline attachments exist', async () => {
        const calls: string[] = [];
        const files = [pickedFile('a', '/repo/exists.txt', 'exists.txt')];

        const result = await filterMissingInlineAttachments(files, lister({}, calls));

        expect(result.sendable).toEqual(files);
        expect(result.skippedNames).toEqual([]);
        expect(calls).toEqual([]);
    });

    test('keeps attachments whose files exist, listing each directory once', async () => {
        const calls: string[] = [];
        const files = [
            inlineFile('1', '/repo/a.txt', 'a.txt'),
            inlineFile('2', '/repo/b.txt', 'b.txt'),
        ];

        const result = await filterMissingInlineAttachments(
            files,
            lister({ '/repo': ['/repo/a.txt', '/repo/b.txt'] }, calls),
        );

        expect(result.sendable).toEqual(files);
        expect(result.skippedNames).toEqual([]);
        expect(calls).toEqual(['/repo']);
    });

    test('drops only the missing inline attachment and names it', async () => {
        const calls: string[] = [];
        const real = inlineFile('1', '/repo/real.txt', 'real.txt');
        const phantom = inlineFile('2', '/repo/masha.conner', 'masha.conner');
        const picked = pickedFile('p', '/repo/gone.txt', 'gone.txt');

        const result = await filterMissingInlineAttachments(
            [real, phantom, picked],
            lister({ '/repo': ['/repo/real.txt'] }, calls),
        );

        expect(result.sendable).toEqual([real, picked]);
        expect(result.skippedNames).toEqual(['masha.conner']);
    });

    test('fails open when the listing errors', async () => {
        const calls: string[] = [];
        const files = [inlineFile('1', '/repo/missing.txt', 'missing.txt')];

        const result = await filterMissingInlineAttachments(files, lister({}, calls, true));

        expect(result.sendable).toEqual(files);
        expect(result.skippedNames).toEqual([]);
    });

    test('drops mentions whose parent directory does not exist and keeps checking the rest', async () => {
        const scoped = inlineFile('1', '/repo/types/node', 'node');
        const real = inlineFile('2', '/repo/real.txt', 'real.txt');
        const directoryLister: DirectoryLister = {
            listLocalDirectory: async (directory: string) => {
                if (directory === '/repo/types') {
                    throw new FilesystemError('Directory not found', { reason: 'not-found', status: 404 });
                }
                return [{ path: '/repo/real.txt' }];
            },
        };

        const result = await filterMissingInlineAttachments([scoped, real], directoryLister);

        expect(result.sendable).toEqual([real]);
        expect(result.skippedNames).toEqual(['node']);
    });

    test('a failing listing keeps only its own directory unchecked', async () => {
        const unchecked = inlineFile('1', '/locked/file.txt', 'file.txt');
        const phantom = inlineFile('2', '/repo/masha.conner', 'masha.conner');
        const directoryLister: DirectoryLister = {
            listLocalDirectory: async (directory: string) => {
                if (directory === '/locked') throw new Error('permission denied');
                return [];
            },
        };

        const result = await filterMissingInlineAttachments([unchecked, phantom], directoryLister);

        expect(result.sendable).toEqual([unchecked]);
        expect(result.skippedNames).toEqual(['masha.conner']);
    });

    test('matches directories and paths that differ only in case', async () => {
        const calls: string[] = [];
        const directory = inlineFile('1', '/repo/src/', 'src');
        const readme = inlineFile('2', '/repo/readme.md', 'readme.md');

        const result = await filterMissingInlineAttachments(
            [directory, readme],
            lister({ '/repo': ['/repo/src', '/repo/README.md'] }, calls),
        );

        expect(result.sendable).toEqual([directory, readme]);
        expect(result.skippedNames).toEqual([]);
    });
});

/** A fork replay restores a file part as a local attachment holding its URL. */
function replayedFile(url: string, filename: string): AttachedFile {
    return {
        id: 'restored-1',
        file: new File([], filename, { type: 'text/plain' }),
        dataUrl: url,
        mimeType: 'text/plain',
        filename,
        size: 0,
        source: 'local',
        serverPath: url,
    };
}

describe('isMentionAlreadyAttached', () => {
    test('recognizes a replayed file whose mention is a plain path', () => {
        const mention = { serverPath: '/repo/src/a.ts', filename: 'a.ts' };

        expect(isMentionAlreadyAttached(mention, [replayedFile('file:///repo/src/a.ts', 'a.ts')])).toBe(true);
    });

    test('compares a Windows drive URL and its plain path', () => {
        const mention = { serverPath: 'C:/repo/src/a.ts', filename: 'a.ts' };

        expect(isMentionAlreadyAttached(mention, [replayedFile('file:///C:/repo/src/a.ts', 'a.ts')])).toBe(true);
    });

    test('decodes an encoded URL', () => {
        const mention = { serverPath: '/repo/src/My File.ts', filename: 'My File.ts' };

        expect(isMentionAlreadyAttached(mention, [replayedFile('file:///repo/src/My%20File.ts', 'My File.ts')])).toBe(true);
    });

    test('keeps distinct case-sensitive paths', () => {
        expect(isMentionAlreadyAttached(
            { serverPath: '/repo/a.ts', filename: 'a.ts' },
            [replayedFile('file:///repo/A.ts', 'A.ts')],
        )).toBe(false);
    });

    test('keeps a same-named file from another directory', () => {
        const mention = { serverPath: '/repo/lib/index.ts', filename: 'index.ts' };

        expect(isMentionAlreadyAttached(mention, [replayedFile('file:///repo/src/index.ts', 'index.ts')])).toBe(false);
        expect(isMentionAlreadyAttached(mention, [pickedFile('1', '/repo/src/index.ts', 'index.ts')])).toBe(false);
    });

    test('keeps a same-named converted image without a known source path', () => {
        const converted = replayedFile('data:image/png;base64,aGVsbG8=', 'shot.png');

        expect(isMentionAlreadyAttached(
            { serverPath: '/repo/assets/shot.png', filename: 'shot.png' },
            [converted],
        )).toBe(false);
    });

    test('recognizes a converted image only when its source path is retained', () => {
        const converted = {
            ...replayedFile('data:image/png;base64,aGVsbG8=', 'shot.png'),
            serverPath: '/repo/assets/shot.png',
        };
        expect(isMentionAlreadyAttached(
            { serverPath: '/repo/assets/shot.png', filename: 'shot.png' },
            [converted],
        )).toBe(true);
    });

    test('keeps a same-named local upload and a repo file', () => {
        const local = replayedFile('data:image/png;base64,aGVsbG8=', 'overview.png');
        delete local.serverPath;
        expect(isMentionAlreadyAttached(
            { serverPath: '/repo/docs/overview.png', filename: 'overview.png' },
            [local],
        )).toBe(false);
    });

    test('recognizes VS Code native paths', () => {
        const file = { ...replayedFile('data:text/plain;base64,', 'a.ts'), vscodePath: 'C:\\repo\\src\\a.ts' };
        expect(isMentionAlreadyAttached({ serverPath: 'C:/repo/src/a.ts', filename: 'a.ts' }, [file])).toBe(true);
    });

    test('keeps a replayed file from another worktree', () => {
        expect(isMentionAlreadyAttached(
            { serverPath: '/new/src/a.ts', filename: 'a.ts' },
            [replayedFile('file:///old/src/a.ts', 'a.ts')],
        )).toBe(false);
    });

    test('keeps a file URL with a different host and a native UNC path distinct', () => {
        const mention = { serverPath: '/server/share/a.ts', filename: 'a.ts' };
        expect(isMentionAlreadyAttached(mention, [replayedFile('file://server/server/share/a.ts', 'a.ts')])).toBe(false);
        expect(isMentionAlreadyAttached(mention, [replayedFile('\\\\server\\share\\a.ts', 'a.ts')])).toBe(false);
    });

    test('reports nothing attached when the composer has no files', () => {
        expect(isMentionAlreadyAttached({ serverPath: '/repo/a.ts', filename: 'a.ts' }, [])).toBe(false);
    });
});
