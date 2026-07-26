import { beforeEach, describe, expect, it } from 'bun:test';
import {
  bindSession,
  configureSessionBindings,
  resetSessionBindings,
} from './session-bindings.js';
import {
  applyHarnessEventToSnapshot,
  resetHarnessTurnSnapshots,
} from './turn-snapshot.js';
import { mergeHarnessMessagesIntoSessionMessages } from './session-messages.js';

describe('mergeHarnessMessagesIntoSessionMessages', () => {
  beforeEach(() => {
    resetSessionBindings();
    configureSessionBindings({ persist: false, load: true });
    resetHarnessTurnSnapshots();
  });

  it('returns OpenCode messages unchanged for non-Claude sessions', () => {
    const openCode = [{ info: { id: 'msg_1', role: 'user', sessionID: 'ses_oc' }, parts: [] }];
    expect(mergeHarnessMessagesIntoSessionMessages(openCode, 'ses_oc')).toEqual(openCode);
  });

  it('fills empty OpenCode lists from the Claude turn snapshot', () => {
    bindSession({
      sessionId: 'ses_claude',
      harnessId: 'claude-code',
      directory: '/repo',
      target: { harnessId: 'claude-code', modelRef: 'haiku' },
    });
    applyHarnessEventToSnapshot({
      type: 'message.updated',
      properties: {
        info: { id: 'msg_01_user', role: 'user', sessionID: 'ses_claude' },
      },
    }, '/repo');
    applyHarnessEventToSnapshot({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'prt_1',
          sessionID: 'ses_claude',
          messageID: 'msg_01_user',
          type: 'text',
          text: 'hi',
        },
      },
    }, '/repo');
    applyHarnessEventToSnapshot({
      type: 'message.updated',
      properties: {
        info: { id: 'msg_02_asst', role: 'assistant', sessionID: 'ses_claude' },
      },
    }, '/repo');
    applyHarnessEventToSnapshot({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'prt_2',
          sessionID: 'ses_claude',
          messageID: 'msg_02_asst',
          type: 'text',
          text: 'READY1',
        },
      },
    }, '/repo');

    const merged = mergeHarnessMessagesIntoSessionMessages([], 'ses_claude');
    expect(merged).toHaveLength(2);
    expect(merged[0].info.id).toBe('msg_01_user');
    expect(merged[0].parts?.[0]?.text).toBe('hi');
    expect(merged[1].info.id).toBe('msg_02_asst');
    expect(merged[1].parts?.[0]?.text).toBe('READY1');
  });
});
