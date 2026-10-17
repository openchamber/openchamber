import { describe, expect, it } from 'vitest';
import { createServerDiagnosticJournal } from './server-journal.js';

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

  it('keeps only fixed lifecycle actions and enum details, and bounds the retained history', () => {
    let at = Date.parse('2026-09-28T10:00:00Z');
    const journal = createServerDiagnosticJournal({ now: () => at, maxEvents: 2, maxAgeMs: 1_000 });
    expect(journal.snapshot().coverage).toEqual([{ source: 'server journal', status: 'empty' }]);
    journal.record('managed launch', { attempt: 1 });
    journal.record('raw stderr: token=secret-123');
    journal.record('health failed', { failureClass: 'secret-class' });
    expect(journal.snapshot().events).toEqual([
      { at, source: 'server journal', action: 'managed launch', detail: 'attempt=1' },
      { at, source: 'server journal', action: 'health failed' },
    ]);
    journal.record('health failed', { failureClass: 'timeout' });
    expect(journal.snapshot().events.at(-1)?.detail).toBe('class=timeout');
    expect(journal.snapshot().coverage).toEqual([{ source: 'server journal', status: 'truncated', omitted: 1 }]);
    at += 2_000;
    expect(journal.snapshot().events).toEqual([]);
    expect(JSON.stringify(journal.snapshot())).not.toContain('secret');
  });
});
