const JSON_HEADERS = {
  accept: 'application/json',
  'content-type': 'application/json',
};

function joinUrl(baseUrl, path) {
  const url = new URL(path, `${baseUrl.replace(/\/+$/, '')}/`);
  return url.toString();
}

async function readBodyText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

async function parseJsonResponse(response, operation) {
  const text = await readBodyText(response);
  if (!response.ok) {
    const suffix = text ? `: ${text}` : '';
    throw new Error(`Pi-Harness ${operation} failed (${response.status})${suffix}`);
  }
  if (!text) return null;
  return JSON.parse(text);
}

export function createPiHarnessClient({ baseUrl, apiKey = null, fetchImpl = fetch }) {
  const headers = (extra = {}) => ({
    ...extra,
    ...(apiKey ? { 'x-api-key': apiKey } : {}),
  });

  const json = async (method, path, body) => {
    const response = await fetchImpl(joinUrl(baseUrl, path), {
      method,
      headers: headers(JSON_HEADERS),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return parseJsonResponse(response, `${method} ${path}`);
  };

  return {
    health() {
      return json('GET', 'health');
    },
    createSession(body) {
      return json('POST', 'sessions', body ?? {});
    },
    listSessions() {
      return json('GET', 'sessions');
    },
    getSession(sessionId) {
      return json('GET', `sessions/${encodeURIComponent(sessionId)}`);
    },
    deleteSession(sessionId) {
      return json('DELETE', `sessions/${encodeURIComponent(sessionId)}`);
    },
    cancelSession(sessionId) {
      return json('POST', `sessions/${encodeURIComponent(sessionId)}/cancel`, {});
    },
    async sendMessageStream(sessionId, body, { signal } = {}) {
      const response = await fetchImpl(joinUrl(baseUrl, `sessions/${encodeURIComponent(sessionId)}/messages`), {
        method: 'POST',
        headers: headers(JSON_HEADERS),
        body: JSON.stringify(body),
        signal,
      });
      if (!response.ok) {
        const text = await readBodyText(response);
        const suffix = text ? `: ${text}` : '';
        throw new Error(`Pi-Harness POST /sessions/${sessionId}/messages failed (${response.status})${suffix}`);
      }
      return response;
    },
  };
}
