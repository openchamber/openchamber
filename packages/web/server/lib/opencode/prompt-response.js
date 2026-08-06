const formatError = (error) => {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error.message === 'string') return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

const isHtmlResponse = (response) =>
  (response?.headers?.get?.('content-type') || '').toLowerCase().includes('text/html');

export const assertPromptResponse = async (response, operation = 'prompt') => {
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`${operation} failed (${response.status})${body ? `: ${body}` : ''}`);
  }
  if (isHtmlResponse(response)) {
    throw new Error(`${operation} failed: runtime returned HTML instead of an API response`);
  }
};

export const assertPromptSdkResult = (result, operation = 'prompt') => {
  const status = result?.response?.status;
  if (result?.error) {
    throw new Error(`${operation} failed${status ? ` (${status})` : ''}: ${formatError(result.error)}`);
  }
  if (isHtmlResponse(result?.response)) {
    throw new Error(`${operation} failed: runtime returned HTML instead of an API response`);
  }
};
