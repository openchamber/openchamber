import type { Session } from "@/lib/opencode/model";
import type { SessionListOptions, SessionPage } from "@/lib/opencode/client";
import { runSessionListNetworkTask } from '@/lib/background-network';
import { retry } from "@/sync/retry";
import { stripSessionListDetails } from "@/sync/sanitize";
import { startSessionLoadPerformanceEvent } from "@/sync/session-load-performance";
import { isChatDirectoryPath } from '@/lib/chatDirectories';

export type GlobalSessionRecord = Session & {
    project?: {
        id: string;
        name?: string;
        worktree?: string;
    } | null;
};

export const filterManagedChatsForRuntime = (sessions: Session[], vscode: boolean): Session[] => (
    vscode
        ? sessions.filter((session) => !isChatDirectoryPath(session.directory))
        : sessions
);

/** OpenChamber owns archive state; a session is archived when it carries a timestamp. */
const isArchivedSession = (session: GlobalSessionRecord): boolean => Boolean(session.time?.archived);

/**
 * Split a session list into active and archived buckets. Restored sessions
 * carry `time.archived === 0` (see `UNARCHIVED_TIMESTAMP` in
 * `sync/session-actions.ts`), so the truthiness check classifies them as
 * active.
 */
export const splitGlobalSessionsByArchived = <T extends GlobalSessionRecord>(
    sessions: T[],
): { active: T[]; archived: T[] } => {
    const active: T[] = [];
    const archived: T[] = [];
    for (const session of sessions) {
        if (isArchivedSession(session)) archived.push(session);
        else active.push(session);
    }
    return { active, archived };
};

/** One page request. Injected so callers and tests can supply their own transport. */
export type SessionPageLister = (options: SessionListOptions) => Promise<SessionPage>;

/**
 * Walks every page of a session list and returns the records.
 *
 * v2 lists sessions newest-first and pages by an opaque cursor; it has no
 * archived filter, so callers take the whole list and split it with
 * `splitGlobalSessionsByArchived`.
 */
export async function listGlobalSessionPages(
    listPage: SessionPageLister,
    options: {
        directory?: string;
        pageSize: number;
        onPage?: (sessions: GlobalSessionRecord[]) => void;
    },
): Promise<GlobalSessionRecord[]> {
    const all: GlobalSessionRecord[] = [];
    const seenIds = new Set<string>();
    let cursor: string | undefined;
    const operation = options.directory ? "bootstrap.sessions.all" : "global-sessions.all";

    while (true) {
        let attempts = 0;
        const finishPerformanceEvent = startSessionLoadPerformanceEvent({
            operation,
            caller: cursor === undefined ? "initial-page" : "pagination",
        });
        const page = await retry(
            () => runSessionListNetworkTask(async () => {
                attempts += 1;
                return await listPage({
                    ...(options.directory ? { directory: options.directory } : { global: true }),
                    limit: options.pageSize,
                    ...(cursor !== undefined ? { cursor } : {}),
                });
            }),
            { attempts: 3, delay: 500, retryIf: () => true },
        ).catch((error) => {
            finishPerformanceEvent("error", { retryCount: Math.max(0, attempts - 1) });
            throw error;
        });

        const payload = page.sessions.map((session) => stripSessionListDetails(session) as GlobalSessionRecord);
        finishPerformanceEvent("complete", {
            retryCount: Math.max(0, attempts - 1),
            recordCount: payload.length,
        });

        const accepted: GlobalSessionRecord[] = [];
        for (const session of payload) {
            if (!session?.id || seenIds.has(session.id)) continue;
            seenIds.add(session.id);
            all.push(session);
            accepted.push(session);
        }
        if (accepted.length > 0) {
            options.onPage?.(accepted);
        }

        const next = page.cursor.next;
        // No next cursor, or a page that added nothing new: stop rather than spin.
        if (!next || next === cursor || accepted.length === 0) break;
        cursor = next;
    }

    return all;
}
