/**
 * The message search index: one SQLite file in the OpenChamber data dir.
 *
 * `messages` holds the searchable text of settled user messages and agent
 * replies; `messages_fts` is an external-content FTS5 index over it, kept by
 * triggers. The trigram tokenizer matches any three or more characters inside
 * a word, in any script, so "світ" finds "світу" and CJK text needs no word
 * segmentation. `sessions` remembers where each session's reading stopped.
 *
 * The file is derived data. A schema change drops and rebuilds it.
 */

const MESSAGE_SEARCH_SCHEMA_VERSION = '2';

// Private-use characters around each match in a snippet. They cannot occur in
// ordinary text and are not markup, so a snippet is never rendered as HTML.
export const MATCH_START = '';
export const MATCH_END = '';

const MIN_TERM_LENGTH = 3;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    directory TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT 0,
    revert_id TEXT,
    user_cursor TEXT,
    assistant_cursor TEXT,
    synced_updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS messages (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    message_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    text TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_by_session ON messages (session_id, created_at);
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    text, content='messages', content_rowid='seq', tokenize='trigram'
  );
  CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts (rowid, text) VALUES (new.seq, new.text);
  END;
  CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.seq, old.text);
  END;
  CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF text ON messages BEGIN
    INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.seq, old.text);
    INSERT INTO messages_fts (rowid, text) VALUES (new.seq, new.text);
  END;
`;

const DROP = `
  DROP TRIGGER IF EXISTS messages_ai;
  DROP TRIGGER IF EXISTS messages_ad;
  DROP TRIGGER IF EXISTS messages_au;
  DROP TABLE IF EXISTS messages_fts;
  DROP TABLE IF EXISTS messages;
  DROP TABLE IF EXISTS sessions;
  DROP TABLE IF EXISTS meta;
`;

const characterLength = (value) => Array.from(value).length;

/**
 * A query as FTS5 understands it: every word must occur, each matched
 * literally. Words shorter than the trigram window cannot be looked up and are
 * left out; a query made only of them has no answer rather than every answer.
 */
export const toSearchTerms = (query) => String(query ?? '')
  .trim()
  .split(/\s+/)
  .filter((term) => characterLength(term) >= MIN_TERM_LENGTH);

export const toMatchExpression = (query) => {
  const terms = toSearchTerms(query);
  if (terms.length === 0) return null;
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' AND ');
};

const SNIPPET_RADIUS = 90;

/**
 * The part of a message around a match, every match in it marked.
 * FTS5's own snippet() counts trigrams, not words, and cuts a hit to a few
 * characters, so the window is taken here, on the text of the hits only.
 * Matching is case-insensitive the same way the trigram index is; where
 * lowercasing changes a string's length (rare scripts), offsets would drift,
 * so that text is returned unmarked.
 */
export const buildSnippet = (text, terms, radius = SNIPPET_RADIUS) => {
  const lower = text.toLowerCase();
  if (lower.length !== text.length) return text.slice(0, radius * 2);
  const ranges = [];
  for (const term of terms) {
    const needle = term.toLowerCase();
    for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + needle.length)) {
      ranges.push([at, at + needle.length]);
    }
  }
  if (ranges.length === 0) return text.slice(0, radius * 2);
  ranges.sort((left, right) => left[0] - right[0]);
  const merged = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
    else merged.push([...range]);
  }
  // Centre on the longest word: in "git rebase" the rare one says more than
  // the short one that also matches inside "github".
  const longest = terms.reduce((best, term) => (term.length > best.length ? term : best), '').toLowerCase();
  const anchorAt = lower.indexOf(longest);
  const anchor = merged.find(([from, to]) => from <= anchorAt && anchorAt < to) ?? merged[0];
  let start = Math.max(0, anchor[0] - radius);
  let end = Math.min(text.length, anchor[1] + radius);
  // Whole words at the edges read better than a cut one.
  if (start > 0) {
    const space = text.lastIndexOf(' ', anchor[0]);
    if (space > start) start = space + 1;
  }
  if (end < text.length) {
    const space = text.indexOf(' ', end);
    if (space >= 0 && space - end < 20) end = space;
  }
  let out = start > 0 ? '…' : '';
  let cursor = start;
  for (const [from, to] of merged) {
    if (to <= start || from >= end) continue;
    out += text.slice(cursor, Math.max(cursor, from)) + MATCH_START + text.slice(Math.max(from, cursor), Math.min(to, end)) + MATCH_END;
    cursor = Math.min(to, end);
  }
  out += text.slice(cursor, end) + (end < text.length ? '…' : '');
  return out.replace(/\s+/g, ' ');
};

export const openMessageSearchStore = (connection) => {
  const version = (() => {
    try {
      return connection.get('SELECT value FROM meta WHERE key = ?', ['schema'])?.value ?? null;
    } catch {
      return null;
    }
  })();
  if (version !== MESSAGE_SEARCH_SCHEMA_VERSION) connection.exec(DROP);
  connection.exec('PRAGMA journal_mode = WAL');
  connection.exec(SCHEMA);
  connection.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', ['schema', MESSAGE_SEARCH_SCHEMA_VERSION]);

  const readSession = (sessionId) => connection.get(
    'SELECT id, directory, title, revert_id, user_cursor, assistant_cursor, synced_updated_at FROM sessions WHERE id = ?',
    [sessionId],
  );

  return {
    readSession,

    upsertSession: ({ id, directory, title, createdAt }) => {
      connection.run(
        `INSERT INTO sessions (id, directory, title, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET directory = excluded.directory, title = excluded.title`,
        [id, directory, title ?? '', createdAt ?? 0],
      );
    },

    renameSession: (sessionId, title) => {
      connection.run('UPDATE sessions SET title = ? WHERE id = ?', [title, sessionId]);
    },

    moveSession: (sessionId, directory) => {
      connection.run('UPDATE sessions SET directory = ? WHERE id = ?', [directory, sessionId]);
    },

    /** Forgets what was read, for a session whose history changed under the cursors. */
    resetSession: (sessionId, revertId) => {
      connection.transaction(() => {
        connection.run('DELETE FROM messages WHERE session_id = ?', [sessionId]);
        connection.run(
          'UPDATE sessions SET revert_id = ?, user_cursor = NULL, assistant_cursor = NULL, synced_updated_at = NULL WHERE id = ?',
          [revertId, sessionId],
        );
      });
    },

    deleteSession: (sessionId) => {
      connection.transaction(() => {
        connection.run('DELETE FROM messages WHERE session_id = ?', [sessionId]);
        connection.run('DELETE FROM sessions WHERE id = ?', [sessionId]);
      });
    },

    /** Messages are immutable once settled; a re-read replaces nothing it does not change. */
    putMessages: (rows) => {
      if (rows.length === 0) return;
      connection.transaction(() => {
        for (const row of rows) {
          connection.run(
            `INSERT INTO messages (id, message_id, session_id, role, created_at, text) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET text = excluded.text WHERE text <> excluded.text`,
            [row.id, row.messageId ?? row.id, row.sessionId, row.role, row.createdAt, row.text],
          );
        }
      });
    },

    setCursor: (sessionId, role, cursor) => {
      const column = role === 'user' ? 'user_cursor' : 'assistant_cursor';
      connection.run(`UPDATE sessions SET ${column} = ? WHERE id = ?`, [cursor, sessionId]);
    },

    markSynced: (sessionId, updatedAt) => {
      connection.run('UPDATE sessions SET synced_updated_at = ? WHERE id = ?', [updatedAt, sessionId]);
    },

    readMeta: (key) => connection.get('SELECT value FROM meta WHERE key = ?', [key])?.value ?? null,

    writeMeta: (key, value) => {
      connection.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [key, value]);
    },

    /** Drops every row of one kind, e.g. reasoning once it is no longer indexed. */
    deleteRole: (role) => {
      connection.run('DELETE FROM messages WHERE role = ?', [role]);
    },

    /**
     * Makes the next walk read every session's agent records again from the
     * start (user messages keep their cursor): what is indexed from them changed.
     */
    rereadAssistantRecords: () => {
      connection.run('UPDATE sessions SET assistant_cursor = NULL, synced_updated_at = NULL');
    },

    sessionIds: () => connection.all('SELECT id FROM sessions').map((row) => row.id),

    counts: () => ({
      sessions: connection.get('SELECT count(*) AS n FROM sessions')?.n ?? 0,
      messages: connection.get('SELECT count(*) AS n FROM messages')?.n ?? 0,
    }),

    /**
     * Newest matches first. `before` pages by creation time (with the message
     * id breaking ties), so a page boundary never repeats or skips a hit.
     */
    search: ({ match, sessionId = null, directories = [], role = null, includeReasoning = true, before = null, limit, order = 'desc' }) => {
      const where = ['messages_fts MATCH ?'];
      const params = [match];
      if (sessionId) {
        where.push('m.session_id = ?');
        params.push(sessionId);
      }
      if (directories.length > 0) {
        where.push(`s.directory IN (${directories.map(() => '?').join(', ')})`);
        params.push(...directories);
      }
      if (role) {
        where.push('m.role = ?');
        params.push(role);
      }
      if (!includeReasoning) where.push("m.role <> 'reasoning'");
      if (before) {
        where.push(order === 'desc'
          ? '(m.created_at < ? OR (m.created_at = ? AND m.id < ?))'
          : '(m.created_at > ? OR (m.created_at = ? AND m.id > ?))');
        params.push(before.createdAt, before.createdAt, before.id);
      }
      const direction = order === 'desc' ? 'DESC' : 'ASC';
      params.push(limit);
      return connection.all(
        `SELECT m.id AS rowId, m.message_id AS id, m.session_id AS sessionId, m.role AS role, m.created_at AS createdAt,
                s.title AS sessionTitle, s.directory AS directory, m.text AS text
         FROM messages_fts
         JOIN messages m ON m.seq = messages_fts.rowid
         JOIN sessions s ON s.id = m.session_id
         WHERE ${where.join(' AND ')}
         ORDER BY m.created_at ${direction}, m.id ${direction}
         LIMIT ?`,
        params,
      );
    },

    close: () => connection.close(),
  };
};
