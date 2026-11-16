import { describe, expect, test } from 'bun:test';
import { shareAnswerToastFor } from './share-answer-toast';

describe('shared page answer toast', () => {
  test('shows the answer with a way into its session', () => {
    expect(shareAnswerToastFor({
      kind: 'share-answer',
      title: 'Yulia answered “Schema”',
      body: 'Picked B',
      tag: 'share-ses_1',
      sessionId: 'ses_1',
      directory: '/repo',
    })).toEqual({
      title: 'Yulia answered “Schema”',
      id: 'share-ses_1',
      description: 'Picked B',
      session: { sessionId: 'ses_1', directory: '/repo' },
    });
  });

  test('offers no Open without the session folder, and an empty body is no description', () => {
    expect(shareAnswerToastFor({ kind: 'share-answer', title: 'T', body: '  ', sessionId: 'ses_1' }))
      .toMatchObject({ description: undefined, session: null });
  });

  test('leaves every other notification alone', () => {
    expect(shareAnswerToastFor({ kind: 'ready', title: 'Done' })).toBeNull();
    expect(shareAnswerToastFor({ kind: 'share-answer', title: ' ' })).toBeNull();
  });
});
