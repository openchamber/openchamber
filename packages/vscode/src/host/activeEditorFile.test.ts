import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isSameActiveEditorFilePayload } from './activeEditorFile';

describe('isSameActiveEditorFilePayload', () => {
  it('returns true for identical payloads', () => {
    const payload = {
      filePath: '/workspace/src/app.ts',
      fileName: 'app.ts',
      relativePath: 'src/app.ts',
      fileSize: 42,
      selection: { startLine: 1, endLine: 2, text: 'hello' },
    };
    assert.equal(isSameActiveEditorFilePayload(payload, { ...payload }), true);
  });

  it('returns false when selection text differs', () => {
    const base = {
      filePath: '/workspace/src/app.ts',
      fileName: 'app.ts',
      relativePath: 'src/app.ts',
      fileSize: 42,
      selection: { startLine: 1, endLine: 2, text: 'hello' },
    };
    assert.equal(isSameActiveEditorFilePayload(base, {
      ...base,
      selection: { startLine: 1, endLine: 2, text: 'world' },
    }), false);
  });

  it('returns false when one payload is null', () => {
    assert.equal(isSameActiveEditorFilePayload(null, {
      filePath: '/a',
      fileName: 'a',
      relativePath: 'a',
      fileSize: null,
      selection: null,
    }), false);
  });
});
