import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPushRuntime } from './push-runtime.js';

const createRuntime = () => createPushRuntime({
  fsPromises: {
    mkdir: vi.fn(async () => {}),
    readFile: vi.fn(async () => JSON.stringify({ version: 1, subscriptionsBySession: {} })),
    writeFile: vi.fn(async () => {}),
  },
  path: { dirname: () => '/tmp' },
  webPush: {
    generateVAPIDKeys: vi.fn(() => ({ publicKey: 'public', privateKey: 'private' })),
    sendNotification: vi.fn(async () => {}),
    setVapidDetails: vi.fn(),
  },
  PUSH_SUBSCRIPTIONS_FILE_PATH: '/tmp/push-subscriptions.json',
  readSettingsFromDiskMigrated: vi.fn(async () => ({})),
  writeSettingsToDisk: vi.fn(async () => {}),
});

afterEach(() => {
  vi.useRealTimers();
});

describe('push runtime visibility tracking', () => {
  it('keeps visible UI state when another client reports hidden', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const runtime = createRuntime();

    runtime.updateUiVisibility('visible-client', true);
    runtime.updateUiVisibility('hidden-client', false);

    expect(runtime.isAnyUiVisible()).toBe(true);
    expect(runtime.isUiVisible('visible-client')).toBe(true);
    expect(runtime.isUiVisible('hidden-client')).toBe(false);

    vi.advanceTimersByTime(30_001);

    expect(runtime.isAnyUiVisible()).toBe(false);
    expect(runtime.isUiVisible('visible-client')).toBe(false);
  });
});
