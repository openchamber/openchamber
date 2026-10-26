import { describe, expect, test } from 'bun:test';

import type { AttachedFile } from '@/stores/types/sessionTypes';
import { createInputHistorySubmission, type InputHistoryAttachment, type InputHistoryEntry } from '@/stores/useInputHistoryStore';

import {
  buildChatInputHistorySubmissions,
  buildInputHistoryNavigatorIdentity,
  mapInputHistoryEntriesToValues,
  mergeSessionInputHistory,
} from './inputHistory';

const ATTACHMENT: AttachedFile = {
  id: 'file-1',
  file: new File(['hello'], 'notes.txt', { type: 'text/plain' }),
  dataUrl: 'file:///repo/notes.txt',
  mimeType: 'text/plain',
  filename: 'notes.txt',
  size: 5,
  source: 'local',
  serverPath: '/repo/notes.txt',
};

describe('buildChatInputHistorySubmissions', () => {
  test('keeps raw queued submissions first and raw composer submission last', () => {
    const submissions = buildChatInputHistorySubmissions({
      inputMode: 'normal',
      queuedMessages: [
        { content: '/queued one', attachments: [ATTACHMENT] },
        { content: '/queued two', attachments: [] },
      ],
      composerText: '/composer raw',
      composerAttachments: [ATTACHMENT],
      includeComposer: true,
    });

    expect(submissions?.map((submission) => submission.text)).toEqual([
      '/queued one',
      '/queued two',
      '/composer raw',
    ]);
    expect(submissions?.[0]).toEqual(createInputHistorySubmission('/queued one', [ATTACHMENT]));
    expect(submissions?.[2]).toEqual(createInputHistorySubmission('/composer raw', [ATTACHMENT]));
  });

  test('omits history submissions for shell mode', () => {
    expect(buildChatInputHistorySubmissions({
      inputMode: 'shell',
      queuedMessages: [{ content: 'echo hello', attachments: [ATTACHMENT] }],
      composerText: 'pwd',
      composerAttachments: [ATTACHMENT],
      includeComposer: true,
    })).toBe(undefined);
  });
});

describe('mapInputHistoryEntriesToValues', () => {
  test('keeps chronological order and materializes supported attachments', () => {
    const entries: InputHistoryEntry[] = [
      {
        text: 'oldest',
        attachmentKeys: ['a'],
        restorableAttachments: [{
          key: 'server-file',
          source: 'file-url',
          filename: 'server.txt',
          mimeType: 'text/plain',
          size: 11,
          reference: '/repo/server.txt',
        }],
        submittedAt: 1,
      },
      {
        text: 'newest',
        attachmentKeys: ['b'],
        restorableAttachments: [{
          key: 'vscode-file',
          source: 'vscode-file',
          filename: 'editor.ts',
          mimeType: 'text/plain',
          size: 22,
          reference: '/repo/editor.ts',
        }],
        submittedAt: 2,
      },
    ];

    const values = mapInputHistoryEntriesToValues(entries);

    expect(values.map((value) => value.text)).toEqual(['oldest', 'newest']);
    expect(values[0]?.attachments[0]?.filename).toBe('server.txt');
    expect(values[0]?.attachments[0]?.dataUrl).toBe('/repo/server.txt');
    expect(values[0]?.attachments[0]?.source).toBe('local');
    expect(values[1]?.attachments[0]?.filename).toBe('editor.ts');
    expect(values[1]?.attachments[0]?.vscodePath).toBe('/repo/editor.ts');
    expect(values[1]?.attachments[0]?.vscodeSource).toBe('file');
    expect(values[1]?.attachments[0]?.source).toBe('vscode');
  });

  test('drops unsupported attachment descriptors', () => {
    const unsupported: InputHistoryAttachment = {
      key: 'bad',
      source: 'file-url',
      filename: 'bad.txt',
      mimeType: 'text/plain',
      size: 1,
      reference: 'data:text/plain;base64,Zm9v',
    };
    const entries: InputHistoryEntry[] = [{
      text: 'value',
      attachmentKeys: ['bad'],
      restorableAttachments: [unsupported],
      submittedAt: 1,
    }];

    expect(mapInputHistoryEntriesToValues(entries)[0]?.attachments).toEqual([]);
  });
});

describe('buildInputHistoryNavigatorIdentity', () => {
  test('includes scope and full identity so bucket changes reset navigation', () => {
    expect(buildInputHistoryNavigatorIdentity('global', {
      runtimeKey: 'runtime-a',
      directory: '/repo',
      sessionId: 'session-1',
    })).toBe('global\nruntime-a\n/repo\nsession-1');

    expect(buildInputHistoryNavigatorIdentity('session', {
      runtimeKey: 'runtime-a',
      directory: '/repo',
      sessionId: 'session-1',
    })).toBe('session\nruntime-a\n/repo\nsession-1');
  });
});

describe('mergeSessionInputHistory', () => {
  const entry = (text: string, submittedAtMs: number): InputHistoryEntry => ({
    text,
    attachmentKeys: [],
    restorableAttachments: [],
    submittedAt: submittedAtMs * 1000,
  });

  test('recalls transcript prompts when nothing is persisted yet', () => {
    const values = mergeSessionInputHistory(
      [{ text: 'first', createdAt: 10 }, { text: 'second', createdAt: 20 }],
      [],
    );

    expect(values.map((value) => value.text)).toEqual(['first', 'second']);
    expect(values[0]?.attachments).toEqual([]);
  });

  test('interleaves persisted entries by time and collapses duplicates onto the persisted entry', () => {
    const persisted: InputHistoryEntry = {
      ...entry('second', 20),
      restorableAttachments: [{
        key: 'server-file',
        source: 'file-url',
        filename: 'server.txt',
        mimeType: 'text/plain',
        size: 11,
        reference: '/repo/server.txt',
      }],
    };
    const values = mergeSessionInputHistory(
      [{ text: 'first', createdAt: 10 }, { text: 'second', createdAt: 20 }, { text: 'fourth', createdAt: 40 }],
      [persisted, entry('reverted', 30)],
    );

    expect(values.map((value) => value.text)).toEqual(['first', 'second', 'reverted', 'fourth']);
    expect(values[1]?.attachments[0]?.filename).toBe('server.txt');
  });
});
