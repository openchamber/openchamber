import type { OpencodeClient, Session } from "@opencode-ai/sdk/v2";
import { runBackgroundNetworkTask } from '@/lib/background-network';
import { retry } from "@/sync/retry";
import { stripSessionListDetails } from "@/sync/sanitize";
import { startSessionLoadPerformanceEvent } from "@/sync/session-load-performance";
import { getOpenChamberInternalSessionGeneration, rememberOpenChamberInternalSession } from '@/lib/sessionInternalMetadata';
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

const toNumber = (value: string | null): number | null => {
    if (!value) {
        return null;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
};

const readResponseHeader = (response: { headers?: Headers } | undefined, header: string): string | null => (
    response?.headers?.get(header) ?? null
);

const unwrapSessionList = (
    result: Awaited<ReturnType<OpencodeClient["experimental"]["session"]["list"]>>,
    operation: string,
): GlobalSessionRecord[] => {
    if ("error" in result && result.error) {
        const status = result.response?.status;
        const detail = result.error instanceof Error ? result.error.message : JSON.stringify(result.error);
        const error = new Error(`${operation} failed${status ? ` (${status})` : ""}: ${detail}`);
        if (status !== undefined) {
            // SAFETY: status is an intentional local extension used by retry callers.
            (error as Error & { status?: number }).status = status;
        }
        throw error;
    }

    if (!Array.isArray(result.data)) {
        const error = new Error(`${operation} returned no data`);
        // SAFETY: status is an intentional local extension used by retry callers.
        (error as Error & { status?: number }).status = 503;
        throw error;
    }

    return result.data;
};

/**
 * OpenCode's `archived` query flag means "also include archived sessions", not
 * "return only archived sessions": the server simply drops its
 * `time_archived IS NULL` condition. Callers that ask for the archived list
 * expect archived-only records, so narrow the response here, at the data
 * boundary, instead of leaving every consumer to re-derive it.
 */
const isArchivedSession = (session: GlobalSessionRecord): boolean => Boolean(session.time?.archived);

/**
 * Split an inclusive (`archived: true`) session page stream into active and
 * archived buckets. Restored sessions carry `time.archived === 0` (see
 * `UNARCHIVED_TIMESTAMP` in `sync/session-actions.ts`); the truthiness check
 * classifies them as active even though the server's own
 * `time_archived IS NULL` filter would still exclude them, which is why the
 * global cache must split client-side instead of issuing an
 * `archived: false` request for its active list.
 */
export const splitGlobalSessionsByArchived = <T extends GlobalSessionRecord>(
    sessions: T[],
) => {
    const active: T[] = [];
    const archived: T[] = [];
    for (const session of sessions) {
        if (isArchivedSession(session)) archived.push(session);
        else active.push(session);
    }
    return { active, archived };
};

export async function listGlobalSessionPages(
    apiClient: OpencodeClient,
    options: {
        directory?: string;
        archived: boolean;
        /**
         * When `archived` is true, narrow results to records carrying a truthy
         * `time.archived` (default true). Pass false to receive the inclusive
         * server response unfiltered, e.g. to split active/archived locally.
         */
        narrowToArchived?: boolean;
        roots?: boolean;
        pageSize: number;
        onPage?: (sessions: GlobalSessionRecord[]) => void;
    },
): Promise<GlobalSessionRecord[]> {
    const all: GlobalSessionRecord[] = [];
    const seenIds = new Set<string>();
    let cursor: number | undefined;
    const narrowToArchived = options.narrowToArchived !== false;
    let operation: string;
    if (!options.directory) {
        operation = `global-sessions.${options.archived ? (narrowToArchived ? "archived" : "all") : "active"}`;
    } else if (options.roots === true) {
        operation = "bootstrap.sessions.roots";
    } else if (options.archived) {
        operation = narrowToArchived ? "bootstrap.sessions.archived" : "bootstrap.sessions.all";
    } else {
        operation = "bootstrap.sessions.all";
    }
    while (true) {
        let attempts = 0;
        const finishPerformanceEvent = startSessionLoadPerformanceEvent({
            operation,
            caller: cursor === undefined ? "initial-page" : "pagination",
        });
        const { response, payload, internalSessionGeneration } = await runBackgroundNetworkTask(() => retry(
            async () => {
                attempts += 1;
                const internalSessionGeneration = getOpenChamberInternalSessionGeneration();
                const request: Parameters<typeof apiClient.experimental.session.list>[0] = {
                    archived: options.archived,
                    limit: options.pageSize,
                };
                if (options.directory) request.directory = options.directory;
                if (options.roots !== undefined) request.roots = options.roots;
                if (cursor !== undefined) request.cursor = cursor;
                const response = await apiClient.experimental.session.list(request);
                const payload = unwrapSessionList(response, "experimental.session.list")
                    .map((session) => stripSessionListDetails(session));
                return { response, payload, internalSessionGeneration };
            },
            { attempts: 3, delay: 500, retryIf: () => true },
        )).catch((error) => {
            finishPerformanceEvent("error", { retryCount: Math.max(0, attempts - 1) });
            throw error;
        });

        finishPerformanceEvent("complete", {
            retryCount: Math.max(0, attempts - 1),
            recordCount: payload.length,
        });
        if (payload.length === 0) break;

        // `appended` tracks pagination progress over the raw response, while
        // `accepted` holds the records this call actually returns. Filtering
        // must not feed the pagination guards below, otherwise a page that is
        // full upstream but mostly non-archived would look like a last page.
        let appended = 0;
        const accepted: GlobalSessionRecord[] = [];
        for (const session of payload) {
            if (!session?.id || seenIds.has(session.id)) continue;
            seenIds.add(session.id);
            appended += 1;
            if (rememberOpenChamberInternalSession(session, internalSessionGeneration)) continue;
            if (options.archived && narrowToArchived && !isArchivedSession(session)) continue;
            all.push(session);
            accepted.push(session);
        }
        if (accepted.length > 0) {
            options.onPage?.(accepted);
        }

        // Stop on partial page — nothing more to fetch.
        if (payload.length < options.pageSize) break;

        // Prefer server header; fall back to last session's `time.updated`
        // (cursor semantics on server = "updated strictly before this timestamp").
        const headerCursor = toNumber(readResponseHeader(response.response, "x-next-cursor"));
        const lastUpdated = payload[payload.length - 1]?.time?.updated;
        const nextCursor = headerCursor
            ?? (Number.isFinite(lastUpdated) ? lastUpdated : undefined);

        if (nextCursor === undefined) break;
        // Loop guard: cursor must move backwards in time.
        if (cursor !== undefined && nextCursor >= cursor) break;
        // Every id in this page already seen — stop to avoid spinning.
        if (appended === 0) break;

        cursor = nextCursor;
    }

    return all;
}
