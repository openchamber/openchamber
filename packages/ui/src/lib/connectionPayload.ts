export type ClientConnectionPayload = {
  v: 1;
  serverUrl: string;
  token: string;
  label?: string;
};

export const buildClientConnectionPayload = (input: {
  serverUrl: string;
  token: string;
  label?: string | null;
}): ClientConnectionPayload => ({
  v: 1,
  serverUrl: input.serverUrl.trim().replace(/\/+$/, ''),
  token: input.token.trim(),
  ...(input.label?.trim() ? { label: input.label.trim() } : {}),
});

export const encodeClientConnectionPayload = (payload: ClientConnectionPayload): string => {
  const params = new URLSearchParams();
  params.set('v', String(payload.v));
  params.set('server', payload.serverUrl);
  params.set('token', payload.token);
  if (payload.label) params.set('label', payload.label);
  return `openchamber://connect?${params.toString()}`;
};

export const parseClientConnectionPayload = (value: string): ClientConnectionPayload | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'openchamber:' || url.hostname !== 'connect') {
      return null;
    }
    const version = url.searchParams.get('v');
    const serverUrl = url.searchParams.get('server')?.trim() || '';
    const token = url.searchParams.get('token')?.trim() || '';
    const label = url.searchParams.get('label')?.trim() || '';

    if (version !== '1' || !serverUrl || !token) {
      return null;
    }

    try {
      const parsedServer = new URL(serverUrl);
      if (parsedServer.protocol !== 'http:' && parsedServer.protocol !== 'https:') {
        return null;
      }
    } catch {
      return null;
    }

    return buildClientConnectionPayload({ serverUrl, token, label });
  } catch {
    return null;
  }
};
