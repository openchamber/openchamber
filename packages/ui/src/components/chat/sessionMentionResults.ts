import type { Session } from '@/lib/opencode/model';
import { rankByQuery } from '@/lib/search/fuzzySearch';
import { resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';

/** Sessions `@` lists at most; the rest are a sharper query away. */
const SESSION_MENTION_LIMIT = 5;

const isInside = (directory: string | null, root: string): boolean => (
    directory !== null && (directory === root || directory.startsWith(`${root}/`))
);

/**
 * The sessions a typed `@query` finds by title, across every project: the
 * open project's first, then the rest, each best match first and the most
 * recently active winning a tie. Only titles that hold the query count, no
 * typo-tolerant guesses: across hundreds of titles one always nearly matches.
 * Nothing before the user types, the session being written in, and subagent
 * runs (they live under their parent) are left out.
 */
export const rankSessionMentions = (
    sessions: readonly Session[],
    query: string,
    options: { currentSessionId: string | null; projectRoot: string | null },
): Session[] => {
    if (!query.trim()) return [];
    const candidates = sessions
        .filter((session) => !session.parentID && session.id !== options.currentSessionId && session.title.trim())
        .sort((a, b) => b.time.updated - a.time.updated);
    const ranked = rankByQuery(candidates, query, (session) => [session.title], { fuzzy: false });
    const root = options.projectRoot;
    if (!root) return ranked.slice(0, SESSION_MENTION_LIMIT);
    const inProject = ranked.filter((session) => isInside(resolveGlobalSessionDirectory(session), root));
    const elsewhere = ranked.filter((session) => !isInside(resolveGlobalSessionDirectory(session), root));
    return [...inProject, ...elsewhere].slice(0, SESSION_MENTION_LIMIT);
};
