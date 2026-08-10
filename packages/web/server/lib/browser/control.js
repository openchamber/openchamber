export const BROWSER_AGENT_CONTROLLING_CODE = 'BROWSER_AGENT_CONTROLLING';

const nonEmptyString = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

export const createEmptyBrowserControl = () => ({
  actor: null,
  sessionId: null,
  claimedAt: null,
});

export const serializeBrowserControl = (control) => ({
  actor: control?.actor === 'agent' || control?.actor === 'user' ? control.actor : null,
  sessionId: nonEmptyString(control?.sessionId),
  claimedAt: Number.isFinite(control?.claimedAt) ? control.claimedAt : null,
});

export const claimAgentBrowserControl = (control, sessionId, now = Date.now) => {
  const id = nonEmptyString(sessionId);
  if (!id) return serializeBrowserControl(control);
  return {
    actor: 'agent',
    sessionId: id,
    claimedAt: now(),
  };
};

export const claimUserBrowserControl = (now = Date.now) => ({
  actor: 'user',
  sessionId: null,
  claimedAt: now(),
});

export class BrowserAgentControllingError extends Error {
  constructor(sessionId) {
    super('An agent is controlling the browser');
    this.name = 'BrowserAgentControllingError';
    this.code = BROWSER_AGENT_CONTROLLING_CODE;
    this.sessionId = nonEmptyString(sessionId);
  }
}

/**
 * Resolve the next control snapshot for an action.
 * Agent actions always claim the given session.
 * User actions require an explicit takeover while an agent holds control.
 */
export const resolveBrowserControlForAction = (control, options = {}, now = Date.now) => {
  const actor = options.actor === 'agent' || options.actor === 'user' ? options.actor : 'user';
  const current = serializeBrowserControl(control);

  if (actor === 'agent') {
    return {
      control: claimAgentBrowserControl(current, options.sessionId, now),
      previous: current,
    };
  }

  if (current.actor === 'agent' && options.takeover !== true) {
    throw new BrowserAgentControllingError(current.sessionId);
  }

  if (current.actor === 'agent' || current.actor == null) {
    return {
      control: claimUserBrowserControl(now),
      previous: current,
    };
  }

  return { control: current, previous: current };
};
