import React from 'react';
import { useI18n } from '@/lib/i18n';
import { opencodeClient } from '@/lib/opencode/client';
import type { Message } from '@/lib/opencode/model';
import { useSessionMessagesSelector, useSessionStatus } from '@/sync/sync-context';
import type { TurnSnapshotDiff } from './turnSnapshotDiff';

const EMPTY_DIFFS: TurnSnapshotDiff[] = [];

const selectTranscriptKey = (messages: Message[]): string => {
    const last = messages[messages.length - 1];
    if (!last) return '';
    const completed = last.role === 'assistant' ? last.time.completed ?? '' : '';
    return `${last.id}:${completed}`;
};

type LastTurnDiff = {
    diffs: TurnSnapshotDiff[];
    count: number | null;
    loaded: boolean;
    settled: boolean;
    error: string | null;
    retry: () => void;
};

export function useLastTurnDiff(
    sessionId: string | null,
    directory: string | undefined,
    { enabled, live }: { enabled: boolean; live: boolean },
): LastTurnDiff {
    const { t } = useI18n();
    const transcriptKey = useSessionMessagesSelector(enabled ? sessionId ?? '' : '', directory, selectTranscriptKey);
    const statusType = useSessionStatus(enabled ? sessionId ?? '' : '', directory)?.type;
    const running = statusType !== undefined && statusType !== 'idle';
    const [result, setResult] = React.useState<{ sessionId: string; readKey: string; diffs: TurnSnapshotDiff[] } | null>(null);
    const [failure, setFailure] = React.useState<{ sessionId: string; message: string } | null>(null);
    const [attempt, nextAttempt] = React.useReducer((value: number) => value + 1, 0);
    const retry = React.useCallback(() => {
        setFailure(null);
        nextAttempt();
    }, []);
    const waiting = running && !live;
    const readKey = JSON.stringify([attempt, running, transcriptKey]);

    React.useEffect(() => {
        if (!enabled || !sessionId || waiting) return;
        let cancelled = false;
        void opencodeClient.getSessionTurnDiff(sessionId, { directory })
            .then((files) => {
                if (cancelled) return;
                setResult({
                    sessionId,
                    readKey,
                    diffs: files.map((entry) => ({
                        file: entry.file,
                        patch: entry.patch,
                        status: entry.status,
                        additions: entry.additions,
                        deletions: entry.deletions,
                    })),
                });
                setFailure(null);
            })
            .catch((error) => {
                if (cancelled) return;
                console.warn('[last-turn-diff] turn diff unavailable:', error instanceof Error ? error.message : error);
                setFailure({ sessionId, message: error instanceof Error && error.message ? error.message : t('diffView.state.failedToLoadDiff') });
            });
        return () => {
            cancelled = true;
        };
    }, [directory, enabled, readKey, sessionId, t, waiting]);

    const own = result && result.sessionId === sessionId ? result : null;
    const diffs = own?.diffs ?? EMPTY_DIFFS;
    const error = failure && failure.sessionId === sessionId ? failure.message : null;
    return {
        diffs,
        count: own && !waiting ? diffs.length : null,
        loaded: own !== null,
        settled: own !== null && own.readKey === readKey,
        error,
        retry,
    };
}
