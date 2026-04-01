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
    let cursor: number | undefined;

    while (true) {
        const response = await retry(
            () => apiClient.experimental.session.list({
                archived: options.archived,
                limit: options.pageSize,
                ...(cursor ? { cursor } : {}),
            }),
            { attempts: 3, delay: 500, retryIf: () => true },
        );

        const payload = Array.isArray(response.data) ? (response.data as GlobalSessionRecord[]) : [];
        if (payload.length === 0) {
            break;
        }

        all.push(...payload);
        options.onPage?.(payload);

        const nextCursor = toNumber(readResponseHeader(response, "x-next-cursor"));
        if (!nextCursor) {
            break;
        }
        cursor = nextCursor;
    }

    return all;
}
