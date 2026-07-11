import type { OpencodeClient, Session } from "@opencode-ai/sdk/v2";
import { retry } from "@/sync/retry";
import { stripSessionListDetails } from "@/sync/sanitize";

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

export async function listGlobalSessionPages(
    apiClient: OpencodeClient,
    options: {
        directory?: string;
        archived: boolean;
        roots?: boolean;
        /** Include only sessions updated at or after this timestamp. */
        start?: number;
        cursor?: number;
        pageSize: number;
        /** Stop after collecting this many sessions. Omit for a full paginated load. */
        maxItems?: number;
        /** Per-page request budget. The proxy's generic timeout is intentionally much longer. */
        timeoutMs?: number;
        /** Bounded retry budget for this page. Directory cold-start loads use two attempts. */
        retryAttempts?: number;
        signal?: AbortSignal;
        onPage?: (sessions: GlobalSessionRecord[]) => void;
    },
): Promise<GlobalSessionRecord[]> {
    const all: GlobalSessionRecord[] = [];
    const seenIds = new Set<string>();
    let cursor: number | undefined = options.cursor;

    while (true) {
        const remaining = options.maxItems === undefined
            ? options.pageSize
            : Math.max(0, options.maxItems - all.length);
        if (remaining === 0) break;
        const requestLimit = Math.min(options.pageSize, remaining);
        const { response, payload } = await retry(async () => {
            const timeoutSignal = options.timeoutMs === undefined
                ? undefined
                : AbortSignal.timeout(options.timeoutMs);
            const requestSignal = options.signal && timeoutSignal
                ? AbortSignal.any([options.signal, timeoutSignal])
                : options.signal ?? timeoutSignal;
            const result = await apiClient.experimental.session.list({
                ...(options.directory ? { directory: options.directory } : {}),
                archived: options.archived,
                ...(options.roots !== undefined ? { roots: options.roots } : {}),
                ...(options.start !== undefined ? { start: options.start } : {}),
                limit: requestLimit,
                ...(cursor !== undefined ? { cursor } : {}),
            }, requestSignal ? { signal: requestSignal } : undefined);
            return {
                response: result.response,
                // Unwrap inside retry so resolved SDK `{ error }` responses
                // participate in the transient 5xx retry policy.
                payload: unwrapSessionList(result, "experimental.session.list")
                    .map((session) => stripSessionListDetails(session) as GlobalSessionRecord),
            };
        }, { attempts: options.retryAttempts ?? 3, delay: 500 });
        if (payload.length === 0) break;

        let appended = 0;
        for (const session of payload) {
            if (!session?.id || seenIds.has(session.id)) continue;
            seenIds.add(session.id);
            all.push(session);
            appended += 1;
        }
        if (appended > 0) {
            options.onPage?.(payload);
        }
        if (options.maxItems !== undefined && all.length >= options.maxItems) break;

        // Stop on partial page — nothing more to fetch.
        if (payload.length < requestLimit) break;

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
