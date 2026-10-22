import { isString } from '../shared/guards.js';
import { digestMutationInput } from './mutation-executor.js';

/**
 * The standard mutation table: each shell route's persisted kind (GitLab's
 * names), its input normalization and the fields its digest covers. Gitea
 * uses it, and so does every extension provider, whose kinds and digests the
 * host owns. Kinds and digest fields are persisted in
 * `source-control-mutations.json`; changing either turns a retained record's
 * replay into a conflict (`mutation-digest-freeze.test.js` holds them).
 */

const invalidMutationContext = (message) => Object.assign(new Error(message), {
  code: 'INVALID_SOURCE_CONTROL_MUTATION_CONTEXT',
  status: 400,
});

const requestText = (value) => (isString(value) ? value.trim() : '');

/**
 * `descriptor` supplies the limits (comment length, label and reviewer
 * counts, reviewer id syntax), the merge methods and the label in messages.
 * Routes are listed in a fixed order; a provider registers them all and the
 * shell answers 501 for a capability that is off.
 */
export function createStandardMutations(descriptor) {
  const commentText = (value, required) => {
    if (value === undefined && !required) return undefined;
    if (!isString(value) || !value.trim() || value.length > descriptor.limits.commentMaxLength) {
      throw invalidMutationContext(`body is required and must fit a ${descriptor.label} comment`);
    }
    return value;
  };
  const nameList = (value, limit) => {
    if (!Array.isArray(value) || value.length > limit
      || value.some((entry) => !isString(entry) || !entry.trim() || entry.length > 256)) {
      throw invalidMutationContext('labels or reviewers are invalid');
    }
    return [...new Set(value)].sort();
  };
  const mergeMethods = descriptor.capabilities.merge ? descriptor.capabilities.merge.methods : [];
  const requireNumber = (context) => {
    if (!context.target.number) throw invalidMutationContext('target number is required');
  };

  const entries = {
    '/pr/create': {
      kind: 'change-request-create',
      normalize: (input, context) => {
        const title = requestText(input.title);
        if (!title || !context.target.head || !context.target.base) {
          throw invalidMutationContext('title, target head, and target base are required');
        }
        const normalized = { title, draft: input.draft === true };
        if (isString(input.body)) normalized.body = input.body;
        const remote = requestText(input.remote);
        const headRemote = requestText(input.headRemote);
        if (remote) normalized.remote = remote;
        if (headRemote) normalized.headRemote = headRemote;
        normalized.digest = {
          title, body: normalized.body ?? null, draft: normalized.draft,
          remote: normalized.remote ?? context.primaryRemote, headRemote: normalized.headRemote ?? context.primaryRemote,
        };
        return normalized;
      },
    },
    '/pr/update': {
      kind: 'change-request-update',
      normalize: (input, context) => {
        const title = requestText(input.title);
        if (!title || !context.target.number) throw invalidMutationContext('title and target number are required');
        const normalized = { title };
        if (isString(input.body)) normalized.body = input.body;
        normalized.digest = { title, body: normalized.body ?? null };
        return normalized;
      },
    },
    '/pr/merge': {
      kind: 'change-request-merge',
      normalize: (input, context) => {
        if (!context.target.number || !mergeMethods.includes(input.method)) {
          throw invalidMutationContext('target number and merge method are required');
        }
        return { method: input.method, digest: { method: input.method } };
      },
    },
    '/pr/ready': {
      kind: 'change-request-ready',
      normalize: (_input, context) => {
        requireNumber(context);
        return { digest: {} };
      },
    },
    '/pr/review': {
      kind: 'change-request-review',
      normalize: (input, context) => {
        // A verdict names the commit it is for; without one it would land on whatever was pushed last.
        if (!context.target.number || !context.target.headSha || !['approve', 'request-changes'].includes(input.verdict)) {
          throw invalidMutationContext('target number, head SHA and review verdict are required');
        }
        const text = commentText(input.body, false);
        return { verdict: input.verdict, body: text, digest: { verdict: input.verdict, body: text ?? null } };
      },
    },
  };
  for (const [route, kind] of [['/pr/comment', 'change-request-comment'], ['/issues/comment', 'issue-comment']]) {
    entries[route] = {
      kind,
      normalize: (input, context) => {
        requireNumber(context);
        const text = commentText(input.body, true);
        return { body: text, digest: { body: text } };
      },
    };
  }
  // Close or reopen: `state` is what the item should become.
  for (const [route, kind] of [['/pr/state', 'change-request-state'], ['/issues/state', 'issue-state']]) {
    entries[route] = {
      kind,
      normalize: (input, context) => {
        if (!context.target.number || !['open', 'closed'].includes(input.state)) {
          throw invalidMutationContext('target number and state are required');
        }
        return { state: input.state, digest: { state: input.state } };
      },
    };
  }
  for (const [route, kind, field] of [
    ['/pr/labels', 'change-request-labels', 'labels'],
    ['/issues/labels', 'issue-labels', 'labels'],
    ['/pr/reviewers', 'change-request-reviewers', 'reviewers'],
  ]) {
    entries[route] = {
      kind,
      normalize: (input, context) => {
        requireNumber(context);
        const names = nameList(input[field], field === 'labels' ? descriptor.limits.labelsMax : descriptor.limits.reviewersMax);
        if (field === 'reviewers' && names.some((id) => !descriptor.limits.reviewerId.test(id))) {
          throw invalidMutationContext('reviewers are invalid');
        }
        return { names, digest: { [field]: names } };
      },
    };
  }

  const entryFor = (route) => {
    if (!Object.hasOwn(entries, route)) throw invalidMutationContext('Source control mutation is unsupported');
    return entries[route];
  };

  return Object.freeze({
    routes: Object.freeze(Object.keys(entries)),
    /**
     * The persisted kind, normalized input and digest; the digest covers the
     * exact credential and resolved target. The normalized input keeps its
     * `digest` fields beside what the provider call needs.
     */
    prepare: ({ route, input, context, actor, credential }) => {
      const entry = entryFor(route);
      const normalized = entry.normalize(input, context);
      return {
        kind: entry.kind,
        input: normalized,
        digest: (target) => digestMutationInput({ kind: entry.kind, actor, credential, target, ...normalized.digest }),
      };
    },
  });
}
