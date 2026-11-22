import fsReal from 'node:fs/promises';
import os from 'node:os';
import pathReal from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPushRuntime } from './push-runtime.js';

const createRuntime = () => createPushRuntime({
  fsPromises: {
    mkdir: vi.fn(async () => {}),
    readFile: vi.fn(async () => JSON.stringify({ version: 1, subscriptionsBySession: {} })),
    writeFile: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    rm: vi.fn(async () => {}),
  },
  path: { dirname: () => '/tmp' },
  loadWebPush: async () => ({
    generateVAPIDKeys: vi.fn(() => ({ publicKey: 'public', privateKey: 'private' })),
    sendNotification: vi.fn(async () => {}),
    setVapidDetails: vi.fn(),
  }),
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

  it('treats only mobile platforms as non-interactive for isAnyInteractiveClientVisible', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const runtime = createRuntime();

    // Only the phone (foreground) is connected → no interactive client to absorb the notification.
    runtime.updateUiVisibility('phone', true, 'ios');
    expect(runtime.isAnyUiVisible()).toBe(true);
    expect(runtime.isAnyInteractiveClientVisible()).toBe(false);

    // A visible desktop counts as interactive → suppress mobile push.
    runtime.updateUiVisibility('desktop', true, 'desktop');
    expect(runtime.isAnyInteractiveClientVisible()).toBe(true);

    // Desktop hidden again → back to mobile-only, push should flow to the phone.
    runtime.updateUiVisibility('desktop', false, 'desktop');
    expect(runtime.isAnyInteractiveClientVisible()).toBe(false);

    // A client that never reported a platform is treated as interactive (conservative).
    runtime.updateUiVisibility('legacy', true);
    expect(runtime.isAnyInteractiveClientVisible()).toBe(true);
  });

  it('remembers the last platform when a heartbeat omits it', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const runtime = createRuntime();
    runtime.updateUiVisibility('phone', true, 'android');
    runtime.updateUiVisibility('phone', true); // heartbeat without platform
    expect(runtime.isAnyInteractiveClientVisible()).toBe(false);
  });
});

describe('push runtime store durability', () => {
  const temporaryDirectories = [];

  const makeRealRuntime = async (fsOverrides = {}) => {
    const dir = await fsReal.mkdtemp(pathReal.join(os.tmpdir(), 'openchamber-push-store-'));
    temporaryDirectories.push(dir);
    const filePath = pathReal.join(dir, 'push-subscriptions.json');
    const runtime = createPushRuntime({
      fsPromises: { ...fsReal, ...fsOverrides },
      path: pathReal,
      loadWebPush: async () => ({
        generateVAPIDKeys: vi.fn(() => ({ publicKey: 'public', privateKey: 'private' })),
        sendNotification: vi.fn(async () => {}),
        setVapidDetails: vi.fn(),
      }),
      PUSH_SUBSCRIPTIONS_FILE_PATH: filePath,
      readSettingsFromDiskMigrated: vi.fn(async () => ({})),
      writeSettingsToDisk: vi.fn(async () => {}),
    });
    runtime.setPushInitialized(true);
    return { dir, filePath, runtime };
  };

  const subscription = { endpoint: 'https://push.example/1', p256dh: 'p256dh', auth: 'auth' };

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((dir) => fsReal.rm(dir, { recursive: true, force: true })));
  });

  it('preserves a corrupt subscriptions file before a later write overwrites it', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { dir, filePath, runtime } = await makeRealRuntime();
      const corrupt = '{"version":1,"subscriptionsBySession":{"s1":[{"endpoint":"https://push.exa';
      await fsReal.writeFile(filePath, corrupt, 'utf8');

      await runtime.addOrUpdatePushSubscription('session-1', subscription);

      const preserved = (await fsReal.readdir(dir)).filter((name) => name.includes('.corrupt-'));
      expect(preserved).toHaveLength(1);
      expect(await fsReal.readFile(pathReal.join(dir, preserved[0]), 'utf8')).toBe(corrupt);
      const warnText = warnSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
      expect(warnText).toContain(preserved[0]);
      const stored = JSON.parse(await fsReal.readFile(filePath, 'utf8'));
      expect(stored.version).toBe(1);
      expect(Object.values(stored.subscriptionsBySession).flat()).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('preserves a wrong-version subscriptions file before a later write overwrites it', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { dir, filePath, runtime } = await makeRealRuntime();
      const wrongVersion = JSON.stringify({ version: 2, subscriptionsBySession: {} });
      await fsReal.writeFile(filePath, wrongVersion, 'utf8');

      await runtime.addOrUpdatePushSubscription('session-1', subscription);

      const preserved = (await fsReal.readdir(dir)).filter((name) => name.includes('.corrupt-'));
      expect(preserved).toHaveLength(1);
      expect(await fsReal.readFile(pathReal.join(dir, preserved[0]), 'utf8')).toBe(wrongVersion);
      const stored = JSON.parse(await fsReal.readFile(filePath, 'utf8'));
      expect(stored.version).toBe(1);
      expect(Object.values(stored.subscriptionsBySession).flat()).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not preserve an empty subscriptions file; a later write just replaces it', async () => {
    const { dir, filePath, runtime } = await makeRealRuntime();
    await fsReal.writeFile(filePath, '', 'utf8');

    await runtime.addOrUpdatePushSubscription('session-1', subscription);

    expect((await fsReal.readdir(dir)).filter((name) => name.includes('.corrupt-'))).toEqual([]);
    const stored = JSON.parse(await fsReal.readFile(filePath, 'utf8'));
    expect(Object.values(stored.subscriptionsBySession).flat()).toHaveLength(1);
  });

  it('keeps the persist queue usable after a preservation failure', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let failCorruptRename = true;
      const { filePath, runtime } = await makeRealRuntime({
        rename: async (from, to) => {
          if (failCorruptRename && String(to).includes('.corrupt-')) throw new Error('rename failed');
          return fsReal.rename(from, to);
        },
      });
      await fsReal.writeFile(filePath, '{"version":1,"subscriptionsBySession":{"s1":[', 'utf8');

      // The mutation that hits the unpreservable corrupt file rejects.
      await expect(runtime.addOrUpdatePushSubscription('session-1', subscription)).rejects.toThrow('Failed to preserve');

      // Once the store is valid again, the next mutation must actually
      // run: chaining it onto the rejected lock would return the same
      // preservation error forever (Codex, PR #890).
      await fsReal.writeFile(filePath, JSON.stringify({ version: 1, subscriptionsBySession: {} }), 'utf8');
      failCorruptRename = false;
      await runtime.addOrUpdatePushSubscription('session-2', subscription);

      const stored = JSON.parse(await fsReal.readFile(filePath, 'utf8'));
      expect(Object.values(stored.subscriptionsBySession).flat()).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('treats a missing subscriptions file as an empty store, silently', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { dir, runtime } = await makeRealRuntime();
      await runtime.addOrUpdatePushSubscription('session-1', subscription);
      expect(warnSpy).not.toHaveBeenCalled();
      expect((await fsReal.readdir(dir)).filter((name) => name.includes('.corrupt-'))).toEqual([]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('writes via a temp file renamed into place, and a failed rename leaves the previous file intact', async () => {
    const writeTargets = [];
    const renameCalls = [];
    const recording = {
      writeFile: async (target, ...rest) => {
        writeTargets.push(String(target));
        return fsReal.writeFile(target, ...rest);
      },
      rename: async (from, to) => {
        renameCalls.push([String(from), String(to)]);
        return fsReal.rename(from, to);
      },
    };
    const { dir, filePath, runtime } = await makeRealRuntime(recording);
    await runtime.addOrUpdatePushSubscription('session-1', subscription);
    expect(writeTargets.length).toBeGreaterThan(0);
    expect(writeTargets).not.toContain(filePath);
    expect(writeTargets.every((target) => target.startsWith(`${filePath}.tmp-`))).toBe(true);
    expect(renameCalls).toEqual(writeTargets.map((target) => [target, filePath]));
    expect(await fsReal.readdir(dir)).toEqual(['push-subscriptions.json']);

    const before = await fsReal.readFile(filePath, 'utf8');
    const failing = await makeRealRuntime({
      rename: async () => {
        throw new Error('rename failed');
      },
    });
    // A failed write must surface, leave no temp file behind, and not
    // disturb the valid store the first runtime wrote.
    await expect(failing.runtime.addOrUpdatePushSubscription('session-1', subscription)).rejects.toThrow('rename failed');
    expect(await fsReal.readdir(failing.dir)).toEqual([]);
    expect(await fsReal.readFile(filePath, 'utf8')).toBe(before);
  });
});

describe('push runtime VAPID subject loopback judgement', () => {
  const savedOrigin = process.env.OPENCHAMBER_PUBLIC_ORIGIN;
  const savedSubject = process.env.OPENCHAMBER_VAPID_SUBJECT;

  afterEach(() => {
    if (savedOrigin === undefined) delete process.env.OPENCHAMBER_PUBLIC_ORIGIN;
    else process.env.OPENCHAMBER_PUBLIC_ORIGIN = savedOrigin;
    if (savedSubject === undefined) delete process.env.OPENCHAMBER_VAPID_SUBJECT;
    else process.env.OPENCHAMBER_VAPID_SUBJECT = savedSubject;
  });

  const subjectForOrigin = async (origin) => {
    delete process.env.OPENCHAMBER_VAPID_SUBJECT;
    process.env.OPENCHAMBER_PUBLIC_ORIGIN = origin;
    const setVapidDetails = vi.fn();
    const runtime = createPushRuntime({
      fsPromises: {
        mkdir: vi.fn(async () => {}),
        readFile: vi.fn(async () => JSON.stringify({ version: 1, subscriptionsBySession: {} })),
        writeFile: vi.fn(async () => {}),
        rename: vi.fn(async () => {}),
        rm: vi.fn(async () => {}),
      },
      path: { dirname: () => '/tmp' },
      loadWebPush: async () => ({
        generateVAPIDKeys: vi.fn(() => ({ publicKey: 'public', privateKey: 'private' })),
        sendNotification: vi.fn(async () => {}),
        setVapidDetails,
      }),
      PUSH_SUBSCRIPTIONS_FILE_PATH: '/tmp/push-subscriptions.json',
      readSettingsFromDiskMigrated: vi.fn(async () => ({})),
      writeSettingsToDisk: vi.fn(async () => {}),
    });
    await runtime.ensurePushInitialized();
    expect(setVapidDetails).toHaveBeenCalledOnce();
    return setVapidDetails.mock.calls[0][0];
  };

  it('keeps public origins that merely start with a loopback prefix', async () => {
    for (const origin of ['http://localhost.evil.example:3000', 'http://localhost@evil.example', 'http://127.0.0.1.evil.example']) {
      expect(await subjectForOrigin(origin), origin).toBe(origin);
    }
    expect(await subjectForOrigin('https://chamber.example.com')).toBe('https://chamber.example.com');
  });

  it('swaps genuine loopback origins for the mailto subject', async () => {
    for (const origin of ['http://localhost:3000', 'http://127.0.0.2:3000', 'http://[::1]:3000']) {
      expect(await subjectForOrigin(origin), origin).toBe('mailto:openchamber@localhost');
    }
  });
});
