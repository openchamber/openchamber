const isHtmlResponse = (response) =>
  (response?.headers?.get?.('content-type') || '').toLowerCase().includes('text/html');

export const assertPromptResponse = async (response, operation = 'prompt') => {
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`${operation} failed (${response.status})${body ? `: ${body}` : ''}`);
  }
  assertOpenCodeApiResponse(response, operation);
};

/** Keep SDK status/body decoding intact while refusing a successful app shell. */
export const assertOpenCodeApiResponse = (response, operation = 'OpenCode request') => {
  if (response.ok && isHtmlResponse(response)) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error(`${operation} failed: runtime returned HTML instead of an API response`);
  }
};
