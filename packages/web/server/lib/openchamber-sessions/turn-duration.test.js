import { describe, expect, it, vi } from 'vitest';

import { createTurnDurationRecorder } from './turn-duration.js';

const status = (sessionID, type, created) => ({ type: 'session.status', created, properties: { sessionID, status: { type } } });
const idle = (sessionID, created) => ({ type: 'session.idle', created, properties: { sessionID } });

const setup = ({ children = [] } = {}) => {
  const persistSessionMetadataPatch = vi.fn(async () => ({}));
  const recorder = createTurnDurationRecorder({
    persistSessionMetadataPatch,
    isChildSession: (sessionID) => (children.includes(sessionID) ? true : undefined),
  });
  return { recorder, persistSessionMetadataPatch };
};

describe('createTurnDurationRecorder', () => {
  it('records a turn from its first busy event to its end, in OpenCode time', () => {
    const { recorder, persistSessionMetadataPatch } = setup();
    recorder.processPayload(status('ses_a', 'busy', 1_000), '/repo');
    recorder.processPayload(status('ses_a', 'busy', 5_000), '/repo');
    recorder.processPayload(status('ses_a', 'retry', 6_000), '/repo');
    recorder.processPayload(status('ses_a', 'idle', 9_000), '/repo');
    recorder.processPayload(idle('ses_a', 9_000), '/repo');
    expect(persistSessionMetadataPatch).toHaveBeenCalledExactlyOnceWith(
      'ses_a',
      { openchamber: { turn: { endedAt: 9_000, durationMs: 8_000 } } },
      { directory: '/repo' },
    );
  });

  it('records a failed turn too', () => {
    const { recorder, persistSessionMetadataPatch } = setup();
    recorder.processPayload(status('ses_a', 'busy', 1_000));
    recorder.processPayload({ type: 'session.error', created: 4_000, properties: { sessionID: 'ses_a', error: { name: 'Error' } } });
    expect(persistSessionMetadataPatch).toHaveBeenCalledWith('ses_a', { openchamber: { turn: { endedAt: 4_000, durationMs: 3_000 } } }, { directory: '' });
  });

  it('records nothing for a turn it did not see start, or for a subsession', () => {
    const { recorder, persistSessionMetadataPatch } = setup({ children: ['ses_child'] });
    recorder.processPayload(idle('ses_a', 9_000));
    recorder.processPayload(status('ses_child', 'busy', 1_000));
    recorder.processPayload(idle('ses_child', 2_000));
    expect(persistSessionMetadataPatch).not.toHaveBeenCalled();
  });

  it('forgets starts on a reconnect, which may have hidden an end', () => {
    const { recorder, persistSessionMetadataPatch } = setup();
    recorder.processPayload(status('ses_a', 'busy', 1_000));
    recorder.processPayload({ type: 'server.connected', properties: {} });
    recorder.processPayload(idle('ses_a', 9_000));
    recorder.processPayload(status('ses_a', 'busy', 10_000));
    recorder.processPayload(idle('ses_a', 12_000));
    expect(persistSessionMetadataPatch).toHaveBeenCalledExactlyOnceWith(
      'ses_a',
      { openchamber: { turn: { endedAt: 12_000, durationMs: 2_000 } } },
      { directory: '' },
    );
  });

  it('keeps going when a write fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const persistSessionMetadataPatch = vi.fn(async () => { throw new Error('offline'); });
    const recorder = createTurnDurationRecorder({ persistSessionMetadataPatch, isChildSession: () => undefined });
    recorder.processPayload(status('ses_a', 'busy', 1_000));
    recorder.processPayload(idle('ses_a', 2_000));
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
  });
});
