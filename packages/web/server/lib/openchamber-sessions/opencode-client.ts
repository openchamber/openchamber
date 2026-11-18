import { OpenCode } from '@opencode/client';
import { assertOpenCodeApiResponse } from '../opencode/prompt-response.js';

const buildDirectoryHeaders = (directory: string | undefined) => {
  const headers: Record<string, string> = {};
  if (directory) headers['x-opencode-directory'] = encodeURIComponent(directory);
  return headers;
};

export interface OpenCodeClientOptions {
  baseUrl: string;
  headers?: Parameters<typeof OpenCode.make>[0]['headers'];
  directory?: string | undefined;
}

export const createOpenCodeClient = ({ baseUrl, headers, directory }: OpenCodeClientOptions) => OpenCode.make({
  baseUrl,
  headers: { ...headers, ...buildDirectoryHeaders(directory) },
  fetch: async (...args) => {
    const response = await globalThis.fetch(...args);
    assertOpenCodeApiResponse(response);
    return response;
  },
});
