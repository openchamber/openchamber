import type { SourceControlReferenceLink } from '@openchamber/ui/lib/api/types';
import { z } from 'zod';

type BoundaryScalar = string | number | boolean | null | undefined;

const isStringValue = (value: BoundaryScalar): value is string => Object.prototype.toString.call(value) === '[object String]';
const isNonEmptyString = (value: BoundaryScalar): value is string => isStringValue(value) && value.trim().length > 0;

export const isHttpUrl = (value: BoundaryScalar): value is string => {
  if (!isNonEmptyString(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
};

const sourceReferenceLinkSchema = z.object({
  kind: z.enum(['issue', 'pull', 'discussion']),
  number: z.number().int().positive(),
  title: z.string().optional(),
  url: z.string().refine(isHttpUrl),
  repo: z.string().optional(),
  createdAt: z.string().nullable(),
  author: z.object({ login: z.string().min(1), avatarUrl: z.string().optional() }).nullable().optional(),
  willCloseTarget: z.boolean().optional(),
});

export const parseSourceReferenceLinks = (references: unknown): SourceControlReferenceLink[] => {
  if (!Array.isArray(references)) return [];
  return references.flatMap((reference) => {
    const parsed = sourceReferenceLinkSchema.safeParse(reference);
    return parsed.success ? [parsed.data] : [];
  });
};
