import { z } from 'zod';

import { asNonEmptyString } from '../shared/guards.js';

const LONG_WAIT_MS = 60_000;

export interface LimitFailoverSettings {
  fallbackModel?: string | undefined;
  fallbackVariant?: string | undefined;
  accountSwitchProviders?: string[];
}

export interface FailoverModel {
  providerID: string;
  id: string;
  variant?: string;
}

export interface LimitFailure {
  resetAt: number;
}

export const DEFAULT_EXHAUSTION_MS = 60 * 60_000;

const LIMIT_ERROR_TYPES = new Set([
  'provider.quota',
  'provider.free-limit',
  'provider.budget-limit',
  'provider.model-budget-limit',
  'provider.rate-limit',
]);

const epochMs = (value: number) => (value < 1e10 ? value * 1000 : value);
const resetAtSchema = z.union([
  z.number().positive().transform(epochMs),
  z.string().regex(/^\d+(\.\d+)?$/).transform(Number).pipe(z.number().positive()).transform(epochMs),
  z.string().transform((text) => Date.parse(text)).pipe(z.number().finite()),
]);
const waitSecondsSchema = z.coerce.number().positive();

const hintFields = {
  resets_at: resetAtSchema.optional().catch(undefined),
  reset_at: resetAtSchema.optional().catch(undefined),
  resetsAt: resetAtSchema.optional().catch(undefined),
  resetAt: resetAtSchema.optional().catch(undefined),
  retry_after: waitSecondsSchema.optional().catch(undefined),
  retryAfter: waitSecondsSchema.optional().catch(undefined),
  resets_in_seconds: waitSecondsSchema.optional().catch(undefined),
  reset_in_seconds: waitSecondsSchema.optional().catch(undefined),
};
const hintsSchema = z.object(hintFields);
const limitBodySchema = z
  .string()
  .transform((text, context) => {
    try {
      return JSON.parse(text);
    } catch {
      context.addIssue({ code: 'custom', message: 'not JSON' });
      return z.NEVER;
    }
  })
  .pipe(hintsSchema.extend({ error: hintsSchema.optional().catch(undefined) }));

const resetFromHints = (hints: z.output<typeof hintsSchema>, now: number) => {
  const at = hints.resets_at ?? hints.reset_at ?? hints.resetsAt ?? hints.resetAt;
  if (at !== undefined && at > now) return at;
  const seconds = hints.retry_after ?? hints.retryAfter ?? hints.resets_in_seconds ?? hints.reset_in_seconds;
  return seconds === undefined ? null : now + seconds * 1000;
};

export const parseLimitResetAt = (error: LimitReport['error'] | null | undefined, now: number) => {
  if (error?.retryAfterMs !== undefined && error.retryAfterMs > 0) return now + error.retryAfterMs;
  const body = limitBodySchema.safeParse(error?.body);
  if (!body.success) return null;
  return resetFromHints(body.data, now) ?? (body.data.error ? resetFromHints(body.data.error, now) : null);
};

export const classifyLimitFailure = (report: LimitReport, now: number): LimitFailure | null => {
  const error = report.error;
  if (!LIMIT_ERROR_TYPES.has(error.type)) return null;
  const resetAt = parseLimitResetAt(error, now);
  const proposedDelay = report.proposed.retry ? report.proposed.delay : 0;
  if (error.type === 'provider.rate-limit') {
    const wait = Math.max(proposedDelay, resetAt === null ? 0 : resetAt - now);
    if (wait < LONG_WAIT_MS) return null;
  }
  if (resetAt !== null) return { resetAt };
  return { resetAt: now + (proposedDelay >= LONG_WAIT_MS ? proposedDelay : DEFAULT_EXHAUSTION_MS) };
};

export const isLimitFailoverConfigured = (settings: LimitFailoverSettings | null | undefined) => (
  parseModelSetting(settings?.fallbackModel) !== null
  || (Array.isArray(settings?.accountSwitchProviders) && settings.accountSwitchProviders.length > 0)
);

export const parseModelSetting = (value: string | null | undefined, variantValue?: string | null): FailoverModel | null => {
  const text = asNonEmptyString(value);
  if (!text) return null;
  const slash = text.indexOf('/');
  if (slash <= 0 || slash === text.length - 1) return null;
  const model = { providerID: text.slice(0, slash), id: text.slice(slash + 1) };
  const variant = asNonEmptyString(variantValue);
  return variant ? { ...model, variant } : model;
};

const credentialSchema = z
  .object({ id: z.string().min(1), label: z.string().optional().catch(undefined) })
  .transform((credential) => ({ id: credential.id, label: credential.label || credential.id }));

export const reportSchema = z.object({
  sessionID: z.string().min(1),
  providerID: z.string().min(1),
  modelID: z.string().min(1),
  error: z.object({
    type: z.string().min(1),
    message: z.string().catch(''),
    body: z.string().nullable().catch(null).default(null),
    retryAfterMs: z.number().finite().nonnegative().optional().catch(undefined),
  }),
  proposed: z
    .union([
      z.object({ retry: z.literal(true), delay: z.number().finite().nonnegative() }),
      z.object({ retry: z.literal(false) }),
    ])
    .catch({ retry: false }),
  credentials: z
    .array(z.unknown())
    .catch([])
    .transform((items) => items.flatMap((item) => {
      const credential = credentialSchema.safeParse(item);
      return credential.success ? [credential.data] : [];
    })),
  activeCredentialID: z.string().min(1).optional().catch(undefined),
});

export type LimitReport = z.output<typeof reportSchema>;
export type LimitReportInput = z.input<typeof reportSchema>;
