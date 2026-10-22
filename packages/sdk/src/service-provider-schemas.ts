import { z } from 'zod';

import {
  BROWSER_CONTROL_ACTIONS,
  SOURCE_CONTROL_OUTBOUND_BODY_MAX,
  SOURCE_CONTROL_OUTBOUND_METHODS,
  SOURCE_CONTROL_OUTBOUND_REQUEST_HEADERS,
  SOURCE_CONTROL_PROVIDER_ERROR_MESSAGE_MAX,
  SOURCE_CONTROL_PROVIDER_METHODS,
  SOURCE_CONTROL_PROVIDER_RESPONSE_MAX,
  SOURCE_CONTROL_PROVIDER_TARGET_MAX,
  type SourceControlProviderMethod,
} from './service-providers.ts';

/**
 * Host-side parse of what a browser provider answers. `data` stays whatever
 * the service produced: the host hands it to the agent as is, and only
 * `browser.capture` is read further (the image the host writes to disk).
 */
export const browserProviderResultSchema = z.union([
  z.object({ ok: z.literal(true), data: z.object({}).passthrough() }),
  z.object({ ok: z.literal(false), error: z.string().min(1).max(2_000) }),
]);

export const browserControlActionSchema = z.enum(BROWSER_CONTROL_ACTIONS);

/*
 * Host-side parse of what a source-control provider answers. Every answer is
 * checked as an envelope. Answers OpenChamber acts on (who an account is,
 * where a head lives, what a mutation targets and did) are checked deeply;
 * reads OpenChamber only hands to the UI, which parses those DTOs itself, are
 * checked for being a JSON object or array within the size cap, so the two
 * parsers never drift apart. A failed parse is a malformed answer, never an
 * empty one.
 */

const text = z.string().min(1).max(1_024);
const optionalText = z.string().max(1_024).optional();
const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonNegativeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const commitSha = z.string().regex(/^[0-9a-fA-F]{40}$/).transform((sha) => sha.toLowerCase());

const projectRef = z.object({ id: text, owner: text, name: text }).strict();

const errorSchema = z.object({
  message: z.string().min(1).max(SOURCE_CONTROL_PROVIDER_ERROR_MESSAGE_MAX),
  status: z.number().int().min(400).max(599).optional(),
  code: z.string().regex(/^[A-Z_]{1,64}$/).optional(),
}).strict();

const envelopeSchema = z.union([
  z.object({ ok: z.literal(true), data: z.json() }).strict(),
  z.object({ ok: z.literal(false), error: errorSchema }).strict(),
]);

const forgeUserSchema = z.object({
  id: positiveInteger,
  login: z.string().min(1).max(256),
  name: optionalText,
  email: optionalText,
  avatarUrl: z.string().max(2_048).optional(),
});

const verifySchema = z.object({ user: forgeUserSchema });

const probeSchema = z.object({
  supported: z.boolean(),
  version: z.string().max(128).optional(),
  message: z.string().max(SOURCE_CONTROL_PROVIDER_ERROR_MESSAGE_MAX).optional(),
});

const changeRequestHeadSchema = z.object({
  project: projectRef,
  headSha: commitSha,
  headBranch: text,
  headOwner: text,
});

/**
 * The shape only; OpenChamber also checks that `endpoint` is https on the
 * instance origin and names `sourceProject`, and that `headSha` is the head it
 * expected.
 */
const changeRequestSourceSchema = z.object({
  sourceProject: projectRef,
  targetProject: projectRef,
  classification: z.enum(['same-repository', 'contributor-fork']),
  headSha: commitSha,
  headRef: z.string().regex(/^refs\/heads\/\S+$/).max(1_024),
  endpoint: z.string().min(1).max(2_048),
});

/** Exactly the target keys OpenChamber's mutation store accepts. */
const mutationTargetSchema = z.object({
  repositoryId: text,
  bindingRevision: nonNegativeInteger,
  primaryRemote: text,
  project: projectRef,
  number: positiveInteger.optional(),
  head: text.optional(),
  base: text.optional(),
  headSha: text.optional(),
}).strict();

const jsonObject = z.record(z.string(), z.json());

const mutationResolutionSchema = z.object({
  providerTarget: jsonObject.refine(
    (target) => JSON.stringify(target).length <= SOURCE_CONTROL_PROVIDER_TARGET_MAX,
    { message: `providerTarget is at most ${SOURCE_CONTROL_PROVIDER_TARGET_MAX} characters of JSON` },
  ),
  target: mutationTargetSchema,
}).strict();

/** Exactly the result keys OpenChamber's mutation store accepts. */
const mutationResultSchema = z.object({
  project: projectRef.optional(),
  number: positiveInteger.optional(),
  head: text.optional(),
  base: text.optional(),
  headSha: text.optional(),
  state: text.optional(),
  merged: z.boolean().optional(),
  outcome: z.enum(['queued', 'merging']).optional(),
  stacked: z.boolean().optional(),
  ready: z.boolean().optional(),
  commented: z.boolean().optional(),
  failureStatus: z.number().int().min(400).max(599).optional(),
  failureCode: text.optional(),
}).strict();

const reconcileSchema = z.object({
  state: z.enum(['succeeded', 'failed', 'outcome-unknown']),
  result: mutationResultSchema.optional(),
}).strict();

const LIVE_SUMMARIES_MAX = 50;

const liveChangeRequestSummarySchema = z.object({
  owner: text,
  repo: text,
  number: positiveInteger,
  state: z.enum(['open', 'closed', 'merged']),
  draft: z.boolean(),
  title: z.string().max(4_096),
  mergeable: z.boolean().nullable(),
  mergeableState: z.string().max(64).nullable(),
  checks: z.object({ state: z.string().max(64) }).passthrough().nullable(),
  headSha: z.string().max(128).optional(),
  base: z.string().max(1_024).optional(),
});

const liveIssueSummarySchema = z.object({
  owner: text,
  repo: text,
  number: positiveInteger,
  title: z.string().max(4_096),
  state: z.enum(['open', 'completed', 'not_planned']),
});

const liveSummariesSchema = z.object({
  summaries: z.array(liveChangeRequestSummarySchema).max(LIVE_SUMMARIES_MAX),
  issueSummaries: z.array(liveIssueSummarySchema).max(LIVE_SUMMARIES_MAX),
});

const identitySchema = z.object({ provider: text, instance: text }).passthrough();
const projectSchema = z.object({ provider: text, instance: text, id: text, owner: text, name: text, url: text }).passthrough();

const STACK_LAYERS_MAX = 50;

/** Change requests stacked on one another, bottom layer first (`PullRequestStack` in the UI). */
const changeRequestStackSchema = z.object({
  number: positiveInteger.nullable(),
  base: text,
  layers: z.array(z.object({
    number: positiveInteger,
    title: z.string().max(4_096),
    url: text,
    state: z.enum(['open', 'closed', 'merged']),
    draft: z.boolean(),
    head: text,
  }).passthrough()).max(STACK_LAYERS_MAX),
}).passthrough();

/**
 * The local branch tip as a change-based host sees it: its sha, the change id
 * its commit message carries (null when none), and the revision number it was
 * uploaded as (null when this commit is not on the host yet).
 */
const localRevisionSchema = z.object({
  sha: commitSha,
  changeId: z.string().min(1).max(128).nullable(),
  uploadedAs: positiveInteger.nullable(),
}).strict();

/** The status OpenChamber caches per branch and shows on every badge. */
const changeRequestStatusSchema = z.object({
  identity: identitySchema,
  fetchedAt: z.number().optional(),
  project: projectSchema.nullable(),
  branch: z.string().min(1).max(1_024),
  changeRequest: z.object({
    provider: text,
    instance: text,
    id: text,
    number: positiveInteger,
    project: projectSchema,
    title: z.string().max(4_096),
    url: text,
    state: z.enum(['open', 'closed', 'merged']),
    draft: z.boolean(),
    base: text,
    head: text,
  }).passthrough().nullable(),
  ci: z.object({ summary: z.object({ state: z.string().max(64) }).passthrough() }).passthrough().nullable().optional(),
  canMerge: z.boolean().optional(),
  defaultBranch: z.string().max(1_024).nullable().optional(),
  resolvedRemoteName: z.string().max(1_024).nullable().optional(),
  localRevision: localRevisionSchema.optional(),
  stack: changeRequestStackSchema.nullable().optional(),
}).strict();

/** A read OpenChamber passes on unread: a JSON object or array within the response cap. */
const passThroughSchema = z.union([jsonObject, z.array(z.json())]).refine(
  (value) => JSON.stringify(value).length <= SOURCE_CONTROL_PROVIDER_RESPONSE_MAX,
  { message: 'answer is larger than the response cap' },
);

const dataSchemas = {
  'auth.verify': verifySchema,
  'auth.probe': probeSchema,
  changeRequestStatus: changeRequestStatusSchema,
  listChangeRequests: passThroughSchema,
  changeRequestContext: passThroughSchema,
  listIssues: passThroughSchema,
  getIssue: passThroughSchema,
  issueComments: passThroughSchema,
  projectUpstream: passThroughSchema,
  projectBranches: passThroughSchema,
  listLabels: passThroughSchema,
  listReviewerCandidates: passThroughSchema,
  readChangeRequestPatch: passThroughSchema,
  readChangeRequestFile: passThroughSchema,
  liveSummaries: liveSummariesSchema,
  readChangeRequestHead: changeRequestHeadSchema,
  resolveChangeRequestSource: changeRequestSourceSchema,
  'mutation.resolveTarget': mutationResolutionSchema,
  'mutation.perform': mutationResultSchema,
  'mutation.reconcile': reconcileSchema,
} satisfies Record<SourceControlProviderMethod, z.ZodType>;

/** What a service sends OpenChamber's outbound proxy; checked before anything reaches the forge. */
const outboundRequestSchema = z.object({
  method: z.enum(SOURCE_CONTROL_OUTBOUND_METHODS),
  path: z.string().min(1).max(2_048).regex(/^\/(?!\/)/),
  query: z.record(z.string().max(256), z.string().max(2_048)).optional(),
  headers: z.partialRecord(z.enum(SOURCE_CONTROL_OUTBOUND_REQUEST_HEADERS), z.string().max(1_024)).optional(),
  body: z.string().max(SOURCE_CONTROL_OUTBOUND_BODY_MAX).optional(),
}).strict();

/** Wire 1 of the source-control role, as the host parses it. `data[method]` checks an `ok: true` answer's `data`. */
export const sourceControlProviderSchemasV1 = {
  envelope: envelopeSchema,
  error: errorSchema,
  forgeUser: forgeUserSchema,
  probe: probeSchema,
  changeRequestHead: changeRequestHeadSchema,
  changeRequestSource: changeRequestSourceSchema,
  mutationTarget: mutationTargetSchema,
  mutationResolution: mutationResolutionSchema,
  mutationResult: mutationResultSchema,
  reconcile: reconcileSchema,
  liveSummaries: liveSummariesSchema,
  changeRequestStatus: changeRequestStatusSchema,
  passThrough: passThroughSchema,
  outboundRequest: outboundRequestSchema,
  data: dataSchemas,
};

export const sourceControlProviderMethodSchema = z.enum(SOURCE_CONTROL_PROVIDER_METHODS);
