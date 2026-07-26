const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const requiredString = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;

const getOpenChamberMetadata = (metadata) => isRecord(metadata?.openchamber) ? metadata.openchamber : {};

const withDisposableMarker = (metadata, parentSessionID) => ({
  ...(isRecord(metadata) ? metadata : {}),
  openchamber: {
    ...getOpenChamberMetadata(metadata),
    sideChat: { disposable: true, parentSessionID },
  },
});

const withoutDisposableMarker = (metadata) => {
  const normalized = isRecord(metadata) ? metadata : {};
  const openchamber = getOpenChamberMetadata(normalized);
  if (!Object.prototype.hasOwnProperty.call(openchamber, 'sideChat')) return normalized;

  const nextOpenChamber = { ...openchamber };
  delete nextOpenChamber.sideChat;
  const next = { ...normalized };
  if (Object.keys(nextOpenChamber).length > 0) next.openchamber = nextOpenChamber;
  else delete next.openchamber;
  return next;
};

const responseError = async (response, fallback) => {
  const payload = await response.json().catch(() => null);
  return requiredString(payload?.error) ?? requiredString(response.statusText) ?? fallback;
};

const isMarkedSideChat = (session, parentSessionID) => (
  isRecord(session)
  && requiredString(session.id)
  && session.metadata?.openchamber?.sideChat?.disposable === true
  && requiredString(session.metadata.openchamber.sideChat.parentSessionID) === parentSessionID
);

const isPromotedSession = (session, sessionID) => (
  isRecord(session)
  && requiredString(session.id) === sessionID
  && !Object.prototype.hasOwnProperty.call(getOpenChamberMetadata(session.metadata), 'sideChat')
);

export const registerSideChatRoutes = (app, dependencies) => {
  const {
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    resolveProjectDirectory,
    fetch: fetchImpl = globalThis.fetch,
    requestTimeoutMs = 15_000,
    isRequestOriginAllowed,
    jsonParser,
  } = dependencies;
  const creationByParent = new Map();

  const resolveDirectory = async (req, res) => {
    const resolved = await resolveProjectDirectory(req);
    if (!resolved.directory) {
      res.status(400).json({ error: resolved.error || 'Directory is required' });
      return null;
    }
    return resolved.directory;
  };

  const upstreamFetch = (path, directory, { method, body }) => {
    const url = new URL(buildOpenCodeUrl(path, ''));
    url.searchParams.set('directory', directory);
    return fetchImpl(url.toString(), {
      method,
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...getOpenCodeAuthHeaders(),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  };

  const handleFailure = (res, error, fallback) => {
    console.error('[side-chats] request failed', error);
    const timedOut = error?.name === 'TimeoutError' || error?.code === 'ABORT_ERR';
    return res.status(timedOut ? 504 : 502).json({ error: timedOut ? `${fallback} timed out` : fallback });
  };

  const findExistingMarkedSession = async (directory, parentSessionID) => {
    const response = await upstreamFetch('/session?roots=false&limit=500', directory, { method: 'GET' });
    if (!response.ok) {
      throw new Error(await responseError(response, 'Failed to inspect existing side chats'));
    }
    const sessions = await response.json().catch(() => null);
    if (!Array.isArray(sessions)) throw new Error('OpenCode returned an invalid session list');
    const marked = sessions
      .filter((session) => isMarkedSideChat(session, parentSessionID))
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    const retained = marked[0] ?? null;
    for (const duplicate of marked.slice(1)) {
      const deletion = await upstreamFetch(`/session/${encodeURIComponent(duplicate.id)}`, directory, { method: 'DELETE' });
      const confirmed = deletion.status === 404 || (deletion.ok && await deletion.json().catch(() => false) === true);
      if (!confirmed) throw new Error(`Failed to reconcile duplicate side chat ${duplicate.id}`);
    }
    return retained;
  };

  const createSideChat = async (directory, parentSessionID, messageID) => {
    const existing = await findExistingMarkedSession(directory, parentSessionID);
    if (existing) return { status: 200, payload: existing };

    const forkResponse = await upstreamFetch(
      `/session/${encodeURIComponent(parentSessionID)}/fork`,
      directory,
      { method: 'POST', body: { messageID } },
    );
    if (!forkResponse.ok) {
      return { status: forkResponse.status, payload: { error: await responseError(forkResponse, 'Failed to fork session') } };
    }

    const fork = await forkResponse.json().catch(() => null);
    const forkSessionID = requiredString(fork?.id);
    if (!forkSessionID) {
      return { status: 502, payload: { error: 'OpenCode returned an invalid fork session' } };
    }

    const markerResponse = await upstreamFetch(
      `/session/${encodeURIComponent(forkSessionID)}`,
      directory,
      { method: 'PATCH', body: { metadata: withDisposableMarker(fork.metadata, parentSessionID) } },
    );
    let markerError;
    if (markerResponse.ok) {
      const marked = await markerResponse.json().catch(() => null);
      if (requiredString(marked?.id) === forkSessionID && isMarkedSideChat(marked, parentSessionID)) {
        const retained = await findExistingMarkedSession(directory, parentSessionID);
        if (!retained) throw new Error('Marked side chat was missing during duplicate reconciliation');
        return { status: retained.id === forkSessionID ? 201 : 200, payload: retained };
      }
      markerError = 'OpenCode returned an invalid marked side chat';
    } else {
      markerError = await responseError(markerResponse, 'Failed to mark disposable side chat');
    }

    let cleanupResponse;
    try {
      cleanupResponse = await upstreamFetch(
        `/session/${encodeURIComponent(forkSessionID)}`,
        directory,
        { method: 'DELETE' },
      );
    } catch (error) {
      return {
        status: 502,
        payload: {
          error: 'Failed to mark disposable side chat and delete the fork',
          cleanupRequired: true,
          forkSessionID,
          markerError,
          cleanupError: error?.name === 'TimeoutError' ? 'Fork deletion timed out' : 'Failed to delete fork',
        },
      };
    }
    const cleanupConfirmed = cleanupResponse.status === 404
      || (cleanupResponse.ok && await cleanupResponse.json().catch(() => false) === true);
    if (cleanupConfirmed) {
      return { status: markerResponse.ok ? 502 : markerResponse.status, payload: { error: markerError } };
    }

    return {
      status: 502,
      payload: {
        error: 'Failed to mark disposable side chat and delete the fork',
        cleanupRequired: true,
        forkSessionID,
        markerError,
        cleanupError: cleanupResponse.ok
          ? 'OpenCode did not confirm fork deletion'
          : await responseError(cleanupResponse, 'Failed to delete fork'),
      },
    };
  };

  const runCreateForParent = (directory, parentSessionID, messageID) => {
    const key = JSON.stringify([directory, parentSessionID]);
    const previous = creationByParent.get(key) ?? Promise.resolve();
    const creation = previous.catch(() => undefined).then(() => createSideChat(directory, parentSessionID, messageID));
    creationByParent.set(key, creation);
    return creation.finally(() => {
      if (creationByParent.get(key) === creation) creationByParent.delete(key);
    });
  };

  const handleCreateSideChat = async (req, res) => {
    try {
      if (typeof isRequestOriginAllowed === 'function' && !await isRequestOriginAllowed(req)) {
        return res.status(403).json({ error: 'Request origin is not allowed' });
      }
      const parentSessionID = requiredString(req.body?.parentSessionID);
      if (!parentSessionID) return res.status(400).json({ error: 'parentSessionID is required' });
      const messageID = requiredString(req.body?.messageID);
      if (!messageID) return res.status(400).json({ error: 'messageID is required' });

      const directory = await resolveDirectory(req, res);
      if (!directory) return undefined;

      const result = await runCreateForParent(directory, parentSessionID, messageID);
      return res.status(result.status).json(result.payload);
    } catch (error) {
      return handleFailure(res, error, 'Failed to create side chat');
    }
  };

  const promoteSideChat = async (req, res) => {
    try {
      if (typeof isRequestOriginAllowed === 'function' && !await isRequestOriginAllowed(req)) {
        return res.status(403).json({ error: 'Request origin is not allowed' });
      }
      const sessionID = requiredString(req.params?.sessionId);
      if (!sessionID) return res.status(400).json({ error: 'sessionId is required' });
      const directory = await resolveDirectory(req, res);
      if (!directory) return undefined;

      const sessionResponse = await upstreamFetch(
        `/session/${encodeURIComponent(sessionID)}`,
        directory,
        { method: 'GET' },
      );
      if (!sessionResponse.ok) {
        return res.status(sessionResponse.status).json({ error: await responseError(sessionResponse, 'Failed to read side chat') });
      }

      const session = await sessionResponse.json().catch(() => null);
      if (!isRecord(session)) return res.status(502).json({ error: 'OpenCode returned an invalid session' });
      const metadata = isRecord(session.metadata) ? session.metadata : {};
      const promotedMetadata = withoutDisposableMarker(metadata);
      if (promotedMetadata === metadata) {
        if (requiredString(session.id) !== sessionID) return res.status(502).json({ error: 'OpenCode returned an invalid promoted session' });
        return res.json(session);
      }

      const updateResponse = await upstreamFetch(
        `/session/${encodeURIComponent(sessionID)}`,
        directory,
        { method: 'PATCH', body: { metadata: promotedMetadata } },
      );
      if (!updateResponse.ok) {
        return res.status(updateResponse.status).json({ error: await responseError(updateResponse, 'Failed to promote side chat') });
      }
      const promoted = await updateResponse.json().catch(() => null);
      if (!isPromotedSession(promoted, sessionID)) {
        return res.status(502).json({ error: 'OpenCode returned an invalid promoted session' });
      }
      return res.json(promoted);
    } catch (error) {
      return handleFailure(res, error, 'Failed to promote side chat');
    }
  };

  app.post('/api/openchamber/side-chats', ...(jsonParser ? [jsonParser] : []), handleCreateSideChat);
  app.post('/api/openchamber/side-chats/:sessionId/promote', ...(jsonParser ? [jsonParser] : []), promoteSideChat);
};
