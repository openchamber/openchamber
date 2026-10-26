import { describe, expect, test } from 'bun:test';

import {
    collectDroppedFileUris,
    collectDroppedFiles,
    hasDraggedFiles,
    INTERNAL_FILE_PATH_TYPE,
} from '../dataTransfer';

/** A minimal DataTransfer stand-in; only what the helpers read is modelled. */
function fakeTransfer(options: {
    types?: string[];
    data?: Record<string, string>;
    files?: File[];
    items?: Array<{ kind: string; file?: File }>;
    throwOnGetData?: boolean;
}): DataTransfer {
    const data = options.data ?? {};
    return {
        types: options.types ?? Object.keys(data),
        files: options.files ?? [],
        items: (options.items ?? []).map((item) => ({
            kind: item.kind,
            getAsFile: () => item.file ?? null,
        })),
        getData: (type: string) => {
            if (options.throwOnGetData) throw new Error('unavailable during dragover');
            return data[type] ?? '';
        },
    } as unknown as DataTransfer;
}

const file = (name: string) => new File(['x'], name, { type: 'text/plain' });

describe('hasDraggedFiles', () => {
    test('real files are recognized', () => {
        expect(hasDraggedFiles(fakeTransfer({ files: [file('a.txt')] }))).toBe(true);
    });

    test('a declared file-bearing type is enough', () => {
        expect(hasDraggedFiles(fakeTransfer({ types: ['Files'] }))).toBe(true);
        expect(hasDraggedFiles(fakeTransfer({ types: ['text/uri-list'] }))).toBe(true);
        expect(hasDraggedFiles(fakeTransfer({ types: ['CodeFiles'] }))).toBe(true);
    });

    test('an internal file-tree drag is recognized', () => {
        expect(hasDraggedFiles(fakeTransfer({ types: [INTERNAL_FILE_PATH_TYPE] }))).toBe(true);
    });

    test('a VS Code tree type is recognized by prefix', () => {
        expect(hasDraggedFiles(fakeTransfer({ types: ['application/vnd.code.tree.explorer'] })))
            .toBe(true);
    });

    test('type matching is case-insensitive', () => {
        expect(hasDraggedFiles(fakeTransfer({ types: ['FILES'] }))).toBe(true);
    });

    test('falls back to scanning payloads when the types say nothing useful', () => {
        expect(hasDraggedFiles(fakeTransfer({
            types: ['application/unknown'],
            data: { 'text/plain': '/repo/a.ts' },
        }))).toBe(true);
    });

    test('dragged text is not a file drag', () => {
        expect(hasDraggedFiles(fakeTransfer({
            types: ['text/plain'],
            data: { 'text/plain': 'just some words' },
        }))).toBe(false);
    });

    test('a missing transfer is not a file drag', () => {
        expect(hasDraggedFiles(null)).toBe(false);
        expect(hasDraggedFiles(undefined)).toBe(false);
    });

    test('an unreadable payload does not abort the scan', () => {
        expect(hasDraggedFiles(fakeTransfer({
            types: ['application/unknown'],
            throwOnGetData: true,
        }))).toBe(false);
    });
});

describe('collectDroppedFiles', () => {
    test('reads the files list', () => {
        expect(collectDroppedFiles(fakeTransfer({ files: [file('a.txt')] })).map((f) => f.name))
            .toEqual(['a.txt']);
    });

    test('falls back to the item list', () => {
        expect(collectDroppedFiles(fakeTransfer({
            items: [{ kind: 'file', file: file('b.txt') }],
        })).map((f) => f.name)).toEqual(['b.txt']);
    });

    test('non-file items are skipped', () => {
        expect(collectDroppedFiles(fakeTransfer({
            items: [{ kind: 'string' }, { kind: 'file', file: file('c.txt') }],
        })).map((f) => f.name)).toEqual(['c.txt']);
    });

    test('a file item that yields nothing is skipped', () => {
        expect(collectDroppedFiles(fakeTransfer({ items: [{ kind: 'file' }] }))).toEqual([]);
    });

    test('an empty or missing transfer yields nothing', () => {
        expect(collectDroppedFiles(fakeTransfer({}))).toEqual([]);
        expect(collectDroppedFiles(null)).toEqual([]);
    });
});

describe('collectDroppedFileUris', () => {
    test('reads paths out of a VS Code payload', () => {
        expect(collectDroppedFileUris(fakeTransfer({
            data: { 'text/uri-list': 'file:///repo/a.ts' },
        }))).toEqual(['file:///repo/a.ts']);
    });

    test('the same path across several types is returned once', () => {
        expect(collectDroppedFileUris(fakeTransfer({
            data: { 'text/uri-list': '/repo/a.ts', 'text/plain': '/repo/a.ts' },
        }))).toEqual(['/repo/a.ts']);
    });

    test('a payload with no paths yields nothing', () => {
        expect(collectDroppedFileUris(fakeTransfer({
            data: { 'text/plain': 'words' },
        }))).toEqual([]);
    });

    test('a transfer without getData yields nothing', () => {
        expect(collectDroppedFileUris({} as DataTransfer)).toEqual([]);
        expect(collectDroppedFileUris(null)).toEqual([]);
    });
});
