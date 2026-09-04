const FETCH_TIMEOUT_MS = 15_000;
const MESSAGE_FETCH_LIMIT = 20;

const isRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const readContextState = (session) => {
  const metadata = isRecord(session?.metadata) ? session.metadata : {};
  const openchamber = isRecord(metadata.openchamber) ? metadata.openchamber : {};
  const messages = Array.isArray(openchamber.context_obligatory_messages)
    ? openchamber.context_obligatory_messages.filter((item) =>
      isRecord(item)
      && typeof item.id === 'string'
      && typeof item.createdAt === 'number'
      && (item.role === 'user' || item.role === 'assistant'))
    : [];
  return { metadata, openchamber, messages };
};

const buildContextPrompt = (entries) => {
  const timeline = entries.map(({ pinned, text }) => {
    const timestamp = new Date(pinned.createdAt).toISOString();
    return `## ${pinned.role} — ${timestamp}\n\n${text}`;
  }).join('\n\n---\n\n');
  return [
    'The following messages are from the compacted conversation. The user explicitly marked them as important and required in your context. Pay close attention to them; they may have been sent by either the user or you before compaction.',
    'Use them while continuing the pre-compaction work. Do not treat this context restoration as a new standalone task.',
    'If any tasks or next steps remain, do not acknowledge, summarize, or mention this restored context in a separate response. Simply continue the work and use it silently as background context. Do not append a recap of it after completing those tasks. Only if no tasks or next steps remain, give the user a very brief summary of the important restored context in no more than one short paragraph, without lists or a detailed recap.',
    '',
    timeline,
  ].join('\n');
};

export const createContextObligatoryRuntime = ({
  openCodeApi,
  sessionKnowledgeRuntime = null,
}) => {
  const inflight = new Set();
  let stopped = false;

  const tick = async (sessionId, directory) => {
    const session = await openCodeApi.getSession(sessionId, directory, { timeoutMs: FETCH_TIMEOUT_MS });
    if (session?.parentID) return;
    const state = readContextState(session);

    /**
     * Project knowledge rides along with the pinned messages. Compaction takes
     * both away, and both are restored for the same reason, so they travel as
     * one message: two synthetic turns back to back would read as the agent
     * being interrupted twice.
     */
    const knowledge = sessionKnowledgeRuntime
      ? await sessionKnowledgeRuntime
        .resolvePending(
          directory,
          // Compaction removed the previously delivered block, so its stored
          // signature is no longer evidence that the session still carries it.
          '',
          sessionKnowledgeRuntime.readPins(session),
        )
        .catch(() => ({ text: '', signature: '' }))
      : { text: '', signature: '' };

    if (state.messages.length === 0 && !knowledge.text) return;

    const { messages: recent } = await openCodeApi.listMessages(
      { sessionID: sessionId, directory, limit: MESSAGE_FETCH_LIMIT },
      { timeoutMs: FETCH_TIMEOUT_MS },
    );
    if (recent.length === 0) return;
    const summary = recent.toReversed().find((message) =>
      message?.info?.role === 'assistant' && message.info.summary === true)?.info;
    if (!summary?.id || !summary?.time?.completed) return;
    if (state.openchamber.context_obligatory_last_compaction_message_id === summary.id) return;

    const fetched = await Promise.allSettled(state.messages.map(async (pinned) => {
      const message = await openCodeApi.getMessage(
        { sessionID: sessionId, messageID: pinned.id, directory },
        { timeoutMs: FETCH_TIMEOUT_MS },
      );
      const text = Array.isArray(message?.parts)
        ? message.parts.filter((part) => part?.type === 'text' && typeof part.text === 'string')
          .map((part) => part.text.trim()).filter(Boolean).join('\n\n')
        : '';
      return { pinned, text };
    }));
    const entries = fetched
      .filter((result) => result.status === 'fulfilled' && result.value.text)
      .map((result) => result.value)
      .sort((left, right) => left.pinned.createdAt - right.pinned.createdAt);
    if (entries.length === 0 && !knowledge.text) return;

    const executionInfo = recent.toReversed().find((message) =>
      message?.info?.role === 'assistant' && message.info.summary !== true)?.info;
    const providerID = typeof executionInfo?.providerID === 'string' ? executionInfo.providerID : '';
    const modelID = typeof executionInfo?.modelID === 'string' ? executionInfo.modelID : '';
    if (!providerID || !modelID) throw new Error('no pre-compaction assistant provider/model');
    const agent = typeof executionInfo.agent === 'string' ? executionInfo.agent : executionInfo.mode;
    await openCodeApi.sendPrompt({
      sessionID: sessionId,
      directory,
      model: { providerID, modelID },
      ...(typeof agent === 'string' && agent ? { agent } : {}),
      parts: [{
        type: 'text',
        text: [knowledge.text, entries.length > 0 ? buildContextPrompt(entries) : '']
          .filter(Boolean)
          .join('\n\n---\n\n'),
        synthetic: true,
      }],
    });

    await openCodeApi.mergeSessionMetadata(sessionId, directory, (metadata) => {
      const freshState = readContextState({ metadata });
      return {
        ...freshState.metadata,
        openchamber: {
          ...freshState.openchamber,
          context_obligatory_last_compaction_message_id: summary.id,
          // Recorded together with the cursor: the session now carries this
          // knowledge again, so the next send must not repeat it.
          ...(knowledge.signature
            ? { [sessionKnowledgeRuntime.metadataKey]: knowledge.signature }
            : {}),
        },
      };
    }, { timeoutMs: FETCH_TIMEOUT_MS });
  };

  const processPayload = (payload, directoryHint = '') => {
    if (stopped || !openCodeApi.supportsSessionMetadata() || payload?.type !== 'session.compacted') return;
    const sessionId = payload?.properties?.sessionID;
    if (typeof sessionId !== 'string' || inflight.has(sessionId)) return;
    const directory = payload?.properties?.directory || directoryHint;
    inflight.add(sessionId);
    return tick(sessionId, directory)
      .catch((error) => console.warn('[context-obligatory] injection failed:', error?.message || error))
      .finally(() => inflight.delete(sessionId));
  };

  const stop = () => {
    stopped = true;
  };

  return { processPayload, stop };
};
