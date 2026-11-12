/**
 * The Content Security Policy every guest document runs under, on top of the
 * `sandbox="allow-scripts"` iframe. It keeps the guest off the network: its
 * own package files load, and `data:`/`blob:` URLs it builds itself, nothing
 * else. Reaching the outside world is the host's job (`request` to the one
 * declared `apiOrigin`, which the user approved), so a guest cannot send what
 * it was shown (conversation, files, model output) anywhere on its own.
 *
 * `connectSource` is where `fetch`/XHR/WebSocket may go: the guest's own
 * package path on the server, or null for none. `'self'` would reach the
 * whole OpenChamber API, which a server without a UI password answers.
 *
 * `origins` are the `contributes.origins` the user approved: the guest may
 * exchange data with them directly (fetch, images, fonts, styles, media).
 * Never scripts or workers: code loaded from elsewhere could change after
 * the extension was approved.
 *
 * Inline and eval stay allowed: they run code, they do not open connections.
 */
export const guestFramePolicy = (connectSource: string | null, origins: readonly string[] = []): string => {
  const approved = origins.length > 0 ? ` ${origins.join(' ')}` : '';
  const local = "'self' data: blob:";
  const connect = [connectSource, ...origins].filter((source): source is string => Boolean(source));
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' ${local}`,
    `style-src 'unsafe-inline' ${local}${approved}`,
    `img-src ${local}${approved}`,
    `font-src ${local}${approved}`,
    `media-src ${local}${approved}`,
    `worker-src ${local}`,
    `frame-src ${local}`,
    `connect-src ${connect.length > 0 ? connect.join(' ') : "'none'"}`,
    "object-src 'none'",
    "form-action 'none'",
  ].join('; ');
};
