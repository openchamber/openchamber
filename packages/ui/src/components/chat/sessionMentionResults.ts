import type { Session } from '@/lib/opencode/model';
import { matchesRankQuery, rankByQuery } from '@/lib/search/fuzzySearch';
import { resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';

const SESSION_MENTION_LIMIT = 5;

const isInside = (directory: string | null, root: string): boolean => (
    directory !== null && (directory === root || directory.startsWith(`${root}/`))
);

const isMentionable = (session: Session, currentSessionId: string | null): boolean => (
    !session.parentID && session.id !== currentSessionId && session.title.trim().length > 0
);

export const rankSessionMentions = (
    sessions: readonly Session[],
    query: string,
    options: { currentSessionId: string | null; projectRoot: string | null },
): Session[] => {
    if (!query.trim()) return [];
    const candidates = sessions
        .filter((session) => isMentionable(session, options.currentSessionId))
        .sort((a, b) => b.time.updated - a.time.updated);
    const ranked = rankByQuery(candidates, query, (session) => [session.title], { fuzzy: false });
    const root = options.projectRoot;
    if (!root) return ranked.slice(0, SESSION_MENTION_LIMIT);
    const inProject = ranked.filter((session) => isInside(resolveGlobalSessionDirectory(session), root));
    const elsewhere = ranked.filter((session) => !isInside(resolveGlobalSessionDirectory(session), root));
    return [...inProject, ...elsewhere].slice(0, SESSION_MENTION_LIMIT);
};

export const hasSessionMention = (
    sessions: readonly Session[],
    query: string,
    currentSessionId: string | null,
): boolean => (
    query.trim().length > 0
    && sessions.some((session) => isMentionable(session, currentSessionId) && matchesRankQuery([session.title], query))
);
