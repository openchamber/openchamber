import React from "react";
import type { Session } from "@opencode-ai/sdk/v2";
import { opencodeClient } from "@/lib/opencode/client";
import {
  computeSessionModelBreakdown,
  type SessionModelBreakdown,
  type MessageModelUsageInput,
} from "@/lib/analytics/aggregate";
import {
  sessionModelUsageCache,
  processedSessionFingerprints,
  setSessionModelUsage,
  markSessionProcessed,
} from "@/lib/analytics/session-model-usage-cache";

const CONCURRENCY = 6;
const BATCH_UPDATE_SIZE = 15;

type SdkMessagesResponse = {
  data?: Array<{ info: { role?: string } & Record<string, unknown> }>;
  error?: unknown;
};

/**
 * Load per-message model usage for analytics sessions.
 *
 * Fetches assistant messages for each session via the opencode SDK and computes
 * a per-model token/cost/reasoning breakdown. Loading is bounded by a
 * concurrency limit and progressive — the returned map grows in batches so the
 * UI can refine model attribution incrementally.
 *
 * Sessions whose messages fail to load are left un-processed and retried on
 * the next page open; until then they fall back to session-level model
 * attribution inside aggregateAnalytics.
 *
 * Results are cached module-wide keyed by `sessionId:time.updated`, so
 * re-opening the page reuses previously fetched breakdowns.
 */
export function useSessionModelUsage(
  sessions: readonly Session[],
): {
  modelUsage: ReadonlyMap<string, SessionModelBreakdown>;
} {
  const [modelUsage, setModelUsage] = React.useState<
    ReadonlyMap<string, SessionModelBreakdown>
  >(new Map());

  const sessionFingerprint = React.useMemo(
    () => sessions.map((s) => `${s.id}:${s.time?.updated ?? 0}`).join("\n"),
    [sessions],
  );

  React.useEffect(() => {
    const cache = sessionModelUsageCache;
    const processed = processedSessionFingerprints;

    const toLoad: Session[] = [];
    for (const session of sessions) {
      const fp = `${session.id}:${session.time?.updated ?? 0}`;
      if (!processed.has(fp) && !cache.has(session.id)) {
        toLoad.push(session);
      }
    }

    if (toLoad.length === 0) {
      if (cache.size > 0 && modelUsage.size !== cache.size) {
        setModelUsage(new Map(cache));
      }
      return;
    }

    let cancelled = false;
    const totalToLoad = toLoad.length;

    let loaded = 0;
    let index = 0;

    const flushBatch = () => {
      if (cancelled) return;
      setModelUsage(new Map(cache));
    };

    const worker = async () => {
      const client = opencodeClient.getSdkClient();
      while (index < toLoad.length) {
        if (cancelled) return;
        const session = toLoad[index++];
        const fp = `${session.id}:${session.time?.updated ?? 0}`;
        try {
          const directory = session.directory || undefined;
          const response = (await client.session.messages({
            sessionID: session.id,
            ...(directory ? { directory } : {}),
          })) as SdkMessagesResponse;
          if (cancelled) return;
          const records = response.data;
          if (records && Array.isArray(records)) {
            const inputs: MessageModelUsageInput[] = [];
            for (const record of records) {
              const info = record.info;
              if (!info || info.role !== "assistant") continue;
              const pid = info.providerID as string | undefined;
              const mid = info.modelID as string | undefined;
              if (!pid || !mid) continue;
              const tk = info.tokens as
                | {
                    input?: number;
                    output?: number;
                    reasoning?: number;
                    cache?: { read?: number; write?: number };
                  }
                | undefined;
              inputs.push({
                providerID: pid,
                modelID: mid,
                cost: (info.cost as number | undefined) ?? 0,
                tokens: {
                  input: tk?.input ?? 0,
                  output: tk?.output ?? 0,
                  reasoning: tk?.reasoning ?? 0,
                  cache: {
                    read: tk?.cache?.read ?? 0,
                    write: tk?.cache?.write ?? 0,
                  },
                },
              });
            }
            const breakdown = computeSessionModelBreakdown(inputs);
            if (breakdown.size > 0) {
              setSessionModelUsage(session.id, breakdown);
            }
          }
          // Mark processed only for an authoritative success (including a
          // legitimately empty `data: []`). A thrown fetch or a resolved
          // `{ error }` response leaves the session un-processed so a
          // transient failure is retried on the next page open instead of
          // silently degrading to session-level attribution.
          if (!response.error && Array.isArray(records)) {
            markSessionProcessed(fp);
          }
        } catch {
          // Transient failure: leave un-processed so the next mount retries.
        }
        loaded++;
        if (loaded % BATCH_UPDATE_SIZE === 0 || loaded === totalToLoad) {
          flushBatch();
        }
      }
    };

    const workers = Array.from(
      { length: Math.min(CONCURRENCY, toLoad.length) },
      () => worker(),
    );

    Promise.all(workers).then(() => {
      if (!cancelled) {
        flushBatch();
      }
    });

    return () => {
      // Cancellation guards React state and the module cache: workers that
      // resolve after this point early-return before setModelUsage /
      // markSessionProcessed. It does NOT abort the in-flight `session.messages`
      // fetch itself (the wrapped SDK call takes no AbortSignal), so background
      // requests may still complete; and two concurrently-mounted pages can
      // fetch the same unprocessed session. Both are acceptable here because the
      // cache write is idempotent and keyed by session fingerprint.
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionFingerprint]);

  return { modelUsage };
}
