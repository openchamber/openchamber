import * as z from 'zod/mini';

export const sourceStateSchema = z.enum(['ready', 'partial', 'missing', 'unsupported', 'error']);
export type SourceState = z.infer<typeof sourceStateSchema>;

export const cacheCauseSchema = z.enum(['emergency', 'threshold', 'materialized', 'compaction', 'cache', 'unknown']);
export type CacheCause = z.infer<typeof cacheCauseSchema>;

export const cacheEventSchema = z.object({
  at: z.nullable(z.string()),
  inputTokens: z.nullable(z.number()),
  cacheRead: z.nullable(z.number()),
  cacheWrite: z.nullable(z.number()),
  totalTokens: z.nullable(z.number()),
  hitRatio: z.nullable(z.number()),
  cause: z.nullable(cacheCauseSchema),
});
export type CacheEvent = z.infer<typeof cacheEventSchema>;

export const streamEventSchema = z.object({
  at: z.nullable(z.string()),
  level: z.enum(['trace', 'debug', 'info', 'warn', 'error']),
  category: z.enum(['cache', 'stream', 'historian', 'dreamer', 'transform']),
  inputTokens: z.nullable(z.number()),
  cacheRead: z.nullable(z.number()),
  cacheWrite: z.nullable(z.number()),
});
export type StreamEvent = z.infer<typeof streamEventSchema>;

export const databaseDiagnosticsSchema = z.object({
  observedAt: z.string(),
  magicContext: z.object({
    state: sourceStateSchema,
    counts: z.optional(z.object({
      compartments: z.nullable(z.number()),
      memories: z.nullable(z.number()),
      pendingOps: z.nullable(z.number()),
      sessionNotes: z.nullable(z.number()),
    })),
    context: z.optional(z.object({
      inputTokens: z.nullable(z.number()),
      contextLimit: z.nullable(z.number()),
      usagePercent: z.nullable(z.number()),
    })),
  }),
  openCode: z.object({
    state: sourceStateSchema,
    lastInputTokens: z.nullable(z.number()),
    cacheEvents: z.array(cacheEventSchema),
  }),
});
export type DatabaseDiagnostics = z.infer<typeof databaseDiagnosticsSchema>;

export const logDiagnosticsSchema = z.object({
  state: sourceStateSchema,
  observedAt: z.string(),
  events: z.array(streamEventSchema),
});
export type LogDiagnostics = z.infer<typeof logDiagnosticsSchema>;

export const diagnosticsResponseSchema = z.object({
  schemaVersion: z.literal(1),
  observedAt: z.string(),
  database: z.optional(databaseDiagnosticsSchema),
  log: logDiagnosticsSchema,
});
export type DiagnosticsResponse = z.infer<typeof diagnosticsResponseSchema>;

export const parseDiagnosticsResponse = (body: string): DiagnosticsResponse | null => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch {
    return null;
  }
  const result = diagnosticsResponseSchema.safeParse(decoded);
  return result.success ? result.data : null;
};

export type SessionRefreshStamp = { sessionId: string | null; generation: number };

export const isCurrentSessionRefresh = (requested: SessionRefreshStamp, current: SessionRefreshStamp): boolean =>
  requested.sessionId === current.sessionId && requested.generation === current.generation;

export const preserveLastGoodLog = (previous: LogDiagnostics | undefined, next: LogDiagnostics): LogDiagnostics => {
  if (next.state === 'error' && previous && (previous.state === 'ready' || previous.state === 'error')) {
    return { ...previous, state: 'error' };
  }
  return next;
};
