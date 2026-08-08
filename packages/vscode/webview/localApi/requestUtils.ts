const headersToRecord = (headers: HeadersInit | undefined): Record<string, string> => {
  if (!headers) return {};
  const normalized = new Headers(headers);
  const result: Record<string, string> = {};
  normalized.forEach((value, key) => {
    result[key] = value;
  });
  return result;
};

export const getRequestHeaders = (input?: RequestInfo | URL, init?: RequestInit): Record<string, string> => {
  const headersFromRequest = input instanceof Request ? headersToRecord(input.headers) : {};
  const headersFromInit = headersToRecord(init?.headers);
  return { ...headersFromRequest, ...headersFromInit };
};

export const getRequestDirectoryHint = (url: URL, input?: RequestInfo | URL, init?: RequestInit): string | undefined => {
  const queryDirectory = url.searchParams.get('directory') || undefined;
  if (queryDirectory) return queryDirectory;
  const headers = getRequestHeaders(input, init);
  const directoryEncoding = Object.entries(headers).find(([key]) => key.toLowerCase() === 'x-opencode-directory-encoding')?.[1];
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'x-opencode-directory') {
      // headersToRecord marks encoded directory hints so direct/raw percent
      // sequences from other callers are not decoded accidentally.
      if (directoryEncoding !== 'uri') return value;
      try { return decodeURIComponent(value); } catch { return value; }
    }
  }
  return undefined;
};
