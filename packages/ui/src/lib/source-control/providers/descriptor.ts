import { z } from 'zod';
import { sourceControlServiceLoginSchema } from '@openchamber/sdk/schemas';


export const SHARED_RESERVED_PROVIDER_IDS: readonly string[] = ['guest', 'link', 'external', 'repository'];

const RESERVED_PROVIDER_IDS: ReadonlySet<string> = new Set([...SHARED_RESERVED_PROVIDER_IDS, 'linear']);

export const sourceControlProviderIdSchema = z.string()
  .regex(/^[a-z][a-z0-9-]{0,31}$/)
  .refine((id) => !RESERVED_PROVIDER_IDS.has(id), { message: 'Reserved provider id' });

export type SourceControlProviderId = z.output<typeof sourceControlProviderIdSchema>;

export type ChangeRequestTerm = 'pullRequest' | 'mergeRequest' | 'change';
const changeRequestTermSchema = z.enum(['pullRequest', 'mergeRequest', 'change']);


const ciTermSchema = z.enum(['checks', 'pipeline']);

type SourceControlAuthMethod = 'device' | 'pat' | 'cli';
const authMethodSchema = z.enum(['device', 'pat', 'cli']);

const settingsFieldKindSchema = z.union([
  z.enum(['instance-url', 'personal-access-token', 'username', 'http-password']),
  z.string().transform((): 'unknown' => 'unknown'),
]);

const iconPathSchema = z.string().max(8192).regex(/^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s+-]+$/);
const literalSchema = z.string().min(1).max(64);
const urlPatternsSchema = z.array(z.string().min(1).max(256)).max(8);

const descriptorSchema = z.object({
  id: sourceControlProviderIdSchema,
  label: literalSchema,
  order: z.number().int(),
  terminology: z.object({
    changeRequest: changeRequestTermSchema.catch('pullRequest'),
    changeRequestPrefix: z.string().min(1).max(4),
    issuePrefix: z.string().min(1).max(4),
    sharedNumberSpace: z.boolean(),
    abbreviation: z.string().min(1).max(8),
    promptNoun: literalSchema,
    ci: ciTermSchema.catch('checks'),
  }),
  icon: z.object({
    sprite: z.string().max(64).optional(),
    filledSprite: z.string().max(64).optional(),
    path: iconPathSchema.optional(),
  }),
  repository: z.object({
    nestedNamespaces: z.boolean(),
    pathStyle: z.literal('path').optional().catch(undefined),
  }),
  instances: z.object({
    format: z.enum(['host', 'origin']),
    defaultInstance: z.string().min(1).max(256).nullable(),
    defaultInstances: z.array(z.string().min(1).max(256)).max(16).optional().catch(undefined),
    multiple: z.boolean(),
    allowLoopbackHttp: z.boolean(),
    allowPort: z.boolean(),
    reserved: z.array(z.string().max(256)).max(16),
    placeholder: z.string().max(256),
    legacyFlow: z.object({ instance: z.string().min(1).max(256), kind: z.literal('github-com-device') }).optional(),
  }),
  auth: z.object({
    methods: z.array(z.union([authMethodSchema, z.string().transform((): null => null)]))
      .transform((methods) => methods.filter((method): method is SourceControlAuthMethod => method !== null)),
    cliName: z.string().min(1).max(32).optional(),
    login: sourceControlServiceLoginSchema.optional(),
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
  urls: z.object({
    resolve: z.string().max(256).optional(),
    changeRequest: urlPatternsSchema,
    issue: urlPatternsSchema,
    discussion: urlPatternsSchema.default([]).catch([]),
    commit: urlPatternsSchema.default([]).catch([]),
    user: urlPatternsSchema.default([]).catch([]),
  }),
  features: z.object({
    referenceSearch: z.boolean().default(false),
    referenceDetail: z.boolean().default(false),
    listStatuses: z.boolean().default(false),
    referencesAcross: z.boolean().default(false),
    startThread: z.boolean().default(false),
    reviewDrafts: z.boolean().default(false),
    reviewDraftFileComments: z.boolean().default(false),
    authorCanReview: z.boolean().default(false),
    projectUploads: z.boolean().default(false),
    absoluteProjectUploads: z.boolean().default(false),
    issueCloseReason: z.boolean().default(false),
    issueEdit: z.boolean().default(false),
    changeRequestEdit: z.boolean().default(false),
    changeRequestTemplates: z.array(z.string().min(1).max(256)).max(8).default([]),
    changeRequestPatch: z.boolean().default(true),
    reviewModel: z.enum(['verdict', 'votes']).default('verdict').catch('verdict'),
    revisions: z.boolean().default(false).catch(false),
    submitRequirements: z.boolean().default(false).catch(false),
    createByPush: z.boolean().default(false).catch(false),
    branchHeads: z.boolean().default(true).catch(true),
    discussions: z.boolean().default(false).catch(false),
    advancedSearch: z.boolean().default(false).catch(false),
    commentEdit: z.boolean().default(false).catch(false),
  }),
  extension: z.object({
    guestId: z.string().min(1).max(128),
    name: z.string().min(1).max(200),
    version: z.string().min(1).max(64),
  }).optional().catch(undefined),
});

export type SourceControlProviderDescriptor = z.output<typeof descriptorSchema>;
export type PublishedSourceControlProviderDescriptor = z.input<typeof descriptorSchema>;

const byOrder = (a: SourceControlProviderDescriptor, b: SourceControlProviderDescriptor): number => (
  a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
);

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
      startThread: false, reviewDrafts: false, reviewDraftFileComments: false, authorCanReview: false, projectUploads: false, absoluteProjectUploads: false, issueCloseReason: false,
      issueEdit: false, changeRequestEdit: false,
      changeRequestTemplates: [], changeRequestPatch: false, reviewModel: 'verdict', revisions: false,
      submitRequirements: false, createByPush: false, branchHeads: true, discussions: false, advancedSearch: false, commentEdit: false,
    },
  };
  unknownDescriptors.set(id, descriptor);
  return descriptor;
};
