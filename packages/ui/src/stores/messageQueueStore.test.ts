import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { InlineCommentPartPayload } from '@/lib/messages/inlineComments';

mock.module('@/lib/persistence', () => ({
  updateDesktopSettings: () => {},
}));

const { useMessageQueueStore } = await import('./messageQueueStore');

const commentPart = (): InlineCommentPartPayload => ({
  text: 'The user made the following comment regarding line 1 of a.ts: note',
  synthetic: true,
  metadata: {
    opencodeComment: {
      path: 'a.ts',
      selection: { startLine: 1, endLine: 1, startChar: 0, endChar: 0 },
      comment: 'note',
      preview: 'const x = 1',
      origin: 'file',
    },
  },
});

describe('messageQueueStore.addToQueue', () => {
  beforeEach(() => {
    useMessageQueueStore.getState().clearAllQueues();
  });

  test('preserves inlineCommentParts captured at queue time', () => {
    const parts = [commentPart()];
    useMessageQueueStore.getState().addToQueue('ses_1', { content: 'hi', inlineCommentParts: parts });

    const queue = useMessageQueueStore.getState().getQueueForSession('ses_1');
    expect(queue).toHaveLength(1);
    expect(queue[0]?.inlineCommentParts).toEqual(parts);
  });

  test('queues messages without comments as undefined', () => {
    useMessageQueueStore.getState().addToQueue('ses_2', { content: 'hi' });

    const queue = useMessageQueueStore.getState().getQueueForSession('ses_2');
    expect(queue[0]?.inlineCommentParts).toBe(undefined);
  });
});
