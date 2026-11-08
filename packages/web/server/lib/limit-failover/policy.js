import { z } from 'zod';

import { asNonEmptyString } from '../shared/guards.js';

/**
 * A rate limit this far from lifting is an exhausted plan or quota window, not
 * a throttle: OpenCode's own backoff tops out at 10 seconds per gap, so a
 * longer proposed wait only comes from the provider saying when it resets.
 */
const LONG_WAIT_MS = 60_000;

/** How long an account stays skipped when its limit error says nothing about the reset. */
export const DEFAULT_EXHAUSTION_MS = 60 * 60_000;

// `provider.free-limit` is OpenCode's own free tier running out (2.1.2+), and
// `provider.budget-limit` / `provider.model-budget-limit` an OpenCode Console
// spend limit of the workspace or of one model (2.2+). They were
// `provider.quota` before and behave the same.
const LIMIT_ERROR_TYPES = new Set([
  'provider.quota',
  'provider.free-limit',
  'provider.budget-limit',
  'provider.model-budget-limit',
  'provider.rate-limit',
]);

// The moment a window opens: epoch seconds (until the year 2286) or
// milliseconds, a numeric string of either, or ISO text.
const epochMs = (value) => (value < 1e10 ? value * 1000 : value);
const resetAtSchema = z.union([
  z.number().positive().transform(epochMs),
  z.string().regex(/^\d+(\.\d+)?$/).transform(Number).pipe(z.number().positive()).transform(epochMs),
  z.string().transform((text) => Date.parse(text)).pipe(z.number().finite()),
]);
const waitSecondsSchema = z.coerce.number().positive();

// Reset hints providers put in limit bodies, at the top level or under `error`.
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

const resetFromHints = (hints, now) => {
  const at = hints.resets_at ?? hints.reset_at ?? hints.resetsAt ?? hints.resetAt;
  if (at !== undefined && at > now) return at;
  const seconds = hints.retry_after ?? hints.retryAfter ?? hints.resets_in_seconds ?? hints.reset_in_seconds;
  return seconds === undefined ? null : now + seconds * 1000;
};

/**
 * When the provider says the limit lifts: OpenCode's `retryAfterMs` (the
 * provider's retry-after, counted from the failure), else a hint in the error
 * body. Null when there is neither or the body's hint is already past.
 */
export const parseLimitResetAt = (error, now) => {
  if (error?.retryAfterMs > 0) return now + error.retryAfterMs;
  const body = limitBodySchema.safeParse(error?.body);
  if (!body.success) return null;
  return resetFromHints(body.data, now) ?? (body.data.error ? resetFromHints(body.data.error, now) : null);
};

/**
 * The limit failure the plugin reported, or null when it is not one: quota
 * errors always, rate limits only when the wait is long (see LONG_WAIT_MS).
 * `resetAt` is when the account may be tried again: the body's hint, else the
 * wait OpenCode took from the provider's retry-after, else an hour.
 */
export const classifyLimitFailure = (report, now) => {
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

/** Whether either option is on, so the managed OpenCode needs the plugin at all. */
export const isLimitFailoverConfigured = (settings) => (
  parseModelSetting(settings?.fallbackModel) !== null
  || (Array.isArray(settings?.accountSwitchProviders) && settings.accountSwitchProviders.length > 0)
);

/**
 * `provider/model` as the settings store it, with its thinking level when one
 * is set; the model id may itself contain slashes.
 */
export const parseModelSetting = (value, variantValue) => {
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

const reportSchema = z.object({
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
  // One malformed account drops only itself.
  credentials: z
    .array(z.unknown())
    .catch([])
    .transform((items) => items.flatMap((item) => {
      const credential = credentialSchema.safeParse(item);
      return credential.success ? [credential.data] : [];
    })),
  activeCredentialID: z.string().min(1).optional().catch(undefined),
});

/**
 * The plugin's report, checked at the boundary. Null when a field the
 * decision depends on is missing, so a malformed report changes nothing.
 */
export const parseLimitReport = (body) => {
  const report = reportSchema.safeParse(body);
  return report.success ? report.data : null;
};
