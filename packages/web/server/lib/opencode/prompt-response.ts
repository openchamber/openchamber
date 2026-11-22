import { readBoundedResponseText } from '../shared/response-body.js';

// The error surface only ever shows a short excerpt, so the body read is
// capped well above the excerpt instead of buffering the whole answer.
const ERROR_DETAIL_MAX_BYTES = 1_024;
const ERROR_DETAIL_EXCERPT_CHARS = 200;

const isHtmlResponse = (response: Pick<Response, 'headers'>) =>
  (response?.headers?.get?.('content-type') || '').toLowerCase().includes('text/html');

export const assertPromptResponse = async (response: Response, operation = 'prompt') => {
  if (!response.ok) {
    const read = await readBoundedResponseText(response, ERROR_DETAIL_MAX_BYTES)
      .catch(() => ({ tooLarge: true } as const));
    const body = read.tooLarge ? '' : read.text;
    throw new Error(`${operation} failed (${response.status})${body ? `: ${body.slice(0, ERROR_DETAIL_EXCERPT_CHARS)}` : ''}`);
  }
  assertOpenCodeApiResponse(response, operation);
};

export const assertOpenCodeApiResponse = (response: Pick<Response, 'ok' | 'headers' | 'body'>, operation = 'OpenCode request') => {
  if (response.ok && isHtmlResponse(response)) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error(`${operation} failed: runtime returned HTML instead of an API response`);
  }
};
