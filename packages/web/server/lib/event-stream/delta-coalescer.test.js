import { describe, expect, it } from 'vitest';

import { createDeltaCoalescer, DELTA_COALESCE_WINDOW_MS, resolveDeltaCoalesceWindowMs } from './delta-coalescer.js';

let nextId = 0;

// v2 wire shape: `{ type, id, data, location }`. Text and reasoning fragments
// are addressed by `ordinal`, tool-input fragments by the tool call `id`.
const delta = (ordinal, text, {
  messageID = 'msg_1',
  type = 'session.text.delta',
  directory = '/repo',
  sessionID = 'ses_1',
} = {}) => {
  nextId += 1;
  const id = String(nextId).padStart(6, '0');
  const data = { sessionID, assistantMessageID: messageID, delta: text };
  if (type === 'session.tool.input.delta') data.id = String(ordinal);
  else data.ordinal = ordinal;
  const payload = { id, type, location: { directory }, data };
  return { envelope: { eventId: id, directory, payload }, payload };
};

const other = (type, data = {}) => {
  nextId += 1;
  const id = String(nextId).padStart(6, '0');
  const payload = { id, type, location: { directory: '/repo' }, data };
  return { envelope: { eventId: id, directory: '/repo', payload }, payload };
};

// A clock and timer queue the test advances by hand, so every assertion about
// the window is exact instead of racing a real timeout.
const createHarness = (options = {}) => {
  let time = 1_000_000;
  let timers = [];
  let timerSeq = 0;
  const emitted = [];
  const coalescer = createDeltaCoalescer({
    emit: (event) => emitted.push(event),
    now: () => time,
    setTimer: (callback, delay) => {
      timerSeq += 1;
      timers.push({ id: timerSeq, at: time + delay, callback });
      return timerSeq;
    },
    clearTimer: (id) => {
      timers = timers.filter((timer) => timer.id !== id);
    },
    ...options,
  });
  const advance = (ms) => {
    const target = time + ms;
    for (;;) {
      const due = timers.filter((timer) => timer.at <= target).sort((left, right) => left.at - right.at)[0];
      if (!due) break;
      timers = timers.filter((timer) => timer !== due);
      time = due.at;
      due.callback();
    }
    time = target;
  };
  return { coalescer, emitted, advance, pendingTimers: () => timers.length };
};

const DELTA_TYPES = new Set(['session.text.delta', 'session.reasoning.delta', 'session.tool.input.delta']);
const isDelta = (event) => DELTA_TYPES.has(event.payload.type);
const keyOf = (event) => `${event.payload.data.assistantMessageID}:${event.payload.type}:${event.payload.data.ordinal ?? event.payload.data.id}`;

const textByKey = (events) => {
  const text = new Map();
  for (const event of events) {
    if (!isDelta(event)) continue;
    text.set(keyOf(event), (text.get(keyOf(event)) ?? '') + event.payload.data.delta);
  }
  return text;
};

describe('delta coalescer', () => {
  it('emits the first delta after a quiet spell at once and unchanged', () => {
    const { coalescer, emitted } = createHarness();
    const first = delta(1, 'He');

    coalescer.push(first);

    expect(emitted).toEqual([first]);
    expect(emitted[0]).toBe(first);
  });

  it('merges following deltas for one stream and carries the last fragment id', () => {
    const { coalescer, emitted, advance, pendingTimers } = createHarness();
    const fragments = [delta(1, 'He'), delta(1, 'll'), delta(1, 'o,'), delta(1, ' wor'), delta(1, 'ld')];

    for (const fragment of fragments) coalescer.push(fragment);
    expect(emitted).toHaveLength(1);
    advance(50);

    expect(emitted).toHaveLength(2);
    expect(emitted[1].payload.data).toEqual({ sessionID: 'ses_1', assistantMessageID: 'msg_1', ordinal: 1, delta: 'llo, world' });
    expect(emitted[1].envelope.eventId).toBe(fragments[4].envelope.eventId);
    expect(emitted[1].payload.id).toBe(fragments[4].payload.id);
    expect(emitted[1].envelope.payload).toBe(emitted[1].payload);
    expect(pendingTimers()).toBe(0);
    // Upstream objects are never mutated: other hub subscribers may hold them.
    expect(fragments.map((fragment) => fragment.payload.data.delta)).toEqual(['He', 'll', 'o,', ' wor', 'ld']);
  });

  it('never holds text longer than the window', () => {
    const { coalescer, emitted, advance } = createHarness();
    coalescer.push(delta(1, 'a'));
    coalescer.push(delta(1, 'b'));

    advance(49);
    expect(emitted).toHaveLength(1);
    advance(1);
    expect(emitted).toHaveLength(2);
  });

  it('treats every other event as a barrier, so a delta never crosses a stream snapshot', () => {
    const { coalescer, emitted, advance } = createHarness();
    const snapshot = other('session.text.ended', { sessionID: 'ses_1', assistantMessageID: 'msg_1', ordinal: 1, text: 'abc' });

    coalescer.push(delta(1, 'a'));
    coalescer.push(delta(1, 'b'));
    coalescer.push(delta(1, 'c'));
    coalescer.push(snapshot);
    coalescer.push(delta(1, 'd'));
    coalescer.push(delta(1, 'e'));
    advance(50);

    expect(emitted.map((event) => (isDelta(event) ? event.payload.data.delta : event.payload.type)))
      .toEqual(['a', 'bc', 'session.text.ended', 'de']);
    expect(emitted[2]).toBe(snapshot);
  });

  it('keeps several streams pending at once and emits them in upstream id order', () => {
    const { coalescer, emitted, advance } = createHarness();
    coalescer.push(delta(0, '.'));

    coalescer.push(delta(1, 'a1'));
    coalescer.push(delta(2, 'b1', { messageID: 'msg_2', sessionID: 'ses_2' }));
    coalescer.push(delta(1, 'a2'));
    const lastB = delta(2, 'b2', { messageID: 'msg_2', sessionID: 'ses_2' });
    coalescer.push(lastB);
    advance(50);

    const merged = emitted.slice(1);
    expect(merged.map((event) => event.payload.data.delta)).toEqual(['a1a2', 'b1b2']);
    expect(merged[1].envelope.eventId).toBe(lastB.envelope.eventId);
    const ids = emitted.map((event) => event.envelope.eventId);
    expect(ids).toEqual([...ids].sort());
  });

  it('does not merge the same ordinal across directories, sessions, messages, or stream kinds', () => {
    const { coalescer, emitted, advance } = createHarness();
    coalescer.push(delta(0, '.'));

    coalescer.push(delta(1, '1'));
    coalescer.push(delta(1, '2', { directory: '/other' }));
    coalescer.push(delta(1, '3', { messageID: 'msg_2' }));
    coalescer.push(delta(1, '4', { type: 'session.reasoning.delta' }));
    coalescer.push(delta(1, '5', { sessionID: 'ses_2' }));
    advance(50);

    expect(emitted.slice(1).map((event) => event.payload.data.delta)).toEqual(['1', '2', '3', '4', '5']);
  });

  it('bounds pending text by characters and by streams, emitting early instead of dropping', () => {
    const { coalescer, emitted } = createHarness({ maxPendingChars: 10, maxPendingKeys: 3 });
    coalescer.push(delta(0, '.'));

    let peakChars = 0;
    for (let index = 0; index < 40; index += 1) {
      coalescer.push(delta(1, 'xyz'));
      peakChars = Math.max(peakChars, coalescer.pendingSize().chars);
    }
    expect(peakChars).toBeLessThan(10 + 3);
    expect(textByKey(emitted).get('msg_1:session.text.delta:1')).toBe('xyz'.repeat(40));

    let peakKeys = 0;
    for (let index = 0; index < 20; index += 1) {
      coalescer.push(delta(100 + index, 'k'));
      peakKeys = Math.max(peakKeys, coalescer.pendingSize().keys);
    }
    expect(peakKeys).toBeLessThanOrEqual(3);
    coalescer.flush();
    expect(emitted.filter((event) => event.payload.data.delta === 'k')).toHaveLength(20);
  });

  it('flushes on demand and leaves nothing pending', () => {
    const { coalescer, emitted, pendingTimers } = createHarness();
    coalescer.push(delta(1, 'a'));
    coalescer.push(delta(1, 'b'));

    coalescer.flush();

    expect(emitted.map((event) => event.payload.data.delta)).toEqual(['a', 'b']);
    expect(coalescer.pendingSize()).toEqual({ keys: 0, chars: 0 });
    expect(pendingTimers()).toBe(0);
  });

  it('passes a malformed delta through as a barrier instead of guessing', () => {
    const { coalescer, emitted } = createHarness();
    const malformed = other('session.text.delta', { sessionID: 'ses_1', assistantMessageID: 'msg_1', ordinal: 1, delta: 42 });

    coalescer.push(delta(1, 'a'));
    coalescer.push(delta(1, 'b'));
    coalescer.push(malformed);

    expect(emitted.map((event) => event.payload.data.delta)).toEqual(['a', 'b', 42]);
    expect(emitted[2]).toBe(malformed);
  });

  it('is a pass-through when the window is zero', () => {
    const { coalescer, emitted } = createHarness({ windowMs: 0 });
    const events = [delta(1, 'a'), delta(1, 'b'), delta(1, 'c')];

    for (const event of events) coalescer.push(event);

    expect(emitted).toEqual(events);
  });

  // The properties that make coalescing safe, checked over arbitrary streams
  // rather than the handful of shapes someone thought of.
  it('loses, duplicates, and reorders nothing across randomized streams', () => {
    let seed = 0x5eed;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };

    for (let round = 0; round < 40; round += 1) {
      const { coalescer, emitted, advance } = createHarness({ maxPendingChars: 200, maxPendingKeys: 4 });
      const raw = [];
      const partCount = 1 + Math.floor(random() * 6);
      for (let index = 0; index < 600; index += 1) {
        const roll = random();
        let event;
        if (roll < 0.9) {
          const part = Math.floor(random() * partCount);
          event = delta(part, `${index}|`.repeat(1 + Math.floor(random() * 3)), { messageID: `msg_${part % 2}` });
        } else if (roll < 0.95) {
          event = other('session.text.ended', { sessionID: 'ses_1', assistantMessageID: 'msg_0', ordinal: Math.floor(random() * partCount), text: '' });
        } else {
          event = other('session.execution.started', { sessionID: 'ses_1' });
        }
        raw.push(event);
        coalescer.push(event);
        if (random() < 0.3) advance(Math.floor(random() * 80));
      }
      advance(1_000);

      // Nothing lost or duplicated: every part field ends with the same text.
      expect(textByKey(emitted)).toEqual(textByKey(raw));

      // Every other event is delivered once, as the same object, in order.
      expect(emitted.filter((event) => !isDelta(event))).toEqual(raw.filter((event) => !isDelta(event)));

      // Barrier: the text delivered before each barrier is exactly the text
      // that arrived before it.
      for (const barrier of raw.filter((event) => !isDelta(event))) {
        expect(textByKey(emitted.slice(0, emitted.indexOf(barrier)))).toEqual(textByKey(raw.slice(0, raw.indexOf(barrier))));
      }

      // Replay cursors: ids stay unique and in upstream order.
      const ids = emitted.map((event) => event.envelope.eventId);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toEqual([...ids].sort());

      expect(coalescer.pendingSize()).toEqual({ keys: 0, chars: 0 });
    }
  });

  it('collapses a dense single-part stream to a few frames per window', () => {
    const { coalescer, emitted, advance } = createHarness();

    // 150 fragments a second for two seconds, the rate measured from OpenCode.
    for (let index = 0; index < 300; index += 1) {
      coalescer.push(delta(1, 'ab'));
      advance(index % 3 === 2 ? 8 : 6);
    }
    advance(50);

    expect(textByKey(emitted).get('msg_1:session.text.delta:1')).toBe('ab'.repeat(300));
    expect(emitted.length).toBeLessThanOrEqual(45);
  });
});

describe('resolveDeltaCoalesceWindowMs', () => {
  it('uses the default when unset and accepts zero as off', () => {
    expect(resolveDeltaCoalesceWindowMs({})).toBe(DELTA_COALESCE_WINDOW_MS);
    expect(resolveDeltaCoalesceWindowMs({ OPENCHAMBER_EVENT_DELTA_COALESCE_MS: ' ' })).toBe(DELTA_COALESCE_WINDOW_MS);
    expect(resolveDeltaCoalesceWindowMs({ OPENCHAMBER_EVENT_DELTA_COALESCE_MS: '0' })).toBe(0);
    expect(resolveDeltaCoalesceWindowMs({ OPENCHAMBER_EVENT_DELTA_COALESCE_MS: '25' })).toBe(25);
  });

  it('keeps the default and says so for anything that is not 0-1000 whole milliseconds', () => {
    for (const value of ['-1', '1001', '12.5', 'fast', 'NaN', '1e9']) {
      const warnings = [];
      expect(resolveDeltaCoalesceWindowMs({ OPENCHAMBER_EVENT_DELTA_COALESCE_MS: value }, (message) => warnings.push(message))).toBe(DELTA_COALESCE_WINDOW_MS);
      expect(warnings).toHaveLength(1);
    }
  });
});
