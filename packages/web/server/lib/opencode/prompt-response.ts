const isHtmlResponse = (response: Pick<Response, 'headers'>) =>
  (response?.headers?.get?.('content-type') || '').toLowerCase().includes('text/html');

export const assertPromptResponse = async (response: Response, operation = 'prompt') => {
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`${operation} failed (${response.status})${body ? `: ${body}` : ''}`);
  }
  assertOpenCodeApiResponse(response, operation);
};

export const assertOpenCodeApiResponse = (response: Pick<Response, 'ok' | 'headers' | 'body'>, operation = 'OpenCode request') => {
  if (response.ok && isHtmlResponse(response)) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error(`${operation} failed: runtime returned HTML instead of an API response`);
  }
};
