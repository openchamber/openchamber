import { describe, expect, test } from 'bun:test';

import { parseNotificationChannelsJson } from './channels.ts';

describe('parseNotificationChannelsJson', () => {
  const channel = {
    providerId: 'ext-slack-bridge', guestId: 'slack-bridge', name: 'Slack Bridge',
    channel: { label: 'Slack', instances: { kind: 'fixed', origin: 'https://slack.com' }, token: { scheme: 'bearer', username: false, scopes: ['chat:write'] } },
    account: { instance: 'https://slack.com', account: { id: 'U1', login: 'mona', name: 'Mona', connectedAt: 1, status: 'valid' } },
  };

  test('reads the server\'s list one row at a time and never a token', () => {
    const parsed = parseNotificationChannelsJson(JSON.stringify({ channels: [channel, { ...channel, providerId: 'ext-matrix', account: null }, { providerId: 'broken' }] }));
    expect(parsed?.map((entry) => entry.providerId)).toEqual(['ext-slack-bridge', 'ext-matrix']);
    expect(parsed?.[0].account?.account).toEqual({ id: 'U1', login: 'mona', name: 'Mona', connectedAt: 1, status: 'valid' });
    expect(parsed?.[1].account).toBeNull();
  });

  test('a body without a list is a failure, not an empty list', () => {
    expect(parseNotificationChannelsJson('{}')).toBeNull();
    expect(parseNotificationChannelsJson('null')).toBeNull();
    expect(parseNotificationChannelsJson('not json')).toBeNull();
    expect(parseNotificationChannelsJson('{"channels":[]}')).toEqual([]);
  });
});
