import { describe, expect, test } from 'bun:test';

import type { JsonValue } from '@/lib/opencode/model';
import { createShareSubmitter, viewerMessageSchema, type ShareSubmitMessage, type ViewerMessage } from './protocol';

/** The `ui` page's side of the viewer's frame protocol, as the renderer bundle runs it. */

const setup = () => {
  const sent: ShareSubmitMessage[] = [];
  let deliver: (message: ViewerMessage) => void = () => undefined;
  const inits: ViewerMessage[] = [];
  const submit = createShareSubmitter({
    post: (message) => { sent.push(message); },
    listen: (handler) => { deliver = handler; },
    onInit: (init) => inits.push(init),
  });
  // What the page hears goes through the schema first, as in the entry.
  const fromViewer = (data: JsonValue) => {
    const message = viewerMessageSchema.safeParse(data);
    if (message.success) deliver(message.data);
  };
  return { sent, inits, submit, fromViewer };
};

const settled = (promise: Promise<void>) => promise.then(() => 'resolved', (error: Error) => `rejected: ${error.message}`);

describe('the shared page submitter', () => {
  test('posts one answer as the viewer reads it and settles on its reply', async () => {
    const { sent, inits, submit, fromViewer } = setup();
    fromViewer({ source: 'openchamber-share-viewer', type: 'init', wantsAnswer: true, locale: 'uk' });
    expect(inits).toEqual([{ source: 'openchamber-share-viewer', type: 'init', wantsAnswer: true, locale: 'uk' }]);
    const answer = settled(submit({ value: 'b', fields: { when: '2026-11-20' } }, ' B · Friday '));
    expect(sent).toEqual([{ source: 'openchamber-share-document', type: 'submit', data: { value: 'b', fields: { when: '2026-11-20' } }, summary: 'B · Friday' }]);
    expect(await settled(submit({}, 'again'))).toBe('rejected: An answer is already on its way');
    fromViewer({ source: 'openchamber-share-viewer', type: 'submit-result', ok: true });
    expect(await answer).toBe('resolved');
    expect(await settled(submit({}, 'again'))).toBe('rejected: The answer was already sent');
  });

  test('passes the viewer\'s refusal on, and refuses what the viewer would', async () => {
    const page = setup();
    const answer = settled(page.submit({}, 'Yes'));
    page.fromViewer({ source: 'not-the-viewer', type: 'submit-result', ok: true });
    page.fromViewer({ source: 'openchamber-share-viewer', type: 'submit-result', ok: false, error: 'This link has expired' });
    expect(await answer).toBe('rejected: This link has expired');

    const quiet = setup();
    quiet.fromViewer({ source: 'openchamber-share-viewer', type: 'init', wantsAnswer: false, locale: null });
    expect(await settled(quiet.submit({}, 'Yes'))).toBe('rejected: This page does not take an answer');
    expect(await settled(setup().submit({}, '  '))).toBe('rejected: summary is required: the choice in a few words');
    expect(quiet.sent).toEqual([]);
  });
});
