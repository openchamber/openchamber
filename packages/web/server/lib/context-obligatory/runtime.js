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
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
}) => {
  const inflight = new Set();
  let stopped = false;

  const openCodeFetch = async (fetchPath, { directory, method = 'GET', body, query } = {}) => {
    const params = new URLSearchParams(query || {});
    if (directory) params.set('directory', directory);
    const search = params.toString();
    const response = await fetch(`${buildOpenCodeUrl(fetchPath, '')}${search ? `?${search}` : ''}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...getOpenCodeAuthHeaders(),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`OpenCode ${method} ${fetchPath} failed with ${response.status}`);
    return response.json().catch(() => null);
  };

  const tick = async (sessionId, directory) => {
    const session = await openCodeFetch(`/session/${encodeURIComponent(sessionId)}`, { directory });
    if (session?.parentID) return;
    const state = readContextState(session);
    if (state.messages.length === 0) return;

    const recent = await openCodeFetch(`/session/${encodeURIComponent(sessionId)}/message`, {
      directory,
      query: { limit: String(MESSAGE_FETCH_LIMIT) },
    });
    if (!Array.isArray(recent) || recent.length === 0) return;
    const summary = recent.toReversed().find((message) =>
      message?.info?.role === 'assistant' && message.info.summary === true)?.info;
    if (!summary?.id || !summary?.time?.completed) return;
    if (state.openchamber.context_obligatory_last_compaction_message_id === summary.id) return;

    const fetched = await Promise.allSettled(state.messages.map(async (pinned) => {
      const message = await openCodeFetch(
        `/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(pinned.id)}`,
        { directory },
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
    if (entries.length === 0) return;

    const executionInfo = recent.toReversed().find((message) =>
      message?.info?.role === 'assistant' && message.info.summary !== true)?.info;
    const providerID = typeof executionInfo?.providerID === 'string' ? executionInfo.providerID : '';
    const modelID = typeof executionInfo?.modelID === 'string' ? executionInfo.modelID : '';
    if (!providerID || !modelID) throw new Error('no pre-compaction assistant provider/model');
    const agent = typeof executionInfo.agent === 'string' ? executionInfo.agent : executionInfo.mode;
    await openCodeFetch(`/session/${encodeURIComponent(sessionId)}/prompt_async`, {
      directory,
      method: 'POST',
      body: {
        model: { providerID, modelID },
        ...(typeof agent === 'string' && agent ? { agent } : {}),
        parts: [{ type: 'text', text: buildContextPrompt(entries), synthetic: true }],
      },
    });

    const fresh = await openCodeFetch(`/session/${encodeURIComponent(sessionId)}`, { directory });
    const freshState = readContextState(fresh);
    await openCodeFetch(`/session/${encodeURIComponent(sessionId)}`, {
      directory,
      method: 'PATCH',
      body: {
        metadata: {
          ...freshState.metadata,
          openchamber: {
            ...freshState.openchamber,
            context_obligatory_last_compaction_message_id: summary.id,
          },
        },
      },
    });
  };

  const processPayload = (payload, directoryHint = '') => {
    if (stopped || payload?.type !== 'session.compacted') return;
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
