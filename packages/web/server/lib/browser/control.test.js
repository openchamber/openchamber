import { describe, expect, it } from 'bun:test';
import {
  BROWSER_AGENT_CONTROLLING_CODE,
  BrowserAgentControllingError,
  claimAgentBrowserControl,
  claimUserBrowserControl,
  createEmptyBrowserControl,
  resolveBrowserControlForAction,
  serializeBrowserControl,
} from './control.js';

describe('browser control ownership', () => {
  it('claims agent control with a session id', () => {
    const next = claimAgentBrowserControl(createEmptyBrowserControl(), 'ses_1', () => 42);
    expect(next).toEqual({ actor: 'agent', sessionId: 'ses_1', claimedAt: 42 });
  });

  it('ignores blank agent session ids', () => {
    const empty = createEmptyBrowserControl();
    expect(claimAgentBrowserControl(empty, '  ')).toEqual(serializeBrowserControl(empty));
  });

  it('requires takeover while an agent holds control', () => {
    const agent = claimAgentBrowserControl(createEmptyBrowserControl(), 'ses_busy', () => 1);
    expect(() => resolveBrowserControlForAction(agent, { actor: 'user' })).toThrow(BrowserAgentControllingError);
    try {
      resolveBrowserControlForAction(agent, { actor: 'user' });
    } catch (error) {
      expect(error.code).toBe(BROWSER_AGENT_CONTROLLING_CODE);
      expect(error.sessionId).toBe('ses_busy');
    }
  });

  it('lets the user take over an agent-held browser', () => {
    const agent = claimAgentBrowserControl(createEmptyBrowserControl(), 'ses_busy', () => 1);
    const resolved = resolveBrowserControlForAction(agent, { actor: 'user', takeover: true }, () => 9);
    expect(resolved.previous).toEqual(agent);
    expect(resolved.control).toEqual(claimUserBrowserControl(() => 9));
  });

  it('lets the agent reclaim after user control', () => {
    const user = claimUserBrowserControl(() => 2);
    const resolved = resolveBrowserControlForAction(user, { actor: 'agent', sessionId: 'ses_2' }, () => 3);
    expect(resolved.control).toEqual({ actor: 'agent', sessionId: 'ses_2', claimedAt: 3 });
  });
});
