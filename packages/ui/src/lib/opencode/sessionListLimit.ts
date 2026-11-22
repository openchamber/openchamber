/**
 * OpenCode rejects a session.list `limit` above this with a 400 ("Expected a
 * value less than or equal to 200"), which fails the whole list. Its own
 * module so tests that mock the OpenCode client still see it.
 */
export const SESSION_LIST_MAX_LIMIT = 200;
