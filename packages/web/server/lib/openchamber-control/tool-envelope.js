/**
 * Reading the envelope OpenChamber's agent tools answer
 * (`../agent-tool/runtime.js`) back from the text OpenCode stored for a call.
 * Behind Code Mode that text is what the `execute` script returned: usually
 * the envelope as is, sometimes the same JSON quoted once more.
 */
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

/** The envelope the text holds, or `null` for anything else. */
export const readToolEnvelope = (text) => {
  const outer = jsonText.safeParse(text);
  if (!outer.success) return null;
  const inner = jsonText.safeParse(outer.data);
  const parsed = envelopeSchema.safeParse(inner.success ? inner.data : outer.data);
  return parsed.success ? parsed.data : null;
};
