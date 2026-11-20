import { z } from 'zod';

import { parseMetadata } from '@/lib/metadataParse';
import type { Metadata, Session } from '@/lib/opencode/model';

const digestSchema = z.object({
  needsYou: z.array(z.string()).catch([]),
  now: z.array(z.string()).catch([]),
  news: z.array(z.string()).catch([]),
  updatedAt: z.number().finite(),
});

const leadSchema = z.object({
  openchamber: z.object({
    lead: z.object({ at: z.number().finite(), digest: digestSchema.optional().catch(undefined) }),
  }),
});

const openchamberSchema = z.object({ openchamber: z.record(z.string(), z.json()) });

type LeadDigest = z.infer<typeof digestSchema>;

const readLead = (metadata: Metadata | undefined) => parseMetadata(leadSchema, metadata).data?.openchamber.lead ?? null;

export const isLeadSession = (session: Session | null | undefined): boolean => readLead(session?.metadata) !== null;

export const getLeadDigest = (session: Session | null | undefined): LeadDigest | null => {
  const digest = readLead(session?.metadata)?.digest;
  if (!digest || digest.needsYou.length + digest.now.length + digest.news.length === 0) return null;
  return digest;
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
