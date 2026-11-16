import type { Session } from "@/lib/opencode/model";
import type { SessionListOptions, SessionPage } from "@/lib/opencode/client";
import type { SpaceMark } from "@/lib/spaces/spaces-store";
import { runSessionListNetworkTask } from '@/lib/background-network';
import { captureRuntimeInstance } from '@/lib/runtime-switch';
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

const isArchivedSession = (session: GlobalSessionRecord): boolean => Boolean(session.time?.archived);

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

export type SessionPageLister = (options: SessionListOptions) => Promise<SessionPage>;

export async function listGlobalSessionPages(
    listPage: SessionPageLister,
    options: {
        directory?: string;
        parentID?: string;
        pageSize: number;
        onPage?: (sessions: GlobalSessionRecord[]) => void;
        stopAfterPage?: (sessions: GlobalSessionRecord[]) => boolean;
        onSpaces?: (spaces: SpaceMark[] | null) => void;
    },
): Promise<GlobalSessionRecord[]> {
    const all: GlobalSessionRecord[] = [];
    const isCurrent = captureRuntimeInstance();
    const seenIds = new Set<string>();
    const seenCursors = new Set<string>();
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
                if (!isCurrent()) throw new Error('Runtime instance changed');
                attempts += 1;
                return await listPage({
                    ...(options.directory ? { directory: options.directory } : { global: true }),
                    parentID: options.parentID,
                    limit: options.pageSize,
                    ...(cursor !== undefined ? { cursor } : {}),
                });
            }),
            { attempts: 3, delay: 500, retryIf: () => isCurrent() },
        ).catch((error) => {
            finishPerformanceEvent("error", { retryCount: Math.max(0, attempts - 1) });
            throw error;
        });

        if (page === undefined) {
            finishPerformanceEvent("error", { retryCount: Math.max(0, attempts - 1) });
            throw new Error('Runtime instance changed');
        }
        if (cursor === undefined) options.onSpaces?.(page.spaces ?? null);
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
        if (!next) break;
        if (seenCursors.has(next) || accepted.length === 0) {
            throw new Error("Session pagination did not advance; retaining the previous snapshot");
        }
        seenCursors.add(next);
        if (options.stopAfterPage?.(accepted)) break;
        cursor = next;
    }

    return all;
}
