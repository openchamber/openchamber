export const buildRestartNotification = ({ sessionIds, autoResumeSessionIds }) => {
  if (sessionIds.length === 0) return null;
  const autoResume = autoResumeSessionIds.length === sessionIds.length;
  const multiple = sessionIds.length > 1;
  return {
    title: multiple ? 'Chats interrupted' : 'Chat interrupted',
    body: autoResume
      ? (multiple
          ? 'OpenCode restarted during running responses. The chats will resume automatically; send a message in each chat if one does not.'
          : 'OpenCode restarted during a running response. The chat will resume automatically; send a message if it does not.')
      : (multiple
          ? 'OpenCode restarted during running responses. Send a message in each chat to continue.'
          : 'OpenCode restarted during a running response. Send a message to continue.'),
    tag: 'opencode-restart-interrupted',
    kind: autoResume ? 'opencode-restart-resuming' : 'opencode-restart-interrupted',
    sessionId: sessionIds[0],
  };
};
