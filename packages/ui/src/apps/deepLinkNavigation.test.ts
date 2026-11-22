import { expect, test } from 'bun:test';

import type { DeepLinkIntent } from './deepLinks';
import { createDeepLinkQueue, notificationTapIntent, type NotificationTapData } from './deepLinkNavigation';
import type { SavedInstanceSwitchOutcome } from './mobileConnections';

test('a notification names its session and the server that sent it', () => {
  expect(notificationTapIntent({ serverId: 'srv-b', sessionId: 'ses-b' })).toEqual({ type: 'session', sessionId: 'ses-b', serverId: 'srv-b' });
  expect(notificationTapIntent({ sessionId: 'ses-old' })).toEqual({ type: 'session', sessionId: 'ses-old' });
  expect(notificationTapIntent({})).toBeNull();
});

test('a notification tap switches once, waits for the new runtime, then opens its session', async () => {
  const opened: string[] = [];
  const queue = createDeepLinkQueue<DeepLinkIntent>((intent) => {
    if (intent.type === 'session') opened.push(intent.sessionId);
    return true;
  });
  const switchCalls: string[] = [];
  let active = 'srv-a';
  const switchToServer = async (serverId: string): Promise<SavedInstanceSwitchOutcome> => {
    switchCalls.push(serverId);
    if (serverId === active) return 'active';
    if (serverId === 'srv-b') {
      active = serverId;
      return 'switched';
    }
    return 'unavailable';
  };
  const tap = (data: NotificationTapData) => {
    const intent = notificationTapIntent(data);
    if (!intent) throw new Error('no intent');
    return queue.apply(intent);
  };

  await queue.setReady(true, switchToServer);
  await tap({ serverId: 'srv-a', sessionId: 'ses-a' });
  expect(switchCalls).toEqual(['srv-a']);
  expect(opened).toEqual(['ses-a']);

  await tap({ serverId: 'srv-b', sessionId: 'ses-b' });
  expect(switchCalls).toEqual(['srv-a', 'srv-b']);
  expect(opened).toEqual(['ses-a']);

  await queue.setReady(false, switchToServer);
  await queue.setReady(true, switchToServer);
  expect(switchCalls).toEqual(['srv-a', 'srv-b', 'srv-b']);
  expect(opened).toEqual(['ses-a', 'ses-b']);

  await tap({ serverId: 'srv-gone', sessionId: 'ses-gone' });
  expect(opened).toEqual(['ses-a', 'ses-b']);
});

test('a tap on a cold start connects its own server instead of waiting for the last one', async () => {
  const opened: string[] = [];
  const queue = createDeepLinkQueue<DeepLinkIntent>((intent) => {
    if (intent.type === 'session') opened.push(intent.sessionId);
    return true;
  });
  const switchCalls: string[] = [];
  const switchToServer = async (serverId: string): Promise<SavedInstanceSwitchOutcome> => {
    switchCalls.push(serverId);
    return switchCalls.length === 1 ? 'switched' : 'active';
  };

  await queue.setReady(false, switchToServer);
  const intent = notificationTapIntent({ serverId: 'srv-b', sessionId: 'ses-b' });
  if (!intent) throw new Error('no intent');
  await queue.apply(intent);
  expect(switchCalls).toEqual(['srv-b']);
  expect(opened).toEqual([]);

  await queue.setReady(true, switchToServer);
  expect(opened).toEqual(['ses-b']);
});
