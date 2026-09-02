export type DetachedMarkdownDomKey = {
  scope: string;
  id: string;
  locale: string;
  directory: string;
};

export type DetachedMarkdownDom = DetachedMarkdownDomKey & {
  // The fragment owns the original nodes. take() consumes it once by moving
  // those nodes back into a renderer; nothing is cloned or serialized.
  fragment: DocumentFragment;
};

export type DetachedMarkdownDomCacheStats = {
  sessions: number;
  entries: number;
};

// Holds detached, fully decorated Markdown DOM. The cache is intentionally
// small: it accelerates recent-session and reverse-scroll remounts without
// retaining whole session trees or depending on browser-specific byte guesses.
type DetachedMarkdownDomCacheLimits = {
  maxSessions: number;
  maxEntriesPerSession: number;
};

type SessionCache = Map<string, DetachedMarkdownDom>;

const DEFAULT_LIMITS: DetachedMarkdownDomCacheLimits = {
  // Eight buckets cover a broader recent-session working set without
  // coupling eviction to React commit or microtask timing.
  maxSessions: 8,
  maxEntriesPerSession: 4,
};

export class DetachedMarkdownDomCache {
  private readonly maxSessions: number;
  private readonly maxEntriesPerSession: number;
  private readonly sessions = new Map<string, SessionCache>();

  constructor(limits: DetachedMarkdownDomCacheLimits = DEFAULT_LIMITS) {
    this.maxSessions = Math.max(1, limits.maxSessions);
    this.maxEntriesPerSession = Math.max(1, limits.maxEntriesPerSession);
  }

  store(entry: DetachedMarkdownDom): void {
    const sessionKey = entry.scope;
    const entryKey = entry.id;

    let session = this.sessions.get(sessionKey);
    if (session === undefined) {
      session = new Map();
      this.sessions.set(sessionKey, session);
    } else {
      this.refreshSession(sessionKey, session);
    }

    // A part has one DOM version inside its authoritative runtime/session.
    session.delete(entryKey);
    session.set(entryKey, entry);

    while (session.size > this.maxEntriesPerSession) {
      this.removeOldestEntry(session);
    }
    while (this.sessions.size > this.maxSessions) {
      this.removeOldestSession();
    }
  }

  take(key: DetachedMarkdownDomKey): DocumentFragment | null {
    const sessionKey = key.scope;
    const session = this.sessions.get(sessionKey);
    if (!session) return null;
    const entryKey = key.id;

    this.refreshSession(sessionKey, session);
    const entry = session.get(entryKey);
    if (entry === undefined) return null;

    // A mismatched probe (different locale or directory for the same part)
    // must not destroy the entry — the matching renderer may still come for
    // it. Only a real hit transfers ownership out of the cache.
    if (entry.locale !== key.locale || entry.directory !== key.directory) return null;

    // A fragment is a move-only resource; taking it removes cache ownership.
    session.delete(entryKey);
    if (session.size === 0) this.sessions.delete(sessionKey);
    return entry.fragment;
  }

  clear(): void {
    this.sessions.clear();
  }

  stats(): DetachedMarkdownDomCacheStats {
    let entries = 0;
    for (const session of this.sessions.values()) {
      entries += session.size;
    }
    return {
      sessions: this.sessions.size,
      entries,
    };
  }

  private refreshSession(sessionKey: string, session: SessionCache): void {
    this.sessions.delete(sessionKey);
    this.sessions.set(sessionKey, session);
  }

  private removeOldestEntry(session: SessionCache): void {
    const oldestKey = session.keys().next().value;
    if (oldestKey === undefined) return;
    session.delete(oldestKey);
  }

  private removeOldestSession(): void {
    const oldestKey = this.sessions.keys().next().value;
    if (oldestKey === undefined) return;
    this.sessions.delete(oldestKey);
  }
}

export const detachedMarkdownDomCache = new DetachedMarkdownDomCache();
