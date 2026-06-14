const DEFAULT_REPLAY_LIMIT = 2048;

const cmp = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

let messageSeq = 0;
let partSeq = 0;

const nextMessageID = (prefix) => `${prefix}_${Date.now()}_${++messageSeq}`;
const nextPartID = (prefix) => `${prefix}_${Date.now()}_${++partSeq}`;

export function createPiHarnessState({ providerID, modelID, replayLimit = DEFAULT_REPLAY_LIMIT } = {}) {
  const sessions = new Map();
  const messages = new Map();
  const parts = new Map();
  const statuses = new Map();
  const activeStreams = new Map();
  const subscribers = new Set();
  const replay = [];
  let eventSeq = 0;

  const publish = (directory, payload) => {
    const eventId = `pi_evt_${++eventSeq}`;
    const entry = {
      envelope: { eventId, directory: directory || 'global' },
      payload: { id: eventId, ...payload },
      directory: directory || 'global',
      eventId,
    };
    replay.push(entry);
    if (replay.length > replayLimit) replay.splice(0, replay.length - replayLimit);
    for (const subscriber of Array.from(subscribers)) subscriber(entry);
    return entry;
  };

  const addMessage = (info, messageParts) => {
    const sessionMessages = messages.get(info.sessionID) || [];
    messages.set(info.sessionID, sessionMessages);
    const existingIndex = sessionMessages.findIndex((message) => message.id === info.id);
    if (existingIndex >= 0) sessionMessages[existingIndex] = info;
    else sessionMessages.push(info);
    sessionMessages.sort(cmp);
    parts.set(info.id, messageParts);
    return { info, parts: messageParts };
  };

  return {
    publish,
    subscribe(subscriber) {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
    replayAfter(eventId) {
      if (!eventId) return [];
      const index = replay.findIndex((entry) => entry.eventId === eventId);
      return index === -1 ? [] : replay.slice(index + 1);
    },
    upsertSession({ sessionId, createdAt, workspaceDir, title } = {}) {
      if (!sessionId) throw new Error('sessionId is required');
      const existing = sessions.get(sessionId);
      const created = existing?.time?.created ?? (createdAt ? new Date(createdAt).getTime() : Date.now());
      const info = {
        id: sessionId,
        parentID: undefined,
        title: title || existing?.title || 'Pi Session',
        time: { created, updated: Date.now() },
        directory: workspaceDir || existing?.directory || '',
        metadata: {
          ...(existing?.metadata || {}),
          backend: 'pi-harness',
          workspaceDir: workspaceDir || existing?.metadata?.workspaceDir || '',
        },
      };
      sessions.set(sessionId, info);
      if (!statuses.has(sessionId)) statuses.set(sessionId, { type: 'idle' });
      return info;
    },
    listSessions() {
      return Array.from(sessions.values()).sort((a, b) => (b.time.updated || 0) - (a.time.updated || 0));
    },
    getSession(sessionID) {
      return sessions.get(sessionID) || null;
    },
    deleteSession(sessionID) {
      const existed = sessions.delete(sessionID);
      messages.delete(sessionID);
      statuses.delete(sessionID);
      this.abortActiveStream(sessionID);
      return existed;
    },
    getStatusMap() {
      return Object.fromEntries(statuses.entries());
    },
    setStatus(sessionID, status) {
      statuses.set(sessionID, status);
      return status;
    },
    getStatus(sessionID) {
      return statuses.get(sessionID) || { type: 'idle' };
    },
    addUserMessage({ sessionID, messageID, text }) {
      const info = {
        id: messageID || nextMessageID('pi_user'),
        sessionID,
        role: 'user',
        time: { created: Date.now() },
        model: { providerID, modelID },
      };
      const textPart = {
        id: nextPartID('pi_user_text'),
        sessionID,
        messageID: info.id,
        type: 'text',
        text: text || '',
      };
      return addMessage(info, [textPart]);
    },
    ensureAssistantTextPart({ sessionID, turnID }) {
      const messageID = `pi_assistant_${sessionID}_${turnID || nextMessageID('turn')}`;
      const partID = `pi_text_${sessionID}_${turnID || nextPartID('turn')}`;
      const existing = messages.get(sessionID)?.find((message) => message.id === messageID);
      if (existing) {
        return { message: existing, part: (parts.get(messageID) || [])[0] };
      }
      const message = {
        id: messageID,
        sessionID,
        role: 'assistant',
        time: { created: Date.now() },
        model: { providerID, modelID },
      };
      const part = { id: partID, sessionID, messageID, type: 'text', text: '' };
      addMessage(message, [part]);
      return { message, part };
    },
    appendTextDelta({ messageID, partID, delta }) {
      const list = parts.get(messageID) || [];
      const part = list.find((entry) => entry.id === partID);
      if (part) part.text = `${part.text || ''}${delta || ''}`;
      return part || null;
    },
    finishAssistantMessage({ messageID }) {
      for (const [, list] of messages.entries()) {
        const message = list.find((entry) => entry.id === messageID);
        if (message) {
          message.time = { ...message.time, completed: Date.now() };
          message.finish = 'stop';
          return message;
        }
      }
      return null;
    },
    getMessages(sessionID) {
      return (messages.get(sessionID) || []).sort(cmp).map((info) => ({
        info,
        parts: parts.get(info.id) || [],
      }));
    },
    setActiveStream(sessionID, controller) {
      activeStreams.set(sessionID, controller);
    },
    clearActiveStream(sessionID, controller) {
      if (!controller || activeStreams.get(sessionID) === controller) activeStreams.delete(sessionID);
    },
    abortActiveStream(sessionID) {
      const controller = activeStreams.get(sessionID);
      if (!controller) return false;
      activeStreams.delete(sessionID);
      if (!controller.signal.aborted) controller.abort();
      return true;
    },
  };
}
