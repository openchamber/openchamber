// external: https://html.spec.whatwg.org/multipage/interaction.html#transient-activation-duration Chromium keeps a page's transient activation for 5 seconds, so a page may open a popup that long after the input that activated it.
export const AGENT_POPUP_WINDOW_MS = 5_000;

export const createBrowserPanelAgentActions = ({ now = Date.now } = {}) => {
  /** @type {WeakMap<object, { sessionId: string | null, endedAt: number | null }>} */
  const actions = new WeakMap();

  return {
    start(contents, sessionId) {
      actions.set(contents, { sessionId, endedAt: null });
    },
    end(contents) {
      const action = actions.get(contents);
      if (action && action.endedAt === null) action.endedAt = now();
    },
    userInput(contents) {
      if (actions.get(contents)?.endedAt != null) actions.delete(contents);
    },
    actingSession(contents) {
      const action = actions.get(contents);
      if (!action) return null;
      if (action.endedAt !== null && now() - action.endedAt >= AGENT_POPUP_WINDOW_MS) {
        actions.delete(contents);
        return null;
      }
      return { sessionId: action.sessionId };
    },
  };
};
