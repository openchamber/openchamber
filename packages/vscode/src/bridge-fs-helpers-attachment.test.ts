import { describe, expect, mock, test } from 'bun:test';

// readUriAsAttachment judges its 20 MiB cap: the stat is only a hint, so
// the bytes actually read must be re-judged (#1737). The vscode fs is
// stubbed so stat and read can disagree, modelling a file that grows
// between the two calls.
const MAX = 20 * 1024 * 1024;
let statResult: { type: number; size: number } = { type: 1, size: 0 };
let readResult: Uint8Array = new Uint8Array(0);

mock.module('vscode', () => ({
  workspace: {
    fs: {
      stat: async () => statResult,
      readFile: async () => readResult,
    },
  },
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  Uri: { file: (fsPath: string) => ({ fsPath, path: fsPath }) },
}));

const { readUriAsAttachment } = await import('./bridge-fs-helpers-runtime');

const uri = { fsPath: '/tmp/growing.log', path: '/tmp/growing.log' } as never;

describe('readUriAsAttachment cap is judged on the bytes actually read', () => {
  test('skips a file grown past the cap after an under-cap stat', async () => {
    statResult = { type: 1, size: 100 };
    readResult = new Uint8Array(MAX + 1);
    const result = await readUriAsAttachment(uri);
    expect(result).toEqual({ skipped: { name: 'growing.log', reason: 'File exceeds 20MB limit' } });
  });

  test('reports the size actually read for an in-cap file whose stat disagreed', async () => {
    statResult = { type: 1, size: 100 };
    readResult = new TextEncoder().encode('abc');
    const result = await readUriAsAttachment(uri);
    expect(result).toEqual({
      file: {
        name: 'growing.log',
        mimeType: 'text/plain',
        size: 3,
        dataUrl: 'data:text/plain;base64,YWJj',
      },
    });
  });

  test('still skips on an over-cap stat without relying on the read', async () => {
    statResult = { type: 1, size: MAX + 1 };
    readResult = new Uint8Array(0);
    const result = await readUriAsAttachment(uri);
    expect(result).toEqual({ skipped: { name: 'growing.log', reason: 'File exceeds 20MB limit' } });
  });

  test('still skips directories', async () => {
    statResult = { type: 2, size: 0 };
    readResult = new Uint8Array(0);
    const result = await readUriAsAttachment(uri);
    expect(result).toEqual({ skipped: { name: 'growing.log', reason: 'Folders are not supported' } });
  });
});
