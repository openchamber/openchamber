import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __testing, classifyOpenChamberInternalSessionEvent, internalSessionMetadata, isOpenChamberInternalSessionEvent } from './internal-sessions.js';

describe('internal session event registry', () => {
  beforeEach(() => __testing.clear());

  it('recognizes metadata-bearing and later id-only events', () => {
    expect(isOpenChamberInternalSessionEvent({
      type: 'session.created', properties: { info: { id: 'ses_1', metadata: internalSessionMetadata() } },
    })).toBe(true);
    expect(isOpenChamberInternalSessionEvent({ type: 'session.status', properties: { sessionID: 'ses_1' } })).toBe(true);
    expect(isOpenChamberInternalSessionEvent({ type: 'session.deleted', properties: { sessionID: 'ses_1' } })).toBe(true);
    expect(isOpenChamberInternalSessionEvent({ type: 'session.status', properties: { sessionID: 'ses_1' } })).toBe(false);
  });

  it('classifies the metadata-bearing delete shape before always forgetting its id', () => {
    const deleted = {
      type: 'session.deleted',
      properties: { info: { id: 'ses_deleted', metadata: internalSessionMetadata() } },
    };
    expect(isOpenChamberInternalSessionEvent(deleted)).toBe(true);
    expect(isOpenChamberInternalSessionEvent({ type: 'session.status', properties: { sessionID: 'ses_deleted' } })).toBe(false);
  });

  it('does not hide ordinary or review sessions', () => {
    expect(isOpenChamberInternalSessionEvent({
      type: 'session.created', properties: { info: { id: 'ses_review', metadata: { openchamber: { kind: 'review' } } } },
    })).toBe(false);
  });

  it('recovers durable metadata for an id-only event after restart', async () => {
    await expect(classifyOpenChamberInternalSessionEvent(
      { type: 'session.status', properties: { sessionID: 'ses_restart' } },
      async () => ({ id: 'ses_restart', metadata: internalSessionMetadata() }),
    )).resolves.toBe(true);
    expect(isOpenChamberInternalSessionEvent({ type: 'message.updated', properties: { info: { sessionID: 'ses_restart' } } })).toBe(true);
  });

  it('deduplicates failed lookups, forwards during the short failure TTL, and retries after reset', async () => {
    let rejectLookup;
    const lookup = vi.fn(() => new Promise((_, reject) => { rejectLookup = reject; }));
    const event = { type: 'session.status', properties: { sessionID: 'ses_outage' } };
    const first = classifyOpenChamberInternalSessionEvent(event, lookup);
    const second = classifyOpenChamberInternalSessionEvent(event, lookup);
    await Promise.resolve();
    expect(lookup).toHaveBeenCalledOnce();
    rejectLookup(new Error('offline'));
    await expect(Promise.all([first, second])).resolves.toEqual([false, false]);
    await expect(classifyOpenChamberInternalSessionEvent(event, lookup)).resolves.toBe(false);
    expect(lookup).toHaveBeenCalledOnce();
    __testing.clear();
    const retry = vi.fn(async () => ({ id: 'ses_outage', metadata: internalSessionMetadata() }));
    await expect(classifyOpenChamberInternalSessionEvent(event, retry)).resolves.toBe(true);
    expect(retry).toHaveBeenCalledOnce();
  });

  it('keeps one underlying lookup after caller timeout and failure TTL expiry', async () => {
    vi.useFakeTimers();
    let resolveLookup;
    const lookup = vi.fn(() => new Promise((resolve) => { resolveLookup = resolve; }));
    const event = { type: 'session.status', properties: { sessionID: 'ses_slow' } };
    const first = classifyOpenChamberInternalSessionEvent(event, lookup);
    await vi.advanceTimersByTimeAsync(300);
    await expect(first).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(2_001);
    const second = classifyOpenChamberInternalSessionEvent(event, lookup);
    await vi.advanceTimersByTimeAsync(300);
    await expect(second).resolves.toBe(false);
    expect(lookup).toHaveBeenCalledOnce();
    resolveLookup({ id: 'ses_slow' });
    await Promise.resolve();
    vi.useRealTimers();
  });

  it('ignores a lookup completion from before registry reset', async () => {
    let resolveLookup;
    const lookup = vi.fn(() => new Promise((resolve) => { resolveLookup = resolve; }));
    const event = { type: 'session.status', properties: { sessionID: 'ses_collision' } };
    const pending = classifyOpenChamberInternalSessionEvent(event, lookup);
    await Promise.resolve();
    __testing.clear();
    resolveLookup({ id: 'ses_collision', metadata: internalSessionMetadata() });
    await expect(pending).resolves.toBe(false);
    expect(isOpenChamberInternalSessionEvent({ type: 'session.status', properties: { sessionID: 'ses_collision' } })).toBe(false);
  });

  it('starts a new-runtime lookup for the same id while the old lookup is still pending', async () => {
    let resolveRuntimeA;
    const runtimeA = vi.fn(() => new Promise((resolve) => { resolveRuntimeA = resolve; }));
    const event = { type: 'session.status', properties: { sessionID: 'ses_same' } };
    const pendingA = classifyOpenChamberInternalSessionEvent(event, runtimeA);
    await Promise.resolve();
    expect(runtimeA).toHaveBeenCalledOnce();

    __testing.clear();
    const runtimeB = vi.fn(async () => ({ id: 'ses_same', metadata: internalSessionMetadata() }));
    await expect(classifyOpenChamberInternalSessionEvent(event, runtimeB)).resolves.toBe(true);
    expect(runtimeB).toHaveBeenCalledOnce();

    resolveRuntimeA({ id: 'ses_same' });
    await expect(pendingA).resolves.toBe(false);
    expect(isOpenChamberInternalSessionEvent({ type: 'session.status', properties: { sessionID: 'ses_same' } })).toBe(true);
  });
});
