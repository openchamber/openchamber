import { z } from 'zod';

import { parseMetadata } from '@/lib/metadataParse';
import type { Metadata, Session } from '@/lib/opencode/model';

const questionSchema = z.object({
  question: z.string(),
  options: z.array(z.string()).catch([]),
  recommended: z.string().optional().catch(undefined),
});

export type LeadQuestion = z.infer<typeof questionSchema>;

const digestSchema = z.object({
  needsYou: z.array(z.union([z.string(), questionSchema]))
    .catch([])
    .transform((items) => items.map((item): LeadQuestion => (typeof item === 'string' ? { question: item, options: [] } : item))),
  now: z.array(z.string()).catch([]),
  news: z.array(z.string()).catch([]),
  suggestions: z.array(z.string()).catch([]),
  updatedAt: z.number().finite(),
});

const leadSchema = z.object({
  openchamber: z.object({
    lead: z.object({
      at: z.number().finite(),
      digest: digestSchema.optional().catch(undefined),
      dismissed: z.array(z.string()).optional().catch(undefined),
    }),
  }),
});

const DISMISSED_LIMIT = 20;

export const LEAD_ANSWER_METADATA_KEY = 'openchamberLeadAnswer';

export const leadAnswerSchema = z.object({ question: z.string(), answer: z.string() });

const openchamberSchema = z.object({ openchamber: z.record(z.string(), z.json()) });

type LeadDigest = z.infer<typeof digestSchema>;

const readLead = (metadata: Metadata | undefined) => parseMetadata(leadSchema, metadata).data?.openchamber.lead ?? null;

export const isLeadSession = (session: Session | null | undefined): boolean => readLead(session?.metadata) !== null;

const sameText = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();

export const getLeadDigest = (session: Session | null | undefined): LeadDigest | null => {
  const lead = readLead(session?.metadata);
  const digest = lead?.digest;
  if (!digest) return null;
  const dismissed = new Set((lead.dismissed ?? []).map(sameText));
  const visible = { ...digest, suggestions: digest.suggestions.filter((item) => !dismissed.has(sameText(item))) };
  if (visible.needsYou.length + visible.now.length + visible.news.length + visible.suggestions.length === 0) return null;
  return visible;
};

export const withDismissedSuggestion = (metadata: Metadata, item: string): Metadata => {
  const lead = readLead(metadata);
  if (!lead) return metadata;
  const namespace = openchamberSchema.safeParse(metadata).data?.openchamber ?? {};
  const dismissed = [...(lead.dismissed ?? []).filter((entry) => sameText(entry) !== sameText(item)), item].slice(-DISMISSED_LIMIT);
  const stored = z.record(z.string(), z.json()).safeParse(namespace.lead).data ?? {};
  return { ...metadata, openchamber: { ...namespace, lead: { ...stored, dismissed } } };
};

export const newLeadMarker = (now: number) => ({ at: now });

export const withSessionLead = (metadata: Metadata, lead: boolean, now: number): Metadata => {
  const namespace = openchamberSchema.safeParse(metadata).data?.openchamber ?? {};
  if (lead) {
    if (readLead(metadata)) return metadata;
    return { ...metadata, openchamber: { ...namespace, lead: newLeadMarker(now) } };
  }
  if (!readLead(metadata)) return metadata;
  const rest = { ...namespace };
  delete rest.lead;
  return { ...metadata, openchamber: rest };
};
