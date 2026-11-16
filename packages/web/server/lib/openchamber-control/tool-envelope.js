import { z } from 'zod';

const envelopeSchema = z.object({
  ok: z.boolean(),
  action: z.string().min(1),
  data: z.unknown().optional(),
});

const jsonText = z.string().transform((text, context) => {
  try {
    return JSON.parse(text);
  } catch {
    context.addIssue({ code: 'custom', message: 'not JSON' });
    return z.NEVER;
  }
});

export const readToolEnvelope = (text) => {
  const outer = jsonText.safeParse(text);
  if (!outer.success) return null;
  const inner = jsonText.safeParse(outer.data);
  const parsed = envelopeSchema.safeParse(inner.success ? inner.data : outer.data);
  return parsed.success ? parsed.data : null;
};
