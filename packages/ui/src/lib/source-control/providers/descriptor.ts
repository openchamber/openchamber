import { z } from 'zod';

/**
 * What the UI knows about one source-control provider, as the connected
 * server describes it (`GET /api/source-control/providers`). Plain data: the
 * UI owns every translated word, so the descriptor names closed terms and
 * field kinds the UI translates, and literal values (product name, prefixes,
 * URLs) that stay untranslated in every locale.
 */

/** Values other surfaces already use as a `provider` or source; neither registry accepts them. */
export const SHARED_RESERVED_PROVIDER_IDS: readonly string[] = ['guest', 'link', 'external', 'repository'];

/**
 * Ids the source-control registry never accepts: values other surfaces already
 * use as a `provider` or source (guest panels, links, external items, the
 * board's repository tab) and the tracker registry's ids, because tracked items
 * and the read cache key both families by `provider` in one namespace.
 */
// `linear` stays reserved because tracked items written before trackers name
// Linear by `provider: 'linear'` alone, with no kind to tell the families apart.
const RESERVED_PROVIDER_IDS: ReadonlySet<string> = new Set([...SHARED_RESERVED_PROVIDER_IDS, 'linear']);

export const sourceControlProviderIdSchema = z.string()
  .regex(/^[a-z][a-z0-9-]{0,31}$/)
  .refine((id) => !RESERVED_PROVIDER_IDS.has(id), { message: 'Reserved provider id' });

/** A source-control provider id: open, whatever the connected server serves. */
export type SourceControlProviderId = z.output<typeof sourceControlProviderIdSchema>;

/**
 * How a provider names a change request. Closed: the UI owns the sentences for
 * each term. `change` is a review host's change, reviewed patchset by patchset.
 */
export type ChangeRequestTerm = 'pullRequest' | 'mergeRequest' | 'change';
const changeRequestTermSchema = z.enum(['pullRequest', 'mergeRequest', 'change']);


/** What a provider calls the automation that runs on a change request: checks or a pipeline. Closed, like the term. */
const ciTermSchema = z.enum(['checks', 'pipeline']);

type SourceControlAuthMethod = 'device' | 'pat' | 'cli';
const authMethodSchema = z.enum(['device', 'pat', 'cli']);

/** Settings field kinds the UI can draw; any other kind reads as `unknown` and asks to update the app. */
const settingsFieldKindSchema = z.union([
  z.enum(['instance-url', 'personal-access-token', 'username', 'http-password']),
  z.string().transform((): 'unknown' => 'unknown'),
]);

// SVG path data only: commands, numbers and separators, nothing that could close the attribute.
const iconPathSchema = z.string().max(8192).regex(/^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s+-]+$/);
const literalSchema = z.string().min(1).max(64);
const urlPatternsSchema = z.array(z.string().min(1).max(256)).max(8);

const descriptorSchema = z.object({
  id: sourceControlProviderIdSchema,
  label: literalSchema,
  order: z.number().int(),
  terminology: z.object({
    // A term this version does not know reads as a pull request rather than dropping the provider.
    changeRequest: changeRequestTermSchema.catch('pullRequest'),
    changeRequestPrefix: z.string().min(1).max(4),
    issuePrefix: z.string().min(1).max(4),
    sharedNumberSpace: z.boolean(),
    /** 'PR', 'MR': a literal, shown untranslated. */
    abbreviation: z.string().min(1).max(8),
    /** English, for generation prompts only. */
    promptNoun: literalSchema,
    // A server that does not name it, or names one this version does not know, reads as checks.
    ci: ciTermSchema.catch('checks'),
  }),
  icon: z.object({
    sprite: z.string().max(64).optional(),
    filledSprite: z.string().max(64).optional(),
    /** A 24x24 path `d`, drawn when the sprite does not carry the provider's mark. */
    path: iconPathSchema.optional(),
  }),
  repository: z.object({
    nestedNamespaces: z.boolean(),
    /**
     * `path`: a project is any path, top-level ones included (its owner is
     * then empty). Absent for every other provider; an unknown value reads as absent.
     */
    pathStyle: z.literal('path').optional().catch(undefined),
  }),
  instances: z.object({
    /** `host`: a bare lowercase host (github.com). `origin`: a full origin (https://gitlab.com). */
    format: z.enum(['host', 'origin']),
    defaultInstance: z.string().min(1).max(256).nullable(),
    multiple: z.boolean(),
    allowLoopbackHttp: z.boolean(),
    allowPort: z.boolean(),
    reserved: z.array(z.string().max(256)).max(16),
    placeholder: z.string().max(256),
    legacyFlow: z.object({ instance: z.string().min(1).max(256), kind: z.literal('github-com-device') }).optional(),
  }),
  auth: z.object({
    // Methods this version cannot offer are left out instead of failing the provider.
    methods: z.array(z.union([authMethodSchema, z.string().transform((): null => null)]))
      .transform((methods) => methods.filter((method): method is SourceControlAuthMethod => method !== null)),
    cliName: z.string().min(1).max(32).optional(),
    cliTransport: z.boolean(),
    token: z.object({
      scopes: z.array(z.string().min(1).max(64)).max(32),
      createPath: z.string().max(256).optional(),
    }).optional(),
  }),
  settings: z.object({
    fields: z.array(z.object({
      id: z.string().min(1).max(64),
      kind: settingsFieldKindSchema,
      secret: z.boolean(),
    })).max(16),
  }),
  /** Path patterns: `{owner}`, `{namespace+}` (one or more segments), `{repo}`, `{number}`, literal segments. */
  urls: z.object({
    changeRequest: urlPatternsSchema,
    issue: urlPatternsSchema,
    // A host's discussions, where it keeps them; a pattern this version cannot read leaves none.
    discussion: urlPatternsSchema.default([]).catch([]),
    // Where a commit (`{sha}` in place of `{number}`) and a person (`/{user}`)
    // live, for links in item text. A host that names none gets no such links.
    commit: urlPatternsSchema.default([]).catch([]),
    user: urlPatternsSchema.default([]).catch([]),
  }),
  // A feature an older server does not name is off.
  features: z.object({
    referenceSearch: z.boolean().default(false),
    referenceDetail: z.boolean().default(false),
    listStatuses: z.boolean().default(false),
    referencesAcross: z.boolean().default(false),
    startThread: z.boolean().default(false),
    authorCanReview: z.boolean().default(false),
    projectUploads: z.boolean().default(false),
    issueCloseReason: z.boolean().default(false),
    changeRequestTemplates: z.array(z.string().min(1).max(256)).max(8).default([]),
    // Whether a change request's diff can be read (the comparison view and
    // walkthroughs). The exception to "unnamed is off": every server older
    // than this field served the diff of every provider it listed.
    changeRequestPatch: z.boolean().default(true),
    // Added later than the features above: a value this version cannot read
    // falls back to the meaning every older host has, never dropping the provider.
    /** How the host reviews: `verdict` (approve or request changes) or `votes` on labels each change names. */
    reviewModel: z.enum(['verdict', 'votes']).default('verdict').catch('verdict'),
    /** Changes keep their revisions (patchsets), and reads can ask for one. */
    revisions: z.boolean().default(false).catch(false),
    /** The change's context lists what it needs before it can be submitted. */
    submitRequirements: z.boolean().default(false).catch(false),
    /** A change is created by pushing for review, not through the API. */
    createByPush: z.boolean().default(false).catch(false),
    /** A change request's head is a branch that can be checked out and stacked on. */
    branchHeads: z.boolean().default(true).catch(true),
    /** The host keeps repository discussions, listed beside issues and change requests. */
    discussions: z.boolean().default(false).catch(false),
  }),
  /**
   * The installed extension that serves this provider; absent for a built-in.
   * A malformed marker is dropped and never costs the provider itself.
   */
  extension: z.object({
    guestId: z.string().min(1).max(128),
    name: z.string().min(1).max(200),
    version: z.string().min(1).max(64),
  }).optional().catch(undefined),
});

export type SourceControlProviderDescriptor = z.output<typeof descriptorSchema>;
/** A descriptor as a server publishes it: optional fields may be absent, the schema fills them in. */
export type PublishedSourceControlProviderDescriptor = z.input<typeof descriptorSchema>;

const byOrder = (a: SourceControlProviderDescriptor, b: SourceControlProviderDescriptor): number => (
  a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
);

/**
 * A provider list, ordered by `order`. One malformed or reserved descriptor is
 * left out and never fails the others; a repeated id keeps its first entry.
 */
export const sourceControlProviderListSchema = z.array(descriptorSchema.nullable().catch(null)).transform((list) => {
  const seen = new Set<string>();
  const descriptors: SourceControlProviderDescriptor[] = [];
  for (const descriptor of list) {
    if (!descriptor || seen.has(descriptor.id)) continue;
    seen.add(descriptor.id);
    descriptors.push(descriptor);
  }
  return descriptors.sort(byOrder);
});

const unknownDescriptors = new Map<string, SourceControlProviderDescriptor>();

/**
 * What the UI shows for a provider id the registry does not hold: its id as
 * the label, pull-request wording with `#`, the branch icon, and every
 * provider-specific feature off, so it still lists through the neutral reads.
 * Cached per id, so selectors see one stable object.
 */
export const unknownProviderDescriptor = (id: string): SourceControlProviderDescriptor => {
  const cached = unknownDescriptors.get(id);
  if (cached) return cached;
  const descriptor: SourceControlProviderDescriptor = {
    id,
    label: id,
    order: Number.MAX_SAFE_INTEGER,
    terminology: {
      changeRequest: 'pullRequest', changeRequestPrefix: '#', issuePrefix: '#',
      sharedNumberSpace: true, abbreviation: 'PR', promptNoun: 'pull request', ci: 'checks',
    },
    icon: { sprite: 'git-branch' },
    repository: { nestedNamespaces: false },
    instances: {
      format: 'origin', defaultInstance: null, multiple: false, allowLoopbackHttp: false,
      allowPort: false, reserved: [], placeholder: '',
    },
    auth: { methods: [], cliTransport: false },
    settings: { fields: [] },
    urls: { changeRequest: [], issue: [], discussion: [], commit: [], user: [] },
    features: {
      referenceSearch: false, referenceDetail: false, listStatuses: false, referencesAcross: false,
      startThread: false, authorCanReview: false, projectUploads: false, issueCloseReason: false,
      changeRequestTemplates: [], changeRequestPatch: false, reviewModel: 'verdict', revisions: false,
      submitRequirements: false, createByPush: false, branchHeads: true, discussions: false,
    },
  };
  unknownDescriptors.set(id, descriptor);
  return descriptor;
};
