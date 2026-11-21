import assert from 'node:assert/strict';
import test from 'node:test';

import { createIdleUpdateQueue } from './idle-update.mjs';
import { IDLE_UPDATE_LOCALES, idleUpdateDictionaries, idleUpdateWindowHtml } from './idle-update-locales.mjs';

const harness = ({ install, readIdle } = {}) => {
  const timers = [];
  let nextId = 1;
  const events = [];
  let status = { state: 'idle', reason: null };
  const queue = createIdleUpdateQueue({
    readIdle: readIdle ?? (async () => status),
    countdownMs: 1_000,
    pollMs: 5_000,
    setTimer: (fn, ms) => {
      const id = nextId;
      nextId += 1;
      timers.push({ id, fn, ms });
      return id;
    },
    clearTimer: (id) => {
      const index = timers.findIndex((timer) => timer.id === id);
      if (index >= 0) timers.splice(index, 1);
    },
    openCountdown: () => events.push('open'),
    updateCountdown: (snapshot) => events.push(`update:${snapshot.remainingMs}`),
    closeCountdown: () => events.push('close'),
    install: install ?? (async () => {
      events.push('install');
    }),
    onChange: () => {},
  });

  const fire = async (ms) => {
    const timer = timers.find((entry) => entry.ms === ms);
    assert.ok(timer, `missing ${ms}ms timer`);
    timers.splice(timers.indexOf(timer), 1);
    timer.fn();
    await queue.settled();
  };

  return {
    queue,
    events,
    timers,
    setStatus: (next) => {
      status = next;
    },
    fire,
  };
};

test('a queued update counts down once and installs only after a last idle read', async () => {
  const { queue, events, fire } = harness();
  await queue.queue({ version: '2.0.0', channel: 'stable' });
  assert.deepEqual(queue.snapshot().phase, 'counting');
  assert.equal(events.filter((event) => event === 'open').length, 1);

  await queue.queue({ version: '2.0.0', channel: 'stable' });
  assert.equal(events.filter((event) => event === 'open').length, 1);

  await fire(1_000);
  assert.ok(events.includes('install'));
  assert.equal(queue.snapshot().phase, 'idle');
});

test('work admitted by the last read cancels the install and waits', async () => {
  const { queue, events, setStatus, fire } = harness();
  await queue.queue({ version: '2.0.0', channel: 'stable' });
  setStatus({ state: 'busy', reason: 'session' });
  await fire(1_000);
  assert.equal(events.includes('install'), false);
  assert.equal(queue.snapshot().phase, 'waiting');
  assert.equal(queue.snapshot().reason, 'session');
  assert.ok(events.includes('close'));
});

test('work that starts during the countdown closes it, and the next idle period starts a new one', async () => {
  const { queue, events, timers, setStatus, fire } = harness();
  await queue.queue({ version: '2.0.0', channel: 'stable' });
  setStatus({ state: 'busy', reason: 'command' });
  await fire(5_000);
  assert.equal(queue.snapshot().phase, 'waiting');
  assert.ok(events.includes('close'));
  const opened = events.filter((event) => event === 'open').length;

  setStatus({ state: 'idle', reason: null });
  await fire(5_000);
  assert.equal(events.filter((event) => event === 'open').length, opened + 1);
  assert.equal(queue.snapshot().remainingMs, 1_000);
  assert.ok(timers.some((timer) => timer.ms === 1_000));
});

test('waking from sleep starts a fresh countdown instead of finishing the old one', async () => {
  const { queue, events } = harness();
  await queue.queue({ version: '2.0.0', channel: 'stable' });
  events.length = 0;
  await queue.noteResume();
  assert.ok(events.includes('close'));
  assert.ok(events.includes('open'));
  assert.equal(queue.snapshot().remainingMs, 1_000);
  assert.equal(events.includes('install'), false);
});

test('cancel, and a different release, drop the queue and keep the watcher off', async () => {
  const { queue, timers } = harness();
  await queue.queue({ version: '2.0.0', channel: 'stable' });
  await queue.cancel();
  assert.equal(queue.snapshot().phase, 'idle');
  assert.equal(timers.length, 0);

  await queue.queue({ version: '2.0.0', channel: 'stable' });
  await queue.noteRelease({ version: '2.0.1', channel: 'stable' });
  assert.equal(queue.snapshot().phase, 'idle');
  assert.equal(timers.length, 0);
});

test('a resume during the final idle read starts a fresh countdown', async () => {
  const idle = { state: 'idle', reason: null };
  const readStarted = Promise.withResolvers();
  const finalRead = Promise.withResolvers();
  let reads = 0;
  const { queue, events, fire } = harness({
    readIdle: async () => {
      if (++reads !== 2) return idle;
      readStarted.resolve();
      return finalRead.promise;
    },
  });
  await queue.queue({ version: '2.0.0', channel: 'stable' });
  const timer = fire(1_000);
  await readStarted.promise;
  const resume = queue.noteResume();
  finalRead.resolve(idle);
  await Promise.all([timer, resume]);
  assert.equal(events.includes('install'), false);
  assert.equal(queue.snapshot().remainingMs, 1_000);
});

test('an explicit restart during the final idle read reserves one installer handoff', async () => {
  const readStarted = Promise.withResolvers();
  const finalRead = Promise.withResolvers();
  let reads = 0;
  let attempts = 0;
  const { queue, fire } = harness({
    readIdle: async () => {
      if (++reads !== 2) return { state: 'idle', reason: null };
      readStarted.resolve();
      return finalRead.promise;
    },
    install: () => {
      attempts += 1;
      throw new Error('installer failed');
    },
  });
  await queue.queue({ version: '2.0.0', channel: 'stable' });
  const countdown = fire(1_000);
  await readStarted.promise;
  const restart = queue.beginInstall();
  finalRead.resolve({ state: 'idle', reason: null });
  await countdown;
  await assert.rejects(restart, /installer failed/);
  assert.equal(attempts, 1);
  assert.equal(queue.snapshot().reason, 'install-failed');
});

test('confirmed quit during the final idle read prevents any installer handoff', async () => {
  const readStarted = Promise.withResolvers();
  const finalRead = Promise.withResolvers();
  let reads = 0;
  let attempts = 0;
  const { queue, fire } = harness({
    readIdle: async () => {
      if (++reads !== 2) return { state: 'idle', reason: null };
      readStarted.resolve();
      return finalRead.promise;
    },
    install: async () => { attempts += 1; },
  });
  await queue.queue({ version: '2.0.0', channel: 'stable' });
  const countdown = fire(1_000);
  await readStarted.promise;
  const quit = queue.stop();
  finalRead.resolve({ state: 'idle', reason: null });
  await Promise.all([countdown, quit]);
  assert.equal(attempts, 0);
  assert.equal(queue.snapshot().phase, 'idle');
});

test('concurrent explicit restarts use a single installer handoff', async () => {
  const handoff = Promise.withResolvers();
  let attempts = 0;
  const { queue } = harness({ install: () => { attempts += 1; return handoff.promise; } });
  const first = queue.beginInstall();
  const second = queue.beginInstall();
  handoff.resolve();
  await Promise.all([first, second]);
  assert.equal(attempts, 1);
});

test('a failed install is left unqueued', async () => {
  const { queue, events, fire } = harness({
    install: async () => {
      events.push('install');
      throw new Error('installer failed');
    },
  });
  await queue.queue({ version: '2.0.0', channel: 'stable' });
  await fire(1_000);
  assert.equal(queue.snapshot().phase, 'idle');
  assert.equal(queue.snapshot().reason, 'install-failed');
  assert.equal(events.filter((event) => event === 'install').length, 1);
  assert.equal(events.filter((event) => event === 'open').length, 1);
});

test('countdown copy exists in every locale and the window escapes its text', () => {
  const english = idleUpdateDictionaries.en;
  const keys = Object.keys(english);
  for (const locale of IDLE_UPDATE_LOCALES) {
    const translated = idleUpdateDictionaries[locale];
    assert.deepEqual(Object.keys(translated), keys);
    for (const key of keys) {
      assert.ok(translated[key]);
      if (locale !== 'en') assert.notEqual(translated[key], english[key]);
    }
    assert.match(translated.countdown, /\{seconds\}/);
    assert.match(translated.countdownOne, /\{seconds\}/);
  }
  const html = idleUpdateWindowHtml({ locale: 'en', seconds: 1, reason: 'session' });
  assert.match(html, /Installing in 1 second/);
  assert.match(html, /idle-update\.invalid\/cancel/);
  const escaped = idleUpdateWindowHtml({ locale: 'en', seconds: 2, reason: 'x"<script>' });
  assert.equal(escaped.includes('<script>'), false);
});
