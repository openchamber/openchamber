import { describe, expect, test } from 'bun:test';
import { clearDiagnosticEvents, diagnosticIdentity, formatDiagnosticEvents, mergeDiagnosticEvents, recordDiagnosticEvent, recordRendererConsole, rendererErrorDetail, rendererRejectionDetail, getDiagnosticEvents, getDiagnosticOmittedCount, getDiagnosticScopeStartedAt } from './timeline';

describe('diagnostic timeline', () => {
  test('merges by timestamp, preserving original order on ties', () => {
    const output = mergeDiagnosticEvents(
      [{ at: 3000, source: 'ui', action: 'connected' }],
      [{ at: 1000, source: 'server', action: 'started' }, { at: 3000, source: 'server', action: 'ready' }],
    );
    expect(formatDiagnosticEvents(output)).toBe(
      '1970-01-01T00:00:01.000Z [server] started\n'
      + '1970-01-01T00:00:03.000Z [ui] connected\n'
      + '1970-01-01T00:00:03.000Z [server] ready\n',
    );
  });

  test('keeps a bounded rolling history', () => {
    clearDiagnosticEvents();
    for (let index = 0; index < 1_600; index++) {
      recordDiagnosticEvent({ at: Date.now(), source: 'ui', action: `event-${index}` });
    }
    expect(getDiagnosticEvents()).toHaveLength(1_500);
    expect(getDiagnosticEvents()[0]?.action).toBe('event-100');
    expect(getDiagnosticOmittedCount()).toBe(100);
  });

  test('clears old runtime events and advances the buffer scope', () => {
    const before = getDiagnosticScopeStartedAt();
    clearDiagnosticEvents();
    expect(getDiagnosticEvents()).toEqual([]);
    expect(getDiagnosticOmittedCount()).toBe(0);
    expect(getDiagnosticScopeStartedAt()).toBeGreaterThanOrEqual(before);
  });

  test('correlates identities without exporting their original values and resets on a runtime change', () => {
    clearDiagnosticEvents();
    expect(diagnosticIdentity('session', 'ses_private-123')).toBe('session-1');
    expect(diagnosticIdentity('directory', '/private/secret')).toBe('directory-1');
    expect(diagnosticIdentity('message', 'msg_private-456')).toBe('message-1');
    expect(diagnosticIdentity('session', 'ses_private-123')).toBe('session-1');
    expect(diagnosticIdentity('session', 'ses_other')).toBe('session-2');
    expect(diagnosticIdentity('session', 'x'.repeat(1_025))).toBe('unavailable');
    clearDiagnosticEvents();
    expect(diagnosticIdentity('session', 'ses_other')).toBe('session-1');
  });

  test('bounds the number of identities retained in memory', () => {
    clearDiagnosticEvents();
    expect(diagnosticIdentity('session', 'ses_first')).toBe('session-1');
    for (let index = 1; index <= 5_000; index++) diagnosticIdentity('session', `ses_${index}`);
    expect(diagnosticIdentity('session', 'ses_5000')).toBe('session-5001');
    expect(diagnosticIdentity('session', 'ses_first')).toBe('session-5002');
  });

  test('console capture keeps only vetted subsystem tags and drops all arguments', () => {
    clearDiagnosticEvents();
    recordRendererConsole('error', '[sync] Bearer secret-123 /private/file');
    recordRendererConsole('warn', '[password] secret-456', new TypeError('secret-789'));
    recordRendererConsole('error', '[sync] token=secret-123', new TypeError("Cannot read properties of null (reading 'secret-789')"));
    recordRendererConsole('info', 'unclassified token=secret-123');
    expect(getDiagnosticEvents().map((event) => [event.source, event.action])).toEqual([
      ['renderer/sync', 'console.error'], ['renderer', 'console.warn'], ['renderer/sync', 'console.error'],
    ]);
    const text = formatDiagnosticEvents(getDiagnosticEvents());
    expect(text.includes('secret')).toBe(false);
    expect(text.includes('password')).toBe(false);
    expect(text.includes('private')).toBe(false);
    expect(text).toContain('console.warn type=TypeError');
    expect(text).toContain('message="Cannot read properties of null (reading [property])"');
    expect(getDiagnosticEvents()).toHaveLength(3);
  });

  test('renderer errors expose only a local asset location and an allowlisted type', () => {
    const page = 'openchamber-ui://app/index.html';
    const detail = rendererErrorDetail({
      filename: 'openchamber-ui://app/assets/main-test1234.js?token=secret-456',
      lineno: 47, colno: 12, error: new TypeError('Bearer secret-123'),
    }, page);
    expect(detail).toBe('type=TypeError asset=main line=47 column=12');
    expect(rendererErrorDetail({
      filename: 'openchamber-ui://app/assets/private-secret-123.js',
      lineno: 12, colno: 9, error: null,
    }, page)).toBe('type=unavailable asset=chunk line=12 column=9');
    expect(rendererErrorDetail({
      filename: 'https://elsewhere.example/private.js?token=secret-456',
      lineno: 47, colno: 12, error: new Error('secret-123'),
    }, page)).toBe('type=Error location=unverified');
    expect(rendererErrorDetail({
      filename: 'openchamber-ui://app/private/file.js',
      lineno: 47, colno: 12, error: null,
    }, page)).toBe('type=unavailable location=unverified');
    expect(rendererErrorDetail({
      filename: '', lineno: 0, colno: 0, error: null,
    }, page)).toBe('type=unavailable location=unavailable');
    expect(rendererErrorDetail({
      filename: '', lineno: 0, colno: 0, error: null, message: 'Script error.',
    }, page)).toBe('type=unavailable message="Script error." location=unavailable');
    expect(rendererErrorDetail({
      filename: '', lineno: 0, colno: 0, error: new TypeError("Cannot read properties of undefined (reading 'secret-789')"),
    }, page)).toBe('type=TypeError message="Cannot read properties of undefined (reading [property])" location=unavailable');
    expect(rendererErrorDetail({
      filename: '', lineno: 0, colno: 0, error: null, message: 'Bearer secret-123 /private/file',
    }, page)).toBe('type=unavailable location=unavailable');
  });

  test('unhandled rejections use the same safe message templates as uncaught exceptions', () => {
    expect(rendererRejectionDetail(new TypeError("Cannot read properties of undefined (reading 'secret-field')")))
      .toBe('type=TypeError message="Cannot read properties of undefined (reading [property])"');
    expect(rendererRejectionDetail(new Error('Bearer secret-123 /private/file'))).toBe('type=Error');
    expect(rendererRejectionDetail(null)).toBe('type=unavailable');
  });
});
