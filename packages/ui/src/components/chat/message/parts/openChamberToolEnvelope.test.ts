import { describe, expect, test } from 'bun:test';

import type { JsonValue } from '@/lib/opencode/model';
import { hasOpenChamberView, openChamberVerbKey, parseOpenChamberEnvelope, secretRowView, sessionsListedSchema, tightestWindow } from './openChamberToolEnvelope';

const envelope = (body: { [key: string]: JsonValue }) => JSON.stringify({ schemaVersion: 1, ...body });

describe('parseOpenChamberEnvelope', () => {
  test('reads the envelope as the tool answers it, and once more quoted, as an execute script can return it', () => {
    const text = envelope({ ok: true, action: 'memory.save', data: { saved: true } });
    expect(parseOpenChamberEnvelope(text)).toEqual({ ok: true, action: 'memory.save', data: { saved: true }, errorMessage: undefined });
    expect(parseOpenChamberEnvelope(JSON.stringify(text))?.action).toBe('memory.save');
  });

  test('keeps the error message of a failed call', () => {
    expect(parseOpenChamberEnvelope(envelope({ ok: false, action: 'session.link', error: { message: 'link.kind must be change or issue' } }))?.errorMessage)
      .toBe('link.kind must be change or issue');
  });

  test('is null for anything a script made of the answer', () => {
    expect(parseOpenChamberEnvelope('{"saved":true}')).toBeNull();
    expect(parseOpenChamberEnvelope('done')).toBeNull();
    expect(parseOpenChamberEnvelope('')).toBeNull();
    expect(parseOpenChamberEnvelope(undefined)).toBeNull();
  });
});

describe('sessionsListedSchema', () => {
  test('reads the folder of a listed session, and of one stored before the list was trimmed', () => {
    const parsed = sessionsListedSchema.parse({ sessions: [
      { id: 'ses_new', title: 'New', directory: '/repo', inWork: true },
      { id: 'ses_old', title: 'Old', location: { directory: '/old' }, time: { updated: 1 } },
    ] });
    expect(parsed.sessions.map(({ id, directory }) => [id, directory])).toEqual([['ses_new', '/repo'], ['ses_old', '/old']]);
  });
});

describe('openChamberVerbKey', () => {
  test('names a brief call by what it did, also from a reloaded row that kept only the call', () => {
    const shell = { action: 'lead.brief' };
    expect(openChamberVerbKey({ ...shell, data: { saved: true, length: 5, limit: 12000 } }, undefined)).toBe('chat.toolPart.openchamber.action.leadBriefSave');
    expect(openChamberVerbKey({ ...shell, data: { brief: '# Goal', limit: 12000, empty: false } }, undefined)).toBe('chat.toolPart.openchamber.action.leadBriefRead');
    expect(openChamberVerbKey(shell, { action: 'lead.brief', parameters: { edits: '[{"find":"a","replace":"b"}]' } })).toBe('chat.toolPart.openchamber.action.leadBriefSave');
    expect(openChamberVerbKey(shell, { action: 'lead.brief', parameters: { strands: [{ id: 'ci', close: true }] } })).toBe('chat.toolPart.openchamber.action.leadBriefSave');
    expect(openChamberVerbKey(shell, { code: 'await tools.openchamber(...)' })).toBe('chat.toolPart.openchamber.action.leadBrief');
  });
});

describe('hasOpenChamberView', () => {
  test('has a view only for a successful action it knows, with the data that view reads', () => {
    const link = { url: 'https://github.com/acme/demo/pull/42', number: 42, title: 'Fix', kind: 'pull', id: 'acme/demo#42' };
    expect(hasOpenChamberView({ ok: true, action: 'session.link', data: { linked: link }, errorMessage: undefined })).toBe(true);
    expect(hasOpenChamberView({ ok: true, action: 'session.link', data: { linked: { title: 'no url' } }, errorMessage: undefined })).toBe(false);
    expect(hasOpenChamberView({ ok: false, action: 'session.link', data: { linked: link }, errorMessage: 'x' })).toBe(false);
    expect(hasOpenChamberView({ ok: true, action: 'session.status', data: { status: 'idle' }, errorMessage: undefined })).toBe(false);
    // An empty list is an answer of its own, shown as such.
    expect(hasOpenChamberView({ ok: true, action: 'session.list', data: { sessions: [] }, errorMessage: undefined })).toBe(true);
    expect(hasOpenChamberView({ ok: true, action: 'session.list', data: {}, errorMessage: undefined })).toBe(false);
    expect(hasOpenChamberView({ ok: true, action: 'memory.list', data: { memories: [{ memoryId: 'm1', title: 'Uses bun', scope: 'global' }], projectUnavailable: true }, errorMessage: undefined })).toBe(true);
    expect(hasOpenChamberView({ ok: true, action: 'browser.capture', data: { path: '.openchamber/screenshots/a.jpg', url: null, title: null }, errorMessage: undefined })).toBe(true);
    expect(hasOpenChamberView({ ok: true, action: 'browser.capture', data: { url: 'https://example.com' }, errorMessage: undefined })).toBe(false);
    expect(hasOpenChamberView({ ok: true, action: 'browser.open', data: { url: 'http://localhost:3000/', title: '', opened: true }, errorMessage: undefined })).toBe(true);
    // Shapes the server answers for the rest of the actions.
    const view = (action: string, data: { [key: string]: JsonValue }) => hasOpenChamberView({ ok: true, action, data, errorMessage: undefined });
    expect(view('memory.read', { memory: { memoryId: 'm1', title: 'Uses bun', type: 'preference', scope: 'global', body: 'Always bun.' } })).toBe(true);
    expect(view('memory.delete', { deleted: true, memoryId: 'm1' })).toBe(true);
    expect(view('session.status', { sessionId: 'ses_1', directory: '/repo', sessionStatus: { type: 'waiting' } })).toBe(true);
    expect(view('session.messages', { sessionId: 'ses_1', directory: '/repo', role: 'all', messages: [{ id: 'm', role: 'assistant', createdAt: 1, completedAt: 2, model: 'a/b', text: 'Done.' }] })).toBe(true);
    expect(view('pr.watch', { watching: { url: 'https://github.com/a/b/pull/1', number: 1, title: 'Fix', status: 'pending' }, next: 'x' })).toBe(true);
    expect(view('wait.start', { watching: { url: 'https://github.com/a/b/pull/1', number: 1, title: 'Fix', status: 'pending' }, next: 'x' })).toBe(true);
    expect(view('wait.start', { waiting: { waitId: 'wait_1', source: 'timer', extension: 'OpenChamber', title: 'Timer', label: '10 min', args: { minutes: 10 }, status: 'waiting' }, next: 'x' })).toBe(true);
    expect(view('wait.start', { next: 'x' })).toBe(false);
    expect(view('wait.list', { waiting: [], sources: [{ source: 'timer', extension: 'OpenChamber', title: 'Timer' }] })).toBe(true);
    expect(view('wait.stop', { waiting: [], stopped: 2 })).toBe(true);
    expect(view('pr.unwatch', { watching: false, stopped: true })).toBe(true);
    expect(view('pr.unwatch', { watching: [{ url: 'https://github.com/a/b/pull/2', number: 2, title: 'Other', status: 'open' }], stopped: true })).toBe(true);
    expect(view('work.name', { task: 'worktree', title: 'Login timeout', named: true, branch: 'fix/login' })).toBe(true);
    expect(view('file.open', { path: '/repo/a.md', size: 10, opened: true })).toBe(true);
    expect(view('lead.brief', { sessionId: 'ses_1', saved: true, length: 7570, limit: 12000, file: '/data/leads/ses_1.md' })).toBe(true);
    expect(view('lead.brief', { sessionId: 'ses_1', brief: '', limit: 12000, empty: true })).toBe(true);
    expect(view('lead.digest', { sessionId: 'ses_1', saved: true, digest: { needsYou: [{ question: 'Q?', options: ['a'] }], now: ['x'], news: [], suggestions: [], updatedAt: 1 } })).toBe(true);
    expect(view('lead.digest', { sessionId: 'ses_1', saved: true, digest: { needsYou: [], now: [], news: [], suggestions: [], updatedAt: 1 } })).toBe(false);
    expect(view('lead.digest', { sessionId: 'ses_1', saved: true, digest: {} })).toBe(false);
    expect(view('browser.click', { ok: true, clicked: 'button', label: 'Save', url: 'http://localhost:3000/' })).toBe(true);
    expect(view('browser.scroll', { ok: true, scrollY: 400, maxScrollY: 1200, atTop: false, atBottom: false })).toBe(true);
    expect(view('browser.inspect', { ok: true, selector: '#save', tag: 'button', label: 'Save', styles: { color: 'red' } })).toBe(true);
    expect(view('browser.resize', { viewport: { mode: 'mobile', width: 390, height: 844 } })).toBe(true);
    expect(view('session.status', { sessionId: 'ses_1', sessionStatus: { type: 'asleep' } })).toBe(false);
    // A saved entry with nothing to show keeps the plain output.
    expect(hasOpenChamberView({ ok: true, action: 'knowledge.save', data: {}, errorMessage: undefined })).toBe(false);
    expect(hasOpenChamberView({ ok: true, action: 'knowledge.save', data: { todo: 'broken' }, errorMessage: undefined })).toBe(false);
    expect(hasOpenChamberView({ ok: true, action: 'knowledge.save', data: { todo: { text: 'Node 24' } }, errorMessage: undefined })).toBe(true);
  });
});

describe('tightestWindow', () => {
  const window = (usedPercent: number | null) => ({ usedPercent, remainingPercent: usedPercent === null ? null : 100 - usedPercent, resetAt: null });
  const spend = (spent: number | null) => ({
    usedPercent: null,
    remainingPercent: null,
    resetAt: null,
    value: { kind: 'spend' as const, spent, limit: null },
  });

  test('is the window closest to its limit, skipping ones without a share', () => {
    const provider = { providerId: 'go', ok: true, usage: { windows: { '5h': window(1), weekly: window(82), credits: window(null) } } };
    expect(tightestWindow(provider)?.key).toBe('weekly');
    expect(tightestWindow({ providerId: 'x', ok: true, usage: { windows: { credits: window(null) } } })).toBeNull();
    expect(tightestWindow({ providerId: 'x', ok: false, usage: null })).toBeNull();
  });

  test('falls back to the monthly total for an uncapped monthly key', () => {
    const provider = {
      providerId: 'openrouter',
      ok: true,
      usage: { windows: { monthly_total: spend(226.64), monthly_credits: spend(14.3) } },
    };
    expect(tightestWindow(provider)?.key).toBe('monthly_total');
  });

  test('keeps a cap ahead of the monthly total', () => {
    const provider = {
      providerId: 'openrouter',
      ok: true,
      usage: { windows: { monthly: window(82), monthly_total: spend(5) } },
    };
    expect(tightestWindow(provider)?.key).toBe('monthly');
  });

  test('a threshold-zero cap still outranks the monthly total', () => {
    const provider = {
      providerId: 'openrouter',
      ok: true,
      usage: {
        windows: {
          monthly: { ...window(null), valueLabel: '$0.00 / $0.00' },
          monthly_total: spend(5),
        },
      },
    };
    expect(tightestWindow(provider)?.key).toBe('monthly');
  });

  test('a set cap with an unreadable amount still outranks the monthly total', () => {
    const provider = {
      providerId: 'openrouter',
      ok: true,
      usage: {
        windows: {
          monthly_total: spend(5),
          key_limit: { ...window(null), value: { kind: 'spend' as const, spent: null, limit: 30 } },
        },
      },
    };
    expect(tightestWindow(provider)?.key).toBe('key_limit');
  });

  test('shows a readable OpenRouter counter when the monthly total is unknown', () => {
    const provider = {
      providerId: 'openrouter',
      ok: true,
      usage: { windows: { monthly_total: spend(null), monthly_credits: spend(3.18) } },
    };
    expect(tightestWindow(provider)?.key).toBe('monthly_credits');
  });

  test('keeps the generic rule for another provider with a monthly_total window', () => {
    const requests = (count: number) => ({ ...window(null), value: { kind: 'requests' as const, count } });
    const provider = {
      providerId: 'ext-quota',
      ok: true,
      usage: { windows: { daily: requests(12), monthly_total: requests(300) } },
    };
    expect(tightestWindow(provider)).toBeNull();
  });
});

describe('secretRowView', () => {
  type RunData = { answer: { status: string; outcome?: string; exitCode?: number | null } | { answered: false; reason: string }; stdout?: string; stderr?: string; error?: string };
  const run = (data: RunData) => secretRowView({ ok: true, action: 'secret.run', data });
  test('says how the run ended and joins what it printed', () => {
    expect(run({ answer: { status: 'ran', outcome: 'exited', exitCode: 0 }, stdout: 'token is [secret:T]\n', stderr: 'warn\n' }))
      .toEqual({ key: 'chat.toolPart.openchamber.action.secretRun', output: 'token is [secret:T]\nwarn' });
    expect(run({ answer: { status: 'ran', outcome: 'exited', exitCode: 2 }, stdout: '' }))
      .toEqual({ key: 'chat.toolPart.openchamber.action.secretRunFailed', code: 2, output: '' });
    expect(run({ answer: { status: 'ran', outcome: 'timeout', exitCode: null }, error: 'did not finish' })?.key).toBe('chat.toolPart.openchamber.action.secretRunTimedOut');
    expect(run({ answer: { status: 'ran', outcome: 'not-started', exitCode: null } })?.key).toBe('chat.toolPart.openchamber.action.secretRunNotStarted');
    expect(run({ answer: { status: 'declined' } })?.key).toBe('chat.toolPart.openchamber.action.secretRunDeclined');
    expect(run({ answer: { answered: false, reason: 'chat' } })?.key).toBe('chat.toolPart.openchamber.action.secretRunNotRun');
  });

  test('names the values a finished run could not save', () => {
    expect(secretRowView({ ok: true, action: 'secret.run', data: { answer: { status: 'ran', outcome: 'exited', exitCode: 0 }, notSaved: ['API_TOKEN'] } }))
      .toEqual({ key: 'chat.toolPart.openchamber.action.secretRun', output: '', notSaved: ['API_TOKEN'] });
  });

  test('leaves other answers alone', () => {
    expect(secretRowView({ ok: true, action: 'memory.save', data: { answer: { status: 'saved' } } })).toBeNull();
    expect(secretRowView({ ok: false, action: 'secret.run' })).toBeNull();
    expect(secretRowView(null)).toBeNull();
  });
});

describe('secretRowView for secret.request', () => {
  const request = (answer: { status: string; file?: string } | { answered: false; reason: string }) => secretRowView({ ok: true, action: 'secret.request', data: { answer } });
  test('says how the request ended and names the saved file', () => {
    expect(request({ status: 'saved', file: '/data/secrets/abc' })).toEqual({ key: 'chat.toolPart.openchamber.action.secretRequestSaved', file: '/data/secrets/abc' });
    expect(request({ status: 'declined' })?.key).toBe('chat.toolPart.openchamber.action.secretRequestDeclined');
    expect(request({ answered: false, reason: 'chat' })?.key).toBe('chat.toolPart.openchamber.action.secretRequestNotGiven');
  });
});
