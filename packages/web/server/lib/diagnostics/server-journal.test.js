import { describe, expect, it } from 'vitest';
import { createManagedLogCapture, createServerDiagnosticJournal } from './server-journal.js';

describe('server diagnostic journal', () => {
  it('records completed HTTP status, safe route and stage while grouping repeated 404s', () => {
    let at = Date.parse('2026-09-28T10:00:00Z');
    const journal = createServerDiagnosticJournal({ now: () => at });
    for (let index = 0; index < 120; index++) {
      journal.recordHttpResponse('GET', `/api/session/ses_private_${index}`, 404);
      at += 10;
    }
    journal.recordHttpResponse('POST', '/api/session/ses_private_2/message/msg_private_3', 503);
    journal.recordHttpResponse('GET', '/api/info', 200);
    journal.recordHttpResponse('GET', '/api/config/settings/secret?token=private', 401);
    expect(journal.snapshot().events).toEqual([
      { at: Date.parse('2026-09-28T10:00:00Z'), source: 'server journal', action: 'http response completed',
        detail: 'method=GET route=/api/session/:sessionID stage=downstream_response http=404 count=120 spanMs=1190' },
      { at, source: 'server journal', action: 'http response completed',
        detail: 'method=POST route=/api/session/:sessionID/message/:messageID stage=downstream_response http=503' },
      { at, source: 'server journal', action: 'http response completed',
        detail: 'method=GET route=/api/other stage=downstream_response http=401' },
    ]);
    expect(JSON.stringify(journal.snapshot())).not.toMatch(/private|secret|token|msg_private/);
    at += 11 * 60_000;
    journal.recordHttpResponse('GET', '/api/session/ses_private', 404);
    expect(journal.snapshot().events).toHaveLength(4);
  });

  it('bounds sustained HTTP failure bursts without affecting unrelated responses', () => {
    let at = Date.parse('2026-09-28T10:00:00Z');
    const journal = createServerDiagnosticJournal({ now: () => at, maxEvents: 3 });
    for (let index = 0; index < 9_000; index++) {
      journal.recordHttpResponse('GET', `/api/session/secret-${index}?token=secret-${index}`, 404);
      at += 1;
    }
    expect(journal.snapshot().events.map((event) => event.detail)).toEqual([
      'method=GET route=/api/session/:sessionID stage=downstream_response http=404 count=4000 spanMs=3999',
      'method=GET route=/api/session/:sessionID stage=downstream_response http=404 count=4000 spanMs=3999',
      'method=GET route=/api/session/:sessionID stage=downstream_response http=404 count=1000 spanMs=999',
    ]);
    journal.recordHttpResponse('POST', '/api/info', 503);
    expect(journal.snapshot().events.at(-1)?.detail).toBe('method=POST route=/api/info stage=downstream_response http=503');
    expect(journal.snapshot().coverage[0]).toEqual({ source: 'server journal', status: 'truncated', omitted: 1 });
    expect(JSON.stringify(journal.snapshot())).not.toMatch(/secret|token/);
  });

  it('keeps only safe categories, including startup stderr split across chunks', () => {
    const at = Date.parse('2026-09-28T10:00:00Z');
    const journal = createServerDiagnosticJournal({ now: () => at });
    journal.beginManagedProcess(1);
    const capture = createManagedLogCapture(journal);
    capture.feed('timestamp=2026-09-28T10:00:00.000Z level=INFO run=abcdef01 message="database schema');
    capture.feed(' bootstrap completed" token=secret-123 /private/file\ntimestamp=2026-09-28T10:00:00Z level=ERROR run=abcdef01 message="Bearer secret-456"\n');
    capture.feed('plugin output contains token=secret-789\n');
    capture.feed('timestamp=2026-09-28T10:00:00Z level=INFO run=abcdef01 message="watcher subscribe" directory=/private/file\n');
    capture.feed('timestamp=2026-09-28T10:00:00Z level=INFO run=abcdef01 message="watcher started" path=/private/file\n');
    capture.flush();
    expect(journal.snapshot().events).toEqual([
      { at, source: 'server journal', action: 'managed launch', detail: 'attempt=1' },
      { at, source: 'managed OpenCode', action: 'info: database bootstrap completed' },
      { at, source: 'managed OpenCode', action: 'info: watcher activity', detail: 'subscribed=1 started=1 spanMs=0' },
    ]);
    expect(journal.snapshot().coverage[1]).toEqual({ source: 'managed OpenCode', status: 'read', filtered: 2, errors: 1 });
    expect(JSON.stringify(journal.snapshot())).not.toMatch(/secret|private|prompt|abcdef01/);
  });

  it('bounds long lines and the retained history, and distinguishes external from empty', () => {
    let at = Date.parse('2026-09-28T10:00:00Z');
    const journal = createServerDiagnosticJournal({ now: () => at, maxEvents: 2, maxAgeMs: 1_000 });
    expect(journal.snapshot().coverage[1].status).toBe('unavailable');
    journal.beginManagedProcess(1);
    expect(journal.snapshot().coverage[1].status).toBe('empty');
    const capture = createManagedLogCapture(journal);
    capture.feed(`${'x'.repeat(10_000)}\ntimestamp=2026-09-28T10:00:00Z level=WARN run=abcdef01 message=ok\n`);
    expect(journal.snapshot().coverage[1]).toEqual({ source: 'managed OpenCode', status: 'truncated', omitted: 1, filtered: 1, warnings: 1 });
    journal.record('health failed', { failureClass: 'timeout' });
    journal.record('health recovered');
    expect(journal.snapshot().events).toHaveLength(2);
    expect(journal.snapshot().coverage[0].status).toBe('truncated');
    at += 2_000;
    expect(journal.snapshot().events).toEqual([]);
    journal.markExternal();
    expect(journal.snapshot().coverage[1].status).toBe('skipped');
  });

  it('counts unrecognized warning streams without filling the event ring or storing raw lines', () => {
    const at = Date.parse('2026-09-28T10:00:00Z');
    const journal = createServerDiagnosticJournal({ now: () => at });
    journal.beginManagedProcess(1);
    const capture = createManagedLogCapture(journal);
    for (let index = 0; index < 10_000; index++) {
      capture.feed(`timestamp=2026-09-28T10:00:00Z level=WARN run=abcdef01 message="private" command=secret-${index}\n`);
    }
    const result = journal.snapshot();
    expect(result.events).toHaveLength(1);
    expect(result.coverage).toEqual([
      { source: 'server journal', status: 'read' },
      { source: 'managed OpenCode', status: 'filtered', filtered: 10_000, warnings: 10_000 },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/secret-|abcdef01/);
  });

  it('groups adjacent subprocess spawns in ten-second bursts without combining across lifecycle events', () => {
    let at = Date.parse('2026-09-28T10:00:00Z');
    const journal = createServerDiagnosticJournal({ now: () => at });
    journal.beginManagedProcess(1);
    const capture = createManagedLogCapture(journal);
    const spawn = () => capture.feed(`timestamp=${new Date(at).toISOString()} level=INFO run=abcdef01 message="spawning process" command=secret-123 cwd=/private/file\n`);
    spawn();
    const before = journal.snapshot();
    at += 500;
    spawn();
    at += 10_000;
    spawn();
    journal.record('health recovered');
    spawn();
    expect(before.events[1]).toEqual({ at: at - 10_500, source: 'managed OpenCode', action: 'info: subprocess spawned' });
    expect(journal.snapshot().events).toEqual([
      { at: at - 10_500, source: 'server journal', action: 'managed launch', detail: 'attempt=1' },
      { at: at - 10_500, source: 'managed OpenCode', action: 'info: subprocess spawned', detail: 'count=2 spanMs=500' },
      { at, source: 'managed OpenCode', action: 'info: subprocess spawned' },
      { at, source: 'server journal', action: 'health recovered' },
      { at, source: 'managed OpenCode', action: 'info: subprocess spawned' },
    ]);
    expect(JSON.stringify(journal.snapshot())).not.toMatch(/secret|private|abcdef01/);
  });

  it('groups watcher subscriptions and starts while keeping both counts visible', () => {
    let at = Date.parse('2026-09-28T10:00:00Z');
    const journal = createServerDiagnosticJournal({ now: () => at });
    journal.beginManagedProcess(1);
    const capture = createManagedLogCapture(journal);
    const watcher = (message) => capture.feed(`timestamp=${new Date(at).toISOString()} level=INFO run=abcdef01 message="${message}" directory=/private/file token=secret-123\n`);
    watcher('watcher subscribe');
    at += 100;
    watcher('watcher subscribe');
    at += 200;
    watcher('watcher started');
    expect(journal.snapshot().events[1]).toEqual({
      at: at - 300, source: 'managed OpenCode', action: 'info: watcher activity', detail: 'subscribed=2 started=1 spanMs=300',
    });
    journal.record('health failed', { failureClass: 'timeout' });
    watcher('watcher subscribe');
    expect(journal.snapshot().events.at(-1)).toEqual({
      at, source: 'managed OpenCode', action: 'info: watcher activity', detail: 'subscribed=1 started=0 spanMs=0',
    });
    expect(JSON.stringify(journal.snapshot())).not.toMatch(/secret|private|abcdef01/);
  });

  it('excludes unclassified info bursts without treating them as empty or consuming the ring', () => {
    const at = Date.parse('2026-09-28T10:00:00Z');
    const journal = createServerDiagnosticJournal({ now: () => at, maxEvents: 2 });
    journal.beginManagedProcess(1);
    const capture = createManagedLogCapture(journal);
    for (let index = 0; index < 5_000; index++) {
      capture.feed(`timestamp=2026-09-28T10:00:00Z level=INFO run=abcdef01 message="event" private=secret-${index}\n`);
    }
    expect(journal.snapshot()).toEqual({
      events: [{ at, source: 'server journal', action: 'managed launch', detail: 'attempt=1' }],
      coverage: [
        { source: 'server journal', status: 'read' },
        { source: 'managed OpenCode', status: 'filtered', filtered: 5_000 },
      ],
    });
    capture.feed('timestamp=2026-09-28T10:00:00Z level=INFO run=abcdef01 message="cli starting" role=secret-123\n');
    expect(journal.snapshot().events[1]).toEqual({ at, source: 'managed OpenCode', action: 'info: cli starting' });
    expect(JSON.stringify(journal.snapshot())).not.toContain('secret');
  });
});
