const commandKey = (message) => `${message.sessionId ?? ''}\0${message.id}`;

export const rejectDevToolsViewportCommands = (state) => {
  for (const pending of state.viewportCommands.values()) pending.reject(new Error('connection closed'));
  state.viewportCommands.clear();
};

export const settleDevToolsViewportCommand = (state, message) => {
  const key = commandKey(message);
  const pending = state.viewportCommands.get(key);
  if (!pending) return;
  state.viewportCommands.delete(key);
  if (Object.hasOwn(message, 'error')) pending.reject(new Error('command failed'));
  else pending.resolve();
};

export const runDevToolsViewportCommand = async ({
  state, message, isCurrent, onViewportOverride, closeWith,
}) => {
  let sent = false;
  try {
    await onViewportOverride(state.viewer, {
      type: 'changed', tabId: state.tabId, sessionId: state.sessionId, devtoolsId: state.devtoolsId,
      apply: () => {
        const key = commandKey(message);
        if (!isCurrent(state) || sent || state.viewportCommands.has(key)) {
          return Promise.reject(new Error('stale viewport command'));
        }
        sent = true;
        return new Promise((resolve, reject) => {
          state.viewportCommands.set(key, { resolve, reject });
          try { state.socket.send(JSON.stringify(message)); } catch (error) {
            state.viewportCommands.delete(key);
            reject(error);
          }
        });
      },
    });
  } catch (error) {
    if (!sent && isCurrent(state)) closeWith(state, 'DEVTOOLS_CONTROL_LOST');
    else if (isCurrent(state) && ['RESIZE_TIMEOUT', 'STALE_ATTACHMENT', 'SUPERSEDED'].includes(error?.code)) {
      closeWith(state, 'DEVTOOLS_CONNECTION_CLOSED');
    }
  }
};
