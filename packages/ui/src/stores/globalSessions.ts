import type { OpencodeClient, Session } from "@opencode-ai/sdk/v2";
import { retry } from "@/sync/retry";

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

export const readNextCursor = (response: unknown): number | null => {
    return toNumber(readResponseHeader(response, "x-next-cursor"));
};

export const isMissingGlobalSessionsEndpointError = (error: unknown): boolean => {
    if (!error || typeof error !== "object") {
        return false;
    }

    const value = error as {
        status?: number;
        response?: { status?: number };
        cause?: { status?: number; response?: { status?: number } };
    };

    const status = value.status
        ?? value.response?.status
        ?? value.cause?.status
        ?? value.cause?.response?.status;

    return status === 404;
};

export async function listGlobalSessionPages(
    apiClient: OpencodeClient,
    options: {
        archived: boolean;
        pageSize: number;
        onPage?: (sessions: GlobalSessionRecord[]) => void;
    },
): Promise<GlobalSessionRecord[]> {
    const all: GlobalSessionRecord[] = [];
    const seenIds = new Set<string>();
    let cursor: number | undefined;

    while (true) {
        const response = await retry(
            () => apiClient.experimental.session.list({
                archived: options.archived,
                limit: options.pageSize,
                ...(cursor !== undefined ? { cursor } : {}),
            }),
            { attempts: 3, delay: 500, retryIf: () => true },
        );

        const payload = Array.isArray(response.data) ? (response.data as GlobalSessionRecord[]) : [];
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
