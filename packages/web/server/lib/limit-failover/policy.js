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

// `provider.free-limit` is OpenCode's own free tier running out (2.1.2+),
// `provider.budget-limit` / `provider.model-budget-limit` an OpenCode Console
// spend limit of the workspace or of one model (2.2+), `provider.go-limit`
// OpenCode Go's own limit and `provider.chatgpt-limit` a ChatGPT subscription
// sharing limit (both 2.2.5+). They were `provider.quota` before and behave
// the same.
const LIMIT_ERROR_TYPES = new Set([
  'provider.quota',
  'provider.free-limit',
  'provider.budget-limit',
  'provider.model-budget-limit',
  'provider.go-limit',
  'provider.chatgpt-limit',
  'provider.rate-limit',
]);

const KNOWN_FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'];

/** The model family an Anthropic plan window is scoped to; null when the id names none. */
export const modelFamilyOf = (modelID) => {
  const name = String(modelID).toLowerCase();
  return KNOWN_FAMILIES.find((family) => name.includes(family)) ?? null;
};

// A `seven_day_<family>` claim is that family's window; any other claim covers
// the whole account. An unknown family falls back to the session's model
// family, else to the account, so a mark never blocks more than it should.
const claimFamily = (claim) => (claim?.startsWith('seven_day_') ? claim.slice('seven_day_'.length) : null);

const scopeOfClaim = (claim, modelID) => {
  const family = claimFamily(claim);
  if (!family) return { kind: 'account' };
  if (KNOWN_FAMILIES.includes(family)) return { kind: 'model', family };
  const ofModel = modelFamilyOf(modelID);
  return ofModel ? { kind: 'model', family: ofModel } : { kind: 'account' };
};

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

// Z.ai names the reset in the message ("will reset at 2026-11-19 04:46:15")
// with no zone. The 5-hour window only fits Beijing time: a failure at 17:08
// UTC resetting at 04:46 is 3.6 hours later at UTC+8, and 11 hours later as UTC.
const RESET_IN_MESSAGE = /reset at (\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/i;
const BEIJING_OFFSET = '+08:00';

const parseResetFromMessage = (message, now) => {
  const match = RESET_IN_MESSAGE.exec(message ?? '');
  if (!match) return null;
  const at = Date.parse(`${match[1]}T${match[2]}${BEIJING_OFFSET}`);
  return Number.isFinite(at) && at > now ? at : null;
};

/**
 * When the provider says the limit lifts: OpenCode's `retryAfterMs` (the
 * provider's retry-after, counted from the failure), else a hint in the error
 * body, else the reset a message names. Null when there is none or it is past.
 */
export const parseLimitResetAt = (error, now) => {
  if (error?.retryAfterMs > 0) return now + error.retryAfterMs;
  const body = limitBodySchema.safeParse(error?.body);
  const fromBody = body.success
    ? resetFromHints(body.data, now) ?? (body.data.error ? resetFromHints(body.data.error, now) : null)
    : null;
  return fromBody ?? parseResetFromMessage(error?.message, now);
};

/**
 * The limit failure the plugin reported, or null when it is not one: quota
 * errors always, rate limits only when the wait is long (see LONG_WAIT_MS) or
 * Anthropic's own headers say the account was rejected until a future reset.
 * `resetAt` is when the account may be tried again; `scope` says whether the
 * window that hit covers the whole account or one model family.
 */
export const classifyLimitFailure = (report, now) => {
  const error = report.error;
  if (!LIMIT_ERROR_TYPES.has(error.type)) return null;
  const captured = report.captured ?? null;
  const capturedReset = captured !== null && captured.status === 'rejected' && captured.resetAt > now
    ? captured.resetAt
    : null;
  const scope = captured !== null && captured.claim ? scopeOfClaim(captured.claim, report.modelID) : { kind: 'account' };
  const resetAt = parseLimitResetAt(error, now);
  const proposedDelay = report.proposed.retry ? report.proposed.delay : 0;
  if (error.type === 'provider.rate-limit') {
    const wait = Math.max(
      proposedDelay,
      resetAt === null ? 0 : resetAt - now,
      capturedReset === null ? 0 : capturedReset - now,
    );
    if (wait < LONG_WAIT_MS) return null;
  }
  const furthestReset = [resetAt, capturedReset].filter((value) => value !== null && value > now).sort((a, b) => b - a)[0];
  if (furthestReset !== undefined) return { resetAt: furthestReset, scope, named: true };
  const guessed = proposedDelay >= LONG_WAIT_MS;
  return { resetAt: now + (guessed ? proposedDelay : DEFAULT_EXHAUSTION_MS), scope, named: guessed };
};

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

// What the plugin captured from Anthropic's `anthropic-ratelimit-unified-*`
// response headers of the 429 the session hit: whether Anthropic rejected the
// account, until when, and which window's claim it rejected on.
const capturedSchema = z.object({
  status: z.string().min(1).max(64),
  resetAt: z.number().finite(),
  claim: z.string().min(1).max(64).optional().catch(undefined),
});

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
  captured: capturedSchema.optional().catch(undefined),
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
