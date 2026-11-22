import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createChangeFilter, createDeviceSettingsReporter, readDeviceSettings } from './deviceSettingsReport';
import { useUIStore } from '@/stores/useUIStore';

let hold = false;
const harness = (accept = () => true) => {
  let values = { sidebarWidth: 280 };
  const timers = new Map<number, () => void>();
  let nextHandle = 0;
  const sent: Array<{ deviceId: string; values: { sidebarWidth: number }; closing: boolean; revision: number }> = [];
  let release: (() => void) | null = null;
  const reporter = createDeviceSettingsReporter({
    read: () => values,
    send: async (report, closing) => {
      sent.push({ ...report, closing });
      if (hold) await new Promise<void>((resolve) => { release = resolve; });
      return accept();
    },
    deviceId: 'device-aaaa',
    surface: 'web',
    schedule: (callback) => { nextHandle += 1; timers.set(nextHandle, callback); return nextHandle; },
    cancel: (handle) => { timers.delete(handle); },
  });
  const tick = async () => { const pending = [...timers.values()]; timers.clear(); for (const run of pending) run(); await Promise.resolve(); await Promise.resolve(); };
  return { reporter, sent, tick, set: (next: number) => { values = { sidebarWidth: next }; }, release: () => release?.() };
};

describe('device settings reporter', () => {
  test('sends once after a burst of changes, then only when something changed', async () => {
    const { reporter, sent, tick, set } = harness();
    reporter.request(); set(300); reporter.request(); set(320); reporter.request();
    await tick();
    expect(sent.map((report) => report.values.sidebarWidth)).toEqual([320]);

    reporter.request();
    await tick();
    expect(sent).toHaveLength(1);

    set(340); reporter.request();
    await tick();
    expect(sent.map((report) => report.values.sidebarWidth)).toEqual([320, 340]);
    expect(sent[0]).toMatchObject({ deviceId: 'device-aaaa', surface: 'web' });
  });

  test('sends again after the server refused a report', async () => {
    let accept = false;
    const { reporter, sent, tick } = harness(() => accept);
    reporter.request();
    await tick();
    accept = true;
    reporter.request();
    await tick();
    expect(sent).toHaveLength(2);
  });

  test('tells a newly connected server even when nothing changed', async () => {
    const { reporter, sent, tick } = harness();
    reporter.request();
    await tick();
    reporter.forget();
    reporter.request();
    await tick();
    expect(sent).toHaveLength(2);
  });
});

describe('device settings reporter, closing and switching', () => {
  test('a closing window sends a pending change at once, marked to outlive the page', async () => {
    const { reporter, sent, set } = harness();
    set(300); reporter.request();
    await reporter.flush(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ values: { sidebarWidth: 300 }, closing: true });
  });

  test('a later report waits for the one still in flight, so the server ends on the newest', async () => {
    hold = true;
    try {
      const { reporter, sent, set, release } = harness();
      set(300);
      const first = reporter.flush();
      await Promise.resolve();
      set(320);
      const second = reporter.flush();
      await Promise.resolve();
      expect(sent.map((report) => report.values.sidebarWidth)).toEqual([300]);
      hold = false;
      release();
      await first;
      await second;
      expect(sent.map((report) => report.values.sidebarWidth)).toEqual([300, 320]);
    } finally {
      hold = false;
    }
  });

  test('a closing report that lands first stays delivered when the older in-flight send lands after it', async () => {
    let values = { sidebarWidth: 300 };
    const sent: Array<{ values: { sidebarWidth: number }; closing: boolean }> = [];
    const finish: Array<(took: boolean) => void> = [];
    const reporter = createDeviceSettingsReporter({
      read: () => values,
      send: (report, closing) => {
        sent.push({ values: report.values, closing });
        return new Promise<boolean>((resolve) => { finish.push(resolve); });
      },
      deviceId: 'device-aaaa',
      surface: 'web',
      schedule: () => 1,
      cancel: () => undefined,
    });
    const first = reporter.flush();
    await Promise.resolve();
    await Promise.resolve();
    values = { sidebarWidth: 320 };
    const closing = reporter.flush(true);
    // The closing send goes out at once; it does not wait for the first.
    expect(sent.map((report) => report.values.sidebarWidth)).toEqual([300, 320]);
    expect(sent[1].closing).toBe(true);
    // The closing (newer) report lands first, the older one second.
    finish[1](true);
    await closing;
    finish[0](true);
    await first;
    // The newest snapshot is the delivered one: a further flush sends nothing.
    const again = reporter.flush();
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toHaveLength(2);
    finish[2]?.(true);
    await again;
  });

  test('a refused closing report does not count as delivered — the newer snapshot is sent again', async () => {
    let values = { sidebarWidth: 300 };
    const sent: Array<{ values: { sidebarWidth: number }; closing: boolean }> = [];
    const finish: Array<(took: boolean) => void> = [];
    const reporter = createDeviceSettingsReporter({
      read: () => values,
      send: (report, closing) => {
        sent.push({ values: report.values, closing });
        return new Promise<boolean>((resolve) => { finish.push(resolve); });
      },
      deviceId: 'device-aaaa',
      surface: 'web',
      schedule: () => 1,
      cancel: () => undefined,
    });
    const first = reporter.flush();
    await Promise.resolve();
    await Promise.resolve();
    values = { sidebarWidth: 320 };
    const closing = reporter.flush(true);
    expect(sent.map((report) => report.values.sidebarWidth)).toEqual([300, 320]);
    // The closing (newer) report is refused; the older in-flight one is taken.
    finish[1](false);
    await closing;
    finish[0](true);
    await first;
    // The delivered record is the older snapshot, so the newer one goes again.
    const again = reporter.flush();
    await Promise.resolve();
    await Promise.resolve();
    expect(sent.map((report) => report.values.sidebarWidth)).toEqual([300, 320, 320]);
    finish[2](true);
    await again;
    // Now the newest snapshot is delivered: a further flush sends nothing.
    const last = reporter.flush();
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toHaveLength(3);
    await last;
  });

  test('a send to the previous server that never answers does not hold up the new one', async () => {
    hold = true;
    try {
      const { reporter, sent } = harness();
      void reporter.flush();
      await Promise.resolve();
      hold = false;
      reporter.forget();
      await reporter.flush();
      expect(sent).toHaveLength(2);
    } finally {
      hold = false;
    }
  });

  test('every send carries a larger revision', async () => {
    const { reporter, sent, set } = harness();
    await reporter.flush();
    set(300);
    await reporter.flush();
    expect(sent[1].revision).toBeGreaterThan(sent[0].revision);
  });

  test('a reply from the previous server does not count for the new one', async () => {
    hold = true;
    try {
      const { reporter, sent, tick, release } = harness();
      const pending = reporter.flush();
      await Promise.resolve();
      reporter.forget();
      hold = false;
      release();
      await pending;
      hold = false;
      reporter.request();
      await tick();
      expect(sent).toHaveLength(2);
    } finally {
      hold = false;
    }
  });
});

// The server keeps only its own list of reportable keys
// (packages/web/server/lib/device-settings/store.js); a key the UI sends that
// the server drops, or the other way round, would go unnoticed without this.
test('the keys this window reports are the keys the server keeps', () => {
  const store = readFileSync(new URL('../../../../web/server/lib/device-settings/store.js', import.meta.url), 'utf8');
  const block = store.slice(store.indexOf('const REPORTABLE = {'), store.indexOf('};', store.indexOf('const REPORTABLE = {')));
  const serverKeys = [...block.matchAll(/^ {2}([A-Za-z]+):/gm)].map((match) => match[1]).sort();
  expect(serverKeys.length).toBeGreaterThan(20);
  expect(Object.keys(readDeviceSettings(useUIStore.getState())).sort()).toEqual(serverKeys);
});

test('the change filter passes only a reported value that actually changed', () => {
  const changed = createChangeFilter({ sidebarWidth: 280 });
  expect(changed({ sidebarWidth: 280 })).toBe(false);
  expect(changed({ sidebarWidth: 300 })).toBe(true);
  expect(changed({ sidebarWidth: 300 })).toBe(false);
});
