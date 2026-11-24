import { beforeEach, describe, expect, test } from 'bun:test';
import { createBrowserInputReporter, type ActiveReport } from './preferredClient';

/** What this window reported, in order. */
let reports: ActiveReport[] = [];
/** The status the server answers with; 404 plays a server that predates the route. */
let status = 200;
/** The preferred connection the server names in its answer; the reporter's own by default. */
let answerPreferred: string | null = null;
/** While set, the server holds its answer until the test releases it. */
let held: Promise<void> | null = null;

const createReporter = () => createBrowserInputReporter(async (report) => {
  reports.push(report);
  if (held) await held;
  return new Response(JSON.stringify({ preferredConnectionId: answerPreferred ?? report.connectionId }), { status });
});

const reportedIds = (): string[] => reports.map((entry) => entry.connectionId);

describe('telling the server which window the user is at', () => {
  beforeEach(() => {
    reports = [];
    status = 200;
    answerPreferred = null;
    held = null;
  });

  test('reports the first input while another window is preferred, and nothing more', async () => {
    const reporter = createReporter();
    await reporter.noteStreamConnection('here');
    reporter.notePreferredConnection('there');

    await reporter.reportInput();
    await reporter.reportInput();

    expect(reports).toEqual([{ connectionId: 'here', previousConnectionId: null }]);
  });

  test('reports again once the server says the user moved to another window', async () => {
    const reporter = createReporter();
    await reporter.noteStreamConnection('here');
    await reporter.reportInput();

    reporter.notePreferredConnection('there');
    await reporter.reportInput();

    expect(reportedIds()).toEqual(['here', 'here']);
  });

  test('a preferred window reports under its new connection, naming the old one', async () => {
    const reporter = createReporter();
    await reporter.noteStreamConnection('here');
    await reporter.reportInput();

    await reporter.noteStreamConnection('here-again');

    expect(reports[1]).toEqual({ connectionId: 'here-again', previousConnectionId: 'here' });
  });

  test('a window that lost the preference while reconnecting reports on its next input', async () => {
    const reporter = createReporter();
    await reporter.noteStreamConnection('here');
    await reporter.reportInput();

    answerPreferred = 'there';
    await reporter.noteStreamConnection('here-again');
    answerPreferred = null;
    await reporter.reportInput();

    expect(reportedIds()).toEqual(['here', 'here-again', 'here-again']);
  });

  test('a window the user was not at stays quiet when its stream reconnects', async () => {
    const reporter = createReporter();
    await reporter.noteStreamConnection('here');
    reporter.notePreferredConnection('there');

    await reporter.noteStreamConnection('here-again');

    expect(reports).toEqual([]);
  });

  test('an answer that a broadcast overtook does not make this window preferred', async () => {
    const reporter = createReporter();
    await reporter.noteStreamConnection('here');
    let release = (): void => {};
    held = new Promise((resolve) => { release = resolve; });

    const reported = reporter.reportInput();
    reporter.notePreferredConnection('there');
    release();
    await reported;
    held = null;
    await reporter.reportInput();

    expect(reportedIds()).toEqual(['here', 'here']);
  });

  test('input after another window took the preference is reported once the pending report settles', async () => {
    const reporter = createReporter();
    await reporter.noteStreamConnection('here');
    let release = (): void => {};
    held = new Promise((resolve) => { release = resolve; });

    const reported = reporter.reportInput();
    reporter.notePreferredConnection('there');
    const later = reporter.reportInput();
    release();
    await Promise.all([reported, later]);
    held = null;

    expect(reportedIds()).toEqual(['here', 'here']);
  });

  test('queued input is dropped when another window took the preference after it', async () => {
    const reporter = createReporter();
    await reporter.noteStreamConnection('here');
    let release = (): void => {};
    held = new Promise((resolve) => { release = resolve; });

    const reported = reporter.reportInput();
    reporter.notePreferredConnection('there');
    const later = reporter.reportInput();
    reporter.notePreferredConnection('elsewhere');
    release();
    await Promise.all([reported, later]);
    held = null;

    expect(reportedIds()).toEqual(['here']);
  });

  test('a second reconnect before the hand-back is answered hands back from the unanswered connection', async () => {
    const reporter = createReporter();
    await reporter.noteStreamConnection('here');
    await reporter.reportInput();
    let release = (): void => {};
    held = new Promise((resolve) => { release = resolve; });

    const firstHandBack = reporter.noteStreamConnection('here-again');
    const secondHandBack = reporter.noteStreamConnection('here-third');
    release();
    await Promise.all([firstHandBack, secondHandBack]);
    held = null;

    expect(reports.slice(1)).toEqual([
      { connectionId: 'here-again', previousConnectionId: 'here' },
      { connectionId: 'here-third', previousConnectionId: 'here-again' },
    ]);
  });

  test('a missing-route answer for a closed stream does not silence the new one', async () => {
    const reporter = createReporter();
    await reporter.noteStreamConnection('here');
    reporter.notePreferredConnection('there');
    status = 404;
    let release = (): void => {};
    held = new Promise((resolve) => { release = resolve; });

    const reported = reporter.reportInput();
    await reporter.noteStreamConnection('here-again');
    release();
    await reported;
    held = null;
    status = 200;
    await reporter.reportInput();

    expect(reportedIds()).toEqual(['here', 'here-again']);
  });

  test('a reconnect while a report is still out hands the preference back under the new connection', async () => {
    const reporter = createReporter();
    await reporter.noteStreamConnection('here');
    let release = (): void => {};
    held = new Promise((resolve) => { release = resolve; });

    const reported = reporter.reportInput();
    reporter.notePreferredConnection('here');
    const handedBack = reporter.noteStreamConnection('here-again');
    release();
    await Promise.all([reported, handedBack]);
    held = null;
    await reporter.reportInput();

    expect(reports).toEqual([
      { connectionId: 'here', previousConnectionId: null },
      { connectionId: 'here-again', previousConnectionId: 'here' },
    ]);
  });

  test('asks a server without the route once per connection, not on every key press', async () => {
    status = 404;
    const reporter = createReporter();
    await reporter.noteStreamConnection('here');

    await reporter.reportInput();
    await reporter.reportInput();
    await reporter.noteStreamConnection('here-again');
    await reporter.reportInput();

    expect(reportedIds()).toEqual(['here', 'here-again']);
  });

  test('a failed report is retried on the next input', async () => {
    status = 503;
    const reporter = createReporter();
    await reporter.noteStreamConnection('here');
    await reporter.reportInput();

    status = 200;
    await reporter.reportInput();
    await reporter.reportInput();

    expect(reportedIds()).toEqual(['here', 'here']);
  });
});
