import { describe, expect, test } from 'bun:test';

import type { JsonValue } from '@/lib/opencode/model';
import { hasOpenChamberView, parseOpenChamberEnvelope, tightestWindow } from './openChamberToolEnvelope';

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
    // A saved entry with nothing to show keeps the plain output.
    expect(hasOpenChamberView({ ok: true, action: 'knowledge.save', data: {}, errorMessage: undefined })).toBe(false);
    expect(hasOpenChamberView({ ok: true, action: 'knowledge.save', data: { todo: 'broken' }, errorMessage: undefined })).toBe(false);
    expect(hasOpenChamberView({ ok: true, action: 'knowledge.save', data: { todo: { text: 'Node 24' } }, errorMessage: undefined })).toBe(true);
  });
});

describe('tightestWindow', () => {
  const window = (usedPercent: number | null) => ({ usedPercent, remainingPercent: usedPercent === null ? null : 100 - usedPercent, resetAt: null });

  test('is the window closest to its limit, skipping ones without a share', () => {
    const provider = { providerId: 'go', ok: true, usage: { windows: { '5h': window(1), weekly: window(82), credits: window(null) } } };
    expect(tightestWindow(provider)?.key).toBe('weekly');
    expect(tightestWindow({ providerId: 'x', ok: true, usage: { windows: { credits: window(null) } } })).toBeNull();
    expect(tightestWindow({ providerId: 'x', ok: false, usage: null })).toBeNull();
  });
});
