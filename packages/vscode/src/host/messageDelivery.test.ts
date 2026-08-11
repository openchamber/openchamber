import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MessageDelivery } from './messageDelivery';

describe('MessageDelivery', () => {
  it('confirm clears pending so retries are not scheduled', async () => {
    let postCount = 0;
    let capturedMsgId: string | undefined;

    const delivery = new MessageDelivery(() => ({
      postMessage: async (message: { _msgId?: string }) => {
        postCount += 1;
        capturedMsgId = message._msgId;
        return true;
      },
    } as unknown as import('vscode').Webview));

    const sent = await delivery.send({ id: '1', type: 'test', success: true });
    assert.equal(sent, true);
    assert.equal(postCount, 1);
    assert.ok(capturedMsgId);

    delivery.confirm(capturedMsgId!);

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(postCount, 1);
  });
});
