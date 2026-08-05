import type { OpencodeClient, Session } from "@opencode-ai/sdk/v2";
import { runBackgroundNetworkTask } from '@/lib/background-network';
import { retry } from "@/sync/retry";
import { stripSessionListDetails } from "@/sync/sanitize";
import { startSessionLoadPerformanceEvent } from "@/sync/session-load-performance";

export type GlobalSessionRecord = Session & {
    project?: {
        id: string;
        name?: string;
        worktree?: string;
    } | null;
};

const toNumber = (value: string | null): number | null => {
    if (!value) {
        return null;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
};

const readResponseHeader = (response: unknown, header: string): string | null => {
    if (!response || typeof response !== "object") {
        return null;
    }
    const container = response as { headers?: unknown };
    const headers = container.headers;
    if (!headers || typeof headers !== "object") {
        return null;
    }

    const maybeGet = headers as { get?: (name: string) => string | null };
    if (typeof maybeGet.get === "function") {
        return maybeGet.get(header);
    }

    const maybeRecord = headers as Record<string, unknown>;
    const direct = maybeRecord[header] ?? maybeRecord[header.toLowerCase()];
    return typeof direct === "string" ? direct : null;
};

const formatSdkError = (error: unknown): string => {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;
    if (error && typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string") {
        return (error as { message: string }).message;
    }
    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
};

const unwrapSessionList = (
    result: { data?: Session[]; error?: unknown; response?: { status?: number } },
    operation: string,
): GlobalSessionRecord[] => {
    if (result.error) {
        const status = result.response?.status;
        const error = new Error(`${operation} failed${status ? ` (${status})` : ""}: ${formatSdkError(result.error)}`);
        if (status !== undefined) {
            (error as Error & { status?: number }).status = status;
        }
        throw error;
    }

    if (!Array.isArray(result.data)) {
        const error = new Error(`${operation} returned no data`);
        (error as Error & { status?: number }).status = 503;
        throw error;
    }

    return result.data as GlobalSessionRecord[];
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
): { active: T[]; archived: T[] } => {
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
        const { response, payload } = await runBackgroundNetworkTask(() => retry(
            async () => {
                attempts += 1;
                const response = await apiClient.experimental.session.list({
                    ...(options.directory ? { directory: options.directory } : {}),
                    archived: options.archived,
                    ...(options.roots !== undefined ? { roots: options.roots } : {}),
                    limit: options.pageSize,
                    ...(cursor !== undefined ? { cursor } : {}),
                });
                const payload = unwrapSessionList(response, "experimental.session.list")
                    .map((session) => stripSessionListDetails(session) as GlobalSessionRecord);
                return { response, payload };
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
        const headerCursor = toNumber(readResponseHeader(response, "x-next-cursor"));
        const lastUpdated = payload[payload.length - 1]?.time?.updated;
        const nextCursor = headerCursor
            ?? (typeof lastUpdated === "number" && Number.isFinite(lastUpdated) ? lastUpdated : undefined);

        if (nextCursor === undefined) break;
        // Loop guard: cursor must move backwards in time.
        if (cursor !== undefined && nextCursor >= cursor) break;
        // Every id in this page already seen — stop to avoid spinning.
        if (appended === 0) break;

        cursor = nextCursor;
    }

    return all;
}
