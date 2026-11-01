const ENCODED_UNC_PREFIX = /^%2F%2F/i;

/**
 * The directory value OpenCode should read from `x-opencode-directory`.
 *
 * `normalizePath` stores a UNC path as `//host/share/...`. Windows OpenCode
 * collapses that leading pair to one slash, so the location it looks up is
 * `/host/share/...` and the read 404s (`LocationNotFoundError`). The same path
 * with backslashes is the form it resolves. The UI sends the stored form
 * percent-encoded and without the `uri` marker; only that encoded UNC prefix
 * is decoded here, so an unmarked header that contains a literal `%20` stays
 * as the client sent it.
 *
 * A marked header is decoded either way, matching the proxy's existing
 * forward. A path that is not a UNC is returned decoded when marked, and
 * unchanged otherwise.
 */
export const directoryHeaderForOpenCode = (value, marked = false) => {
  const encodedUnc = ENCODED_UNC_PREFIX.test(value);
  let path = value;
  if (marked || encodedUnc) {
    try {
      path = decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  if (path.startsWith('//')) return path.replace(/\//g, '\\');
  if (marked) return path;
  return value;
};

/** Rewrite the directory header on a copy that is about to be sent to OpenCode. */
export const wireForwardedDirectoryHeaders = (headers) => {
  const key = Object.keys(headers).find((name) => name.toLowerCase() === 'x-opencode-directory');
  if (!key) return headers;
  const markerKey = Object.keys(headers).find((name) => name.toLowerCase() === 'x-opencode-directory-encoding');
  const marked = markerKey ? headers[markerKey] === 'uri' : false;
  const wired = directoryHeaderForOpenCode(headers[key], marked);
  if (wired === headers[key] && !marked) return headers;
  headers[key] = wired;
  if (markerKey) delete headers[markerKey];
  return headers;
};
