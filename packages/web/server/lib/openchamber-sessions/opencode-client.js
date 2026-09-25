import { OpenCode } from '@opencode/client';

/**
 * OpenCode rejects non-ASCII header values; the official client sends this
 * header percent-encoded, so match that wire format (non-ASCII checkout paths
 * such as "Masaüstü" otherwise fail every dispatched prompt). No directory
 * means no header: OpenCode then answers from its default instance, which is
 * enough for lookups keyed by session id.
 */
const buildDirectoryHeaders = (directory) => {
  const headers = {};
  if (directory) headers['x-opencode-directory'] = encodeURIComponent(directory);
  return headers;
};

/** One directory-scoped `@opencode/client` for a session-route call. */
export const createOpenCodeClient = ({ baseUrl, headers, directory }) => OpenCode.make({
  baseUrl,
  headers: { ...headers, ...buildDirectoryHeaders(directory) },
  // Resolved per call so a test (or a runtime that swaps the global) is honoured.
  fetch: (...args) => globalThis.fetch(...args),
});
