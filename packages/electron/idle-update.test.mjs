import assert from 'node:assert/strict';
import test from 'node:test';

import { createIdleUpdateQueue } from './idle-update.mjs';
import { idleUpdateWindowHtml } from './idle-update-locales.mjs';
import { LOCALES } from '../ui/src/lib/i18n/runtime.ts';

const harness = ({ install, readIdle } = {}) => {
  const timers = new Map();
  const events = [];
  let status = { state: 'idle' };
  const queue = createIdleUpdateQueue({
    readIdle: readIdle ?? (async () => status),
    countdownMs: 1_000,
    pollMs: 5_000,
    setTimer: (fn, ms) => { timers.set(fn, ms); return fn; },
    clearTimer: (fn) => timers.delete(fn),
    openCountdown: () => events.push('open'),
    updateCountdown: (snapshot) => events.push(`update:${snapshot.remainingMs}`),
    closeCountdown: () => events.push('close'),
    install: install ?? (() => events.push('install')),
  });

  const fire = async (ms) => {
    const fn = [...timers].find(([, delay]) => delay === ms)?.[0];
    assert.ok(fn, `missing ${ms}ms timer`);
    timers.delete(fn);
    fn();
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
  assert.ok([...timers.values()].includes(1_000));
});

test('waking from sleep starts a fresh countdown instead of finishing the old one', async () => {
  const { queue, events, timers } = harness();
  await queue.queue({ version: '2.0.0', channel: 'stable' });
  events.length = 0;
  await queue.noteSuspend();
  assert.equal(queue.snapshot().phase, 'waiting');
  assert.equal([...timers.values()].includes(1_000), false);
  await queue.noteResume();
  assert.ok(events.includes('close'));
  assert.ok(events.includes('open'));
  assert.equal(queue.snapshot().remainingMs, 1_000);
  assert.equal(events.includes('install'), false);
});

test('a failed final read waits and a later successful poll starts over', async () => {
  let reads = 0;
  const { queue, events, fire } = harness({ readIdle: () => {
    if (++reads === 2) throw new Error('server unavailable');
    return { state: 'idle' };
  } });
  await queue.queue({ version: '2.0.0', channel: 'stable' });
  await fire(1_000);
  assert.equal(queue.snapshot().phase, 'waiting');
  await fire(5_000);
  assert.equal(queue.snapshot().remainingMs, 1_000);
  assert.deepEqual(events, ['open', 'close', 'open']);
});

test('cancel, and a different release, drop the queue and keep the watcher off', async () => {
  const { queue, timers } = harness();
  await queue.queue({ version: '2.0.0', channel: 'stable' });
  await queue.cancel();
  assert.equal(queue.snapshot().phase, 'idle');
  assert.equal(timers.size, 0);

  await queue.queue({ version: '2.0.0', channel: 'stable' });
  await queue.noteRelease({ version: '2.0.1', channel: 'stable' });
  assert.equal(queue.snapshot().phase, 'idle');
  assert.equal(timers.size, 0);
});

const finalReadHarness = (install) => {
  const started = Promise.withResolvers();
  const answer = Promise.withResolvers();
  let reads = 0;
  return {
    ...harness({
      readIdle: () => ++reads === 2 ? (started.resolve(), answer.promise) : Promise.resolve({ state: 'idle' }),
      install,
    }),
    started,
    answer,
  };
};

test('a resume during the final idle read starts a fresh countdown', async () => {
  const { queue, events, fire, started, answer } = finalReadHarness();
  await queue.queue({ version: '2.0.0', channel: 'stable' });
  const countdown = fire(1_000);
  await started.promise;
  const resume = queue.noteResume();
  answer.resolve({ state: 'idle' });
  await Promise.all([countdown, resume]);
  assert.equal(events.includes('install'), false);
  assert.equal(queue.snapshot().remainingMs, 1_000);
});

test('an explicit restart during the final idle read reserves one installer handoff', async () => {
  let attempts = 0;
  const { queue, fire, started, answer } = finalReadHarness(() => {
    attempts += 1;
    throw new Error('installer failed');
  });
  await queue.queue({ version: '2.0.0', channel: 'stable' });
  const countdown = fire(1_000);
  await started.promise;
  const restart = queue.beginInstall();
  answer.resolve({ state: 'idle' });
  await countdown;
  await assert.rejects(restart, /installer failed/);
  assert.equal(attempts, 1);
  assert.equal(queue.snapshot().reason, 'install-failed');
});

test('confirmed quit during the final idle read prevents any installer handoff', async () => {
  let attempts = 0;
  const { queue, fire, started, answer } = finalReadHarness(async () => { attempts += 1; });
  await queue.queue({ version: '2.0.0', channel: 'stable' });
  const countdown = fire(1_000);
  await started.promise;
  const quit = queue.stop();
  answer.resolve({ state: 'idle' });
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
  for (const locale of LOCALES) {
    const html = idleUpdateWindowHtml({ locale, seconds: 30 });
    assert.match(html, /<title>[^<]+<\/title>/);
    if (locale !== 'en') assert.doesNotMatch(html, /<title>Install update<\/title>/);
    assert.match(html, /<p id="countdown">[^<]*30[^<]*<\/p>/);
  }
  const html = idleUpdateWindowHtml({ locale: 'en', seconds: 1 });
  assert.match(html, /Installing in 1 second/);
  assert.match(html, /idle-update\.invalid\/cancel/);
  const escaped = idleUpdateWindowHtml({ locale: 'en', seconds: 'x"<script>' });
  assert.equal(escaped.includes('<script>'), false);
});
