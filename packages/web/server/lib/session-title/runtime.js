// Session title: Claude harness turns bypass OpenCode session.promptAsync, so
// upstream ensureTitle never runs. This event-driven helper names a Claude-bound
// session once after the first user turn, using the harness transcript snapshot.

const FETCH_TIMEOUT_MS = 5_000;
const TITLE_QUIET_MS = 750;
const USER_TEXT_CHAR_LIMIT = 4_000;
const TITLE_CHAR_LIMIT = 80;

const DEFAULT_TITLE_PATTERNS = [
  /^(New session|Untitled( Session)?)\b/i,
  /^\d{4}-\d{1,2}-\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?(?:\s?(?:AM|PM))?)?$/i,
  /^\d{1,2}\/\d{1,2}\/\d{2,4}(?:,?\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s?(?:AM|PM))?)?$/i,
  /^(?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)?,?\s*(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4}(?:,?\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s?(?:AM|PM))?)?$/i,
];

const buildTitleSystemPrompt = () => [
  'You write concise titles for coding-agent sessions.',
  'Return only the title text.',
  `Maximum ${TITLE_CHAR_LIMIT} characters.`,
  'No quotes, markdown, bullets, code fences, trailing period, or labels like "Title:".',
  'Use the same language as the user message.',
].join('\n');

const isDefaultSessionTitle = (title) => {
  const value = String(title ?? '').trim();
  if (!value) return true;
  return DEFAULT_TITLE_PATTERNS.some((pattern) => pattern.test(value));
};

const extractSessionStatus = (payload) => {
  if (!payload || payload.type !== 'session.status') return null;
  const properties = payload.properties && typeof payload.properties === 'object' ? payload.properties : {};
  const status = properties.status && typeof properties.status === 'object' ? properties.status : {};
  const info = properties.info && typeof properties.info === 'object' ? properties.info : {};
  const sessionId = typeof properties.sessionID === 'string' ? properties.sessionID.trim() : '';
  const type = typeof status.type === 'string'
    ? status.type.trim()
    : (typeof info.type === 'string' ? info.type.trim() : '');
  if (!sessionId || !type) return null;
  const directory = typeof properties.directory === 'string' && properties.directory
    ? properties.directory
    : (typeof info.directory === 'string' ? info.directory : '');
  return { sessionId, type, directory };
};

const extractUserMessage = (payload) => {
  if (!payload || payload.type !== 'message.updated') return null;
  const info = payload.properties?.info;
  if (!info || typeof info !== 'object' || info.role !== 'user') return null;
  if (typeof info.sessionID !== 'string' || !info.sessionID) return null;
  return { sessionId: info.sessionID };
};

const messagePartsToText = (message) => {
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  return parts
    .map((part) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
};

const extractHarnessUserText = (messages) => {
  if (!Array.isArray(messages)) return '';
  return messages
    .filter((message) => message?.info?.role === 'user')
    .map(messagePartsToText)
    .filter(Boolean)
    .join('\n\n')
    .trim()
    .slice(0, USER_TEXT_CHAR_LIMIT);
};

const sanitizeTitle = (value) => {
  let title = String(value ?? '').trim();
  const fenced = title.match(/```(?:text)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) title = fenced[1].trim();
  title = title
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) ?? '';
  title = title
    .replace(/^title\s*:\s*/i, '')
    .replace(/^[-*#\s]+/, '')
    .replace(/^["'`]+|["'`.]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return title.slice(0, TITLE_CHAR_LIMIT).trim();
};

export const createSessionTitleRuntime = ({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  getSmallModelService,
  getHarnessRecentMessages,
  getSessionBinding,
  quietMs = TITLE_QUIET_MS,
}) => {
  const timers = new Map();
  const inflight = new Set();
  const attempted = new Set();
  const sessionsWithUserMessage = new Set();
  const workingSessions = new Set();
  let stopped = false;

  const clearTimer = (sessionId) => {
    const existing = timers.get(sessionId);
    if (existing) {
      clearTimeout(existing.timer);
      timers.delete(sessionId);
    }
  };

  const isClaudeBoundSession = (sessionId) => {
    try {
      return getSessionBinding?.(sessionId)?.harnessId === 'claude-code';
    } catch (error) {
      console.warn('[session-title] binding lookup failed:', error?.message || error);
      return false;
    }
  };

  const openCodeFetch = async (fetchPath, { directory, method = 'GET', body } = {}) => {
    const base = buildOpenCodeUrl(fetchPath, '');
    const url = directory ? `${base}?directory=${encodeURIComponent(directory)}` : base;
    const response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...getOpenCodeAuthHeaders(),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`OpenCode ${method} ${fetchPath} failed with ${response.status}`);
    }
    return response.json().catch(() => null);
  };

  const fetchSession = (sessionId, directory) =>
    openCodeFetch(`/session/${encodeURIComponent(sessionId)}`, { directory });

  const shouldSkipSession = (session) => {
    if (!session || typeof session !== 'object') return true;
    if (typeof session.parentID === 'string' && session.parentID) return true;
    return !isDefaultSessionTitle(session.title);
  };

  const generateTitle = async (sessionId, directory) => {
    if (stopped || attempted.has(sessionId) || !isClaudeBoundSession(sessionId)) return;
    if (!sessionsWithUserMessage.has(sessionId)) return;

    const session = await fetchSession(sessionId, directory).catch((error) => {
      console.warn('[session-title] session fetch failed:', error?.message || error);
      return null;
    });
    if (shouldSkipSession(session)) return;

    const userText = extractHarnessUserText(
      typeof getHarnessRecentMessages === 'function' ? getHarnessRecentMessages(sessionId) : null,
    );
    if (!userText) return;

    attempted.add(sessionId);
    const { generateSmallModelText } = await getSmallModelService();
    let generated;
    try {
      generated = await generateSmallModelText({
        prompt: `User message text:\n\n${userText}\n\nWrite a concise session title.`,
        system: buildTitleSystemPrompt(),
        maxOutputTokens: 32,
        directory,
      });
    } catch (error) {
      if (Number(error?.statusCode) !== 404) {
        console.warn('[session-title] generation failed:', error?.message || error);
      }
      return;
    }
    if (stopped) return;

    const title = sanitizeTitle(generated?.text);
    if (!title) return;

    const freshSession = await fetchSession(sessionId, directory).catch((error) => {
      console.warn('[session-title] fresh session fetch failed:', error?.message || error);
      return null;
    });
    if (shouldSkipSession(freshSession)) return;
    if (stopped) return;

    await openCodeFetch(`/session/${encodeURIComponent(sessionId)}`, {
      directory,
      method: 'PATCH',
      body: { title },
    });
    console.log(`[session-title] generated for ${sessionId} via ${generated?.providerID ?? 'unknown'}/${generated?.modelID ?? 'unknown'}`);
  };

  const armTimer = (sessionId, directory) => {
    if (stopped || attempted.has(sessionId) || inflight.has(sessionId)) return;
    if (!isClaudeBoundSession(sessionId)) return;
    clearTimer(sessionId);
    const timer = setTimeout(() => {
      timers.delete(sessionId);
      if (stopped || inflight.has(sessionId)) return;
      inflight.add(sessionId);
      generateTitle(sessionId, directory)
        .catch((error) => {
          console.warn('[session-title] failed:', error?.message || error);
        })
        .finally(() => {
          inflight.delete(sessionId);
        });
    }, quietMs);
    if (typeof timer?.unref === 'function') timer.unref();
    timers.set(sessionId, { timer });
  };

  const processHarnessPayload = (payload, directoryHint = '') => {
    if (stopped) return;

    const userMessage = extractUserMessage(payload);
    if (userMessage) {
      if (!attempted.has(userMessage.sessionId) && isClaudeBoundSession(userMessage.sessionId)) {
        sessionsWithUserMessage.add(userMessage.sessionId);
        if (!workingSessions.has(userMessage.sessionId)) {
          armTimer(userMessage.sessionId, directoryHint);
        }
      }
      return;
    }

    const status = extractSessionStatus(payload);
    if (!status) return;
    if (status.type === 'idle') {
      workingSessions.delete(status.sessionId);
      if (sessionsWithUserMessage.has(status.sessionId)) {
        armTimer(status.sessionId, status.directory || directoryHint);
      }
      return;
    }
    workingSessions.add(status.sessionId);
    clearTimer(status.sessionId);
  };

  const stop = () => {
    stopped = true;
    for (const { timer } of timers.values()) {
      clearTimeout(timer);
    }
    timers.clear();
    inflight.clear();
    attempted.clear();
    sessionsWithUserMessage.clear();
    workingSessions.clear();
  };

  return { processHarnessPayload, stop };
};
