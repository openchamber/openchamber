import { expect, test } from 'bun:test';

import { OPENCHAMBER_SDK_CHANNEL } from './api-version.ts';
import { createLoopbackFixture } from './loopback-fixture.test.ts';

test('unsubscribes project file watches when the host client is disposed', async () => {
  // Given an acknowledged watch that the caller has not stopped.
  const fixture = createLoopbackFixture();
  try {
    const watching = fixture.host.watchFiles(['plans/current.md'], () => {});
    const call = fixture.posted.at(-1);
    if (call?.type !== 'files-watch') throw new Error('Expected file watch');
    fixture.send({ channel: OPENCHAMBER_SDK_CHANNEL, v: 1, type: 'result', id: call.id, ok: true });
    const stop = await watching;

    // When the frame's client ends before its caller unsubscribes.
    fixture.host.dispose();
    stop();

    // Then the host receives exactly one release for that subscription.
    const releases = fixture.posted.filter((message) => message.type === 'files-unwatch');
    expect(releases.map((message) => message.payload.subscriptionId)).toEqual([call.payload.subscriptionId]);
  } finally {
    fixture.host.dispose();
  }
});

test('drops a watch listener when the host refuses its subscription', async () => {
  // Given a subscription whose server cannot watch the requested file.
  const fixture = createLoopbackFixture();
  const changes: string[][] = [];
  try {
    const watching = fixture.host.watchFiles(['plans/current.md'], (paths) => changes.push(paths));
    const call = fixture.posted.at(-1);
    if (call?.type !== 'files-watch') throw new Error('Expected file watch');

    // When the refusal and a stale change arrive for that subscription.
    fixture.send({ channel: OPENCHAMBER_SDK_CHANNEL, v: 1, type: 'result', id: call.id, ok: false,
      code: 'UNSUPPORTED', error: 'Watching unavailable.' });
    await expect(watching).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    fixture.send({ channel: OPENCHAMBER_SDK_CHANNEL, v: 1, type: 'files-changed',
      payload: { subscriptionId: call.payload.subscriptionId, paths: ['plans/current.md'] } });

    // Then the refused watch delivers no file changes.
    expect(changes).toEqual([]);
  } finally {
    fixture.host.dispose();
  }
});
