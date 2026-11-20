import { z } from 'zod';
import type { SessionMetadata } from '../openchamber-sessions/session-metadata-store.js';
import type { SessionMetadata as KnowledgeSessionMetadata } from '../session-knowledge/contracts.js';

export const DIGEST_LIMITS = Object.freeze({ needsYou: 3, now: 8, news: 5, itemLength: 300 });

const digestSchema = z.object({
  needsYou: z.array(z.string()).catch([]),
  now: z.array(z.string()).catch([]),
  news: z.array(z.string()).catch([]),
  updatedAt: z.number().finite(),
});

const leadSchema = z.object({
  at: z.number().finite(),
  digest: digestSchema.optional().catch(undefined),
});

const metadataSchema = z.object({ openchamber: z.object({ lead: leadSchema }) });

export type LeadDigest = z.infer<typeof digestSchema>;
export type Lead = z.infer<typeof leadSchema>;

export const readLead = (metadata: SessionMetadata | KnowledgeSessionMetadata | null | undefined): Lead | null => metadataSchema.safeParse(metadata).data?.openchamber.lead ?? null;

const SECTION_NAMES = ['needsYou', 'now', 'news'] as const;
type SectionName = typeof SECTION_NAMES[number];

const jsonListSchema = z.string().transform((text, context) => {
  try {
    return z.array(z.string()).parse(JSON.parse(text));
  } catch {
    context.addIssue({ code: 'custom', message: 'not a JSON list of strings' });
    return z.NEVER;
  }
});

export const sectionInputSchema = z.union([z.array(z.string()), z.string(), z.null()]).optional();
type SectionInput = z.infer<typeof sectionInputSchema>;

const listOf = (value: SectionInput) => {
  if (value === undefined || value === null) return { success: true as const, data: [] };
  if (Array.isArray(value)) return { success: true as const, data: value };
  return value.trim().startsWith('[') ? jsonListSchema.safeParse(value.trim()) : { success: true as const, data: value.split(/\r?\n/) };
};

const cleanItem = (item: string) => item.replace(/^\s*[-*]\s+/, '').replace(/\s+/g, ' ').trim();

const readItems = (value: SectionInput, name: SectionName): string[] | string => {
  const parsed = listOf(value);
  if (!parsed.success) return `${name} must be a list of strings`;
  const items = parsed.data.map(cleanItem).filter(Boolean);
  if (items.length > DIGEST_LIMITS[name]) return `${name} takes at most ${DIGEST_LIMITS[name]} items; keep only what matters most`;
  const long = items.find((item) => item.length > DIGEST_LIMITS.itemLength);
  if (long) return `Each item is one line of at most ${DIGEST_LIMITS.itemLength} characters; this one is ${long.length}: "${long.slice(0, 60)}…"`;
  return items;
};

export type DigestInput = Partial<Record<SectionName, SectionInput>>;

export const parseDigestInput = (input: DigestInput, updatedAt: number): { digest: LeadDigest } | { error: string } => {
  const digest: LeadDigest = { needsYou: [], now: [], news: [], updatedAt };
  for (const name of SECTION_NAMES) {
    const items = readItems(input[name], name);
    if (!Array.isArray(items)) return { error: items };
    digest[name] = items;
  }
  return { digest };
};

export const digestPatch = (digest: LeadDigest) => ({ openchamber: { lead: { digest } } });
