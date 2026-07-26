import { beforeEach, describe, expect, it } from 'bun:test';
import {
  applyHarnessEventToSnapshot,
  listHarnessBusyStatuses,
  resetHarnessTurnSnapshots,
} from './turn-snapshot.js';
import { mergeHarnessBusyIntoSessionStatuses } from './session-status.js';
import { withHarnessEventDirectory } from './events/emit.js';

describe('withHarnessEventDirectory', () => {
  it('stamps directory onto event properties for SSE routing', () => {
    const stamped = withHarnessEventDirectory({
      type: 'session.status',
      properties: {
        sessionID: 'ses_1',
        status: { type: 'busy' },
      },
    }, '/repo');
    expect(stamped.properties.directory).toBe('/repo');
    expect(stamped.properties.sessionID).toBe('ses_1');
  });

  it('preserves an existing properties.directory', () => {
    const stamped = withHarnessEventDirectory({
      type: 'session.status',
      properties: {
        sessionID: 'ses_1',
        directory: '/kept',
        status: { type: 'busy' },
      },
    }, '/repo');
    expect(stamped.properties.directory).toBe('/kept');
  });
});

describe('mergeHarnessBusyIntoSessionStatuses', () => {
  beforeEach(() => {
    resetHarnessTurnSnapshots();
  });

  it('overlays harness busy onto OpenCode status snapshots', () => {
    applyHarnessEventToSnapshot({
      type: 'session.status',
      properties: { sessionID: 'ses_claude', status: { type: 'busy' } },
    }, '/repo');

    const merged = mergeHarnessBusyIntoSessionStatuses(
      { ses_opencode: { type: 'busy' } },
      '/repo',
    );
    expect(merged).toEqual({
      ses_opencode: { type: 'busy' },
      ses_claude: { type: 'busy' },
    });
    expect(listHarnessBusyStatuses('/repo')).toEqual({
      ses_claude: { type: 'busy' },
    });
  });

  it('does not invent idle harness entries', () => {
    applyHarnessEventToSnapshot({
      type: 'session.status',
      properties: { sessionID: 'ses_claude', status: { type: 'idle' } },
    }, '/repo');
    expect(mergeHarnessBusyIntoSessionStatuses({}, '/repo')).toEqual({});
  });
});
