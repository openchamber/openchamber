import { describe, expect, test } from 'bun:test';
import { OPENCHAMBER_SDK_API_VERSION, OPENCHAMBER_SDK_CHANNEL, type FileEditorChange, type HostMessage } from '@openchamber/sdk';

import { createGuestFileChannel, GuestFileSnapshotError, type GuestFileMessage } from './file-editor-channel';

const envelope = { channel: OPENCHAMBER_SDK_CHANNEL, v: OPENCHAMBER_SDK_API_VERSION } as const;
const document = { path: 'docs/flow.excalidraw', name: 'flow.excalidraw', content: '{"elements":[]}', readOnly: false, encoding: 'text' } as const;

const setup = (timeoutMs?: number) => {
  const changes: FileEditorChange[] = [];
  const counts = { save: 0, unsupported: 0 };
  const channel = createGuestFileChannel(document, {
    onChange: (change) => changes.push(change),
    onSave: () => { counts.save += 1; },
    onUnsupported: () => { counts.unsupported += 1; },
  }, timeoutMs);
  const posted: HostMessage[] = [];
  return { channel, changes, counts, posted, post: (message: HostMessage) => { posted.push(message); } };
};

// The channel rejects only with GuestFileSnapshotError; a resolve is a test failure.
const rejection = <T,>(promise: Promise<T>) => promise.then(() => null, (reason: GuestFileSnapshotError) => reason);

const snapshotId = (message: HostMessage | undefined): string => {
  if (message?.type !== 'file-snapshot') throw new Error('expected a snapshot request');
  return message.id;
};

describe('createGuestFileChannel', () => {
  test('hands the file over on every connect', () => {
    const { channel, posted, post } = setup();
    channel.connect(post);
    channel.connect(post);
    expect(posted).toEqual([
      { ...envelope, type: 'file-open', payload: document },
      { ...envelope, type: 'file-open', payload: document },
    ]);
  });

  test('a snapshot request resolves with the matching answer and ignores stray ids', async () => {
    const { channel, posted, post } = setup();
    channel.connect(post);
    const pending = channel.requestSnapshot('save');
    const id = snapshotId(posted.at(-1));
    expect(posted.at(-1)).toMatchObject({ type: 'file-snapshot', payload: { purpose: 'save' } });
    channel.receive({ ...envelope, type: 'file-snapshot-result', id: 'someone-else', payload: { error: 'no' } });
    channel.receive({ ...envelope, type: 'file-snapshot-result', id, payload: { snapshot: { content: '{}', version: 'v2' } } });
    expect(await pending).toEqual({ content: '{}', version: 'v2' });
  });

  test('a refusal, a timeout, and a lost frame all reject instead of resolving empty', async () => {
    const { channel, posted, post } = setup(10);
    expect(await rejection(channel.requestSnapshot('save'))).toMatchObject({ reason: 'disconnected' });

    channel.connect(post);
    const refused = channel.requestSnapshot('handoff');
    channel.receive({ ...envelope, type: 'file-snapshot-result', id: snapshotId(posted.at(-1)), payload: { error: 'Scene is not ready.' } });
    expect(await rejection(refused)).toMatchObject({ reason: 'refused', message: 'Scene is not ready.' });

    expect(await rejection(channel.requestSnapshot('save'))).toMatchObject({ reason: 'timeout' });

    const lost = channel.requestSnapshot('save');
    channel.disconnect();
    const error = await rejection(lost);
    expect(error).toBeInstanceOf(GuestFileSnapshotError);
    expect(error).toMatchObject({ reason: 'disconnected' });
  });

  test('routes notices and reports saved versions only while connected', () => {
    const { channel, changes, counts, posted, post } = setup();
    const notices: GuestFileMessage[] = [
      { ...envelope, type: 'file-change', payload: { dirty: true, edited: true } },
      { ...envelope, type: 'file-save' },
      { ...envelope, type: 'file-unsupported' },
    ];
    for (const notice of notices) channel.receive(notice);
    expect(changes).toEqual([{ dirty: true, edited: true }]);
    expect(counts).toEqual({ save: 1, unsupported: 1 });

    channel.markSaved('v1');
    expect(posted).toEqual([]);
    channel.connect(post);
    channel.markSaved('v1');
    expect(posted.at(-1)).toEqual({ ...envelope, type: 'file-saved', payload: { version: 'v1' } });
  });
});
