function statusEvent(sessionID, status) {
  return { type: 'session.status', properties: { sessionID, status } };
}

function idleEvent(sessionID) {
  return { type: 'session.idle', properties: { sessionID } };
}

export function createPiEventAdapter({ state }) {
  const activeTurns = new Map();

  const ensureTurn = (sessionID, directory, event) => {
    const turnID = event.id || `turn_${Date.now()}`;
    const key = `${sessionID}:${turnID}`;
    const current = activeTurns.get(key);
    if (current) return current;

    const created = state.ensureAssistantTextPart({ sessionID, turnID });
    const turn = { turnID, messageID: created.message.id, partID: created.part.id };
    activeTurns.set(key, turn);

    state.publish(directory, { type: 'message.updated', properties: { info: created.message } });
    state.publish(directory, { type: 'message.part.updated', properties: { sessionID, part: created.part } });
    return turn;
  };

  const appendText = (sessionID, directory, event) => {
    const turn = ensureTurn(sessionID, directory, event);
    const delta = event.text || '';
    if (!delta) return;

    state.appendTextDelta({ messageID: turn.messageID, partID: turn.partID, delta });
    state.publish(directory, {
      type: 'message.part.delta',
      properties: {
        sessionID,
        messageID: turn.messageID,
        partID: turn.partID,
        field: 'text',
        delta,
      },
    });
  };

  const finishTurn = (sessionID, directory, event) => {
    const turnID = event?.id
      ? event.id
      : Array.from(activeTurns.keys()).find((key) => key.startsWith(`${sessionID}:`))?.split(':')[1];

    if (!turnID) return;
    const key = `${sessionID}:${turnID}`;
    const turn = activeTurns.get(key);
    if (!turn) return;

    const message = state.finishAssistantMessage({ messageID: turn.messageID });
    if (message) {
      state.publish(directory, { type: 'message.updated', properties: { info: message } });
    }
    activeTurns.delete(key);
  };

  return {
    apply(sessionID, directory, event) {
      switch (event?.type) {
        case 'turn_start':
          state.setStatus(sessionID, { type: 'busy' });
          state.publish(directory, statusEvent(sessionID, { type: 'busy' }));
          return;
        case 'message_start':
          ensureTurn(sessionID, directory, event);
          return;
        case 'message_update':
        case 'thinking_update':
          appendText(sessionID, directory, event);
          return;
        case 'tool_call_start':
          appendText(sessionID, directory, {
            ...event,
            text: `\n\n[tool:${event.toolName || 'unknown'}] ${event.toolArgs || ''}\n`,
          });
          return;
        case 'tool_call_update':
          appendText(sessionID, directory, { ...event, text: event.text || '' });
          return;
        case 'tool_call_end':
          appendText(sessionID, directory, {
            ...event,
            text: `\n[tool-result] ${event.toolResult || ''}${event.isToolError ? ' (error)' : ''}\n`,
          });
          return;
        case 'message_end':
          finishTurn(sessionID, directory, event);
          return;
        case 'turn_end':
          finishTurn(sessionID, directory, event);
          state.setStatus(sessionID, { type: 'idle' });
          state.publish(directory, idleEvent(sessionID));
          return;
        case 'error':
          appendText(sessionID, directory, {
            ...event,
            text: `\n\nError: ${event.error || 'Unknown Pi-Harness error'}\n`,
          });
          finishTurn(sessionID, directory, event);
          state.setStatus(sessionID, { type: 'idle' });
          state.publish(directory, { type: 'session.error', properties: { sessionID } });
          return;
        default:
          return;
      }
    },
  };
}
