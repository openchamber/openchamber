/**
 * OpenCode 2.x wraps `/api/*` answers in an envelope, and not always the same
 * one: a single record (`GET /api/session/:id`, one message) comes back as
 * `{ data }`, some routes (`/api/command`) as `{ location, data }`, and pages
 * as `{ data, cursor }`. Records and plain lists are unwrapped; a page keeps
 * its envelope because callers read its cursor.
 *
 * Unwrapping only when `location` was present left record envelopes in place,
 * so a session's `parentID` and a message's `id` read as missing.
 */
export const unwrapOpenCodeResponse = (body) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  return 'data' in body && !('cursor' in body) ? body.data : body;
};
