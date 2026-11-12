import path from 'node:path';
import { z } from 'zod';
import { commitSchema, destinationOf } from '../pr-fix-loop/approval-contract.js';
import { isSafeRepositoryEndpoint } from '../source-control/binding-contract.js';
import { checkContextsSchema, failedChecksReplySchema, feedbackReplySchema, headSnapshotSchema } from './fix-loop-feedback-contract.js';

export const FIX_LOOP_SERVICE_ROUTE = '/api/openchamber/fix-loop-services';
export const FIX_LOOP_ROUTE = '/api/source-control/github/pr/fix-loops';
export const FIX_LOOP_BYTES = 4 * 1024 * 1024;
export const FIX_LOOP_INPUT_BYTES = 256 * 1024;
export const FIX_LOOP_TIMEOUT_MS = 30_000;
const name = z.string().min(1).max(256).refine((value) => !/[\x00-\x1f\x7f]/.test(value));
const coordinate = name.regex(/^[A-Za-z0-9_.-]+$/).refine((value) => value !== '.' && value !== '..');
export const projectDirectorySchema = z.string().min(1).max(4096).refine((value) => path.isAbsolute(value)
  && !/[\x00-\x1f\x7f]/.test(value) && !/^\/spaces(?:\/|$)/i.test(path.posix.normalize(value.replaceAll('\\', '/'))));
export const readContextSchema = z.object({ provider: z.literal('github'), instance: z.literal('github.com'), accountId: name,
  directory: projectDirectorySchema, repositoryId: name, bindingRevision: z.number().int().nonnegative(), primaryRemote: name,
  linked: z.literal(true).optional() }).strict();
const target = { owner: coordinate, repo: coordinate, number: z.number().int().positive().max(2147483647) };
export const targetSchema = z.object(target).strict();
const project = z.object({ directory: projectDirectorySchema }).strict();
const pullInput = z.object({ context: readContextSchema, ...target }).strict();
const readInput = project.extend({ accountId: name, ...target }).strict();
const endpoint = z.object({ displayUrl: z.string().max(4096), fingerprint: name.max(128) }).refine(isSafeRepositoryEndpoint);
const remote = z.object({ name, endpoint }).strict();
const authoritySchema = z.object({ repositoryId: name, bindingRevision: z.number().int().nonnegative(),
  configRevision: name, remote, transportMode: z.literal('managed') }).strict();
const approvalRefSchema = z.string().regex(/^refs\/heads\/openchamber-approval\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const destinationRef = z.string().startsWith('refs/heads/').max(1035).refine((value) => {
  try { destinationOf({ branch: value.slice(11), headSha: 'a'.repeat(40), headRepo: { id: 'id', owner: 'owner', repo: 'repo' } }); return true; }
  catch { return false; }
});
const captureRefInputSchema = project.extend({ commit: commitSchema, expectedHead: commitSchema, localRef: approvalRefSchema }).strict();
const publishInputSchema = authoritySchema.extend({ directory: projectDirectorySchema, operation: z.literal('push'),
  sourceRef: approvalRefSchema, destinationRef, forceWithLease: z.object({ expectedRemoteSha: commitSchema }).strict() }).strict();
const operationBase = { idempotencyKey: name };
const body = z.string().min(1).max(8192);
const reviewOperation = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('thread-reply'), threadId: name, body, ...operationBase }).strict(),
  z.object({ kind: z.literal('thread-resolve'), threadId: name, resolved: z.literal(true), ...operationBase }).strict(),
  z.object({ kind: z.literal('comment'), body, ...operationBase }).strict(),
]);
const success = z.object({ ok: z.literal(true) });
export const headInputSchema = project.extend({ head: commitSchema }).strict();
export const headMetadataSchema = z.object({ head: commitSchema, objectFormat: z.literal('sha1'),
  shallow: z.array(commitSchema).max(100000) });
const bindingReplySchema = z.object({ revision: z.number().int().nonnegative(),
  repository: z.object({ repositoryId: name, configRevision: name,
    remotes: z.array(z.object({ name, push: endpoint })).max(256) }),
  binding: z.object({ remotes: z.array(z.object({ name, mode: z.enum(['managed', 'system', 'anonymous']),
    readiness: z.enum(['ready', 'confirmation-required', 'config-changed']) })).max(256) }).nullable(),
});
const admitReplySchema = z.object({ context: readContextSchema, pull: targetSchema.extend({
  title: z.string().max(4096), url: z.string().max(4096), branch: z.string().max(1024), snapshot: headSnapshotSchema,
}) });
export const FIX_LOOP_OPERATIONS = {
  admit: { input: pullInput, reply: admitReplySchema },
  feedback: { input: readInput.extend({ mentionText: z.string().min(1).max(100).optional() }).strict(), reply: feedbackReplySchema },
  'author-permission': { input: readInput.omit({ number: true }).extend({ username: name }).strict(), reply: z.object({ permitted: z.boolean() }) },
  'failed-checks': { input: readInput.omit({ number: true }).extend({ contexts: checkContextsSchema }).strict(), reply: failedChecksReplySchema },
  'read-binding': { input: project, reply: bindingReplySchema },
  'fetch-head': { input: pullInput.extend({ head: commitSchema }).strict(), reply: z.object({ head: commitSchema }) },
  'capture-ref': { input: captureRefInputSchema, reply: z.object({ commit: commitSchema, localRef: approvalRefSchema }) },
  publish: { input: z.object({ input: publishInputSchema, commit: commitSchema }).strict(), reply: z.object({ state: z.literal('succeeded') }) },
  'review-operation': { input: pullInput.extend({ commit: commitSchema, ref: destinationRef,
    operation: reviewOperation, replayOnly: z.boolean() }).strict(), reply: success },
  'head-metadata': { input: headInputSchema, reply: headMetadataSchema },
};
export const fixLoopServiceError = (code, statusCode = 502, extra = {}) => Object.assign(new Error(code), { code, statusCode, ...extra });
