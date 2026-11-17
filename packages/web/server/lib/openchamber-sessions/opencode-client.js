import { OpenCode } from '@opencode/client';
import { assertOpenCodeApiResponse } from '../opencode/prompt-response.js';

// external: https://www.npmjs.com/package/@opencode/client/v/2.3.0 Match the client's percent-encoded directory header so non-ASCII paths work.
const buildDirectoryHeaders = (directory) => {
  const headers = {};
  if (directory) headers['x-opencode-directory'] = encodeURIComponent(directory);
  return headers;
};

export const createOpenCodeClient = ({ baseUrl, headers, directory }) => OpenCode.make({
  baseUrl,
  headers: { ...headers, ...buildDirectoryHeaders(directory) },
  fetch: async (...args) => {
    const response = await globalThis.fetch(...args);
    assertOpenCodeApiResponse(response);
    return response;
  },
});
