import { z } from 'zod';
import type { ModelSelection } from '@/lib/opencode/model';
import { OpencodeApiError, opencodeClient } from '@/lib/opencode/client';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { generateUuid } from '@/lib/uuid';

// Candidates enter session prompts and render in a review dialog. The limits
// bound one model's response while leaving room for ordinary coding prompts.
const candidateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  text: z.string().trim().min(1).max(20_000),
  kind: z.enum(['variation', 'new']),
});
const candidatesSchema = z.object({ candidates: z.array(candidateSchema).min(1).max(20) });

export type PromptCandidate = z.infer<typeof candidateSchema> & { id: string; model: ModelSelection };
type PromptGenerationFailure = { model: ModelSelection; reason: 'model-unavailable' | 'generation' };

export function parsePromptCandidates(output: string): Array<z.infer<typeof candidateSchema>> {
  const text = output.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return candidatesSchema.parse(JSON.parse(fence?.[1] ?? text)).candidates;
}

export async function generatePromptCandidates(input: {
  original: string;
  description: string;
  models: readonly ModelSelection[];
  directory: string;
}, generate: typeof opencodeClient.generateText = (prompt, options) => opencodeClient.generateText(prompt, options)): Promise<{
  candidates: PromptCandidate[];
  failures: PromptGenerationFailure[];
}> {
  if (!input.description.trim() || input.models.length === 0 || !input.directory.trim()) throw new Error('Describe prompts, select a generation model, and choose a directory');
  const runtime = getRuntimeKey();
  const client = opencodeClient.getSdkClient();
  const assertCurrent = () => {
    if (getRuntimeKey() !== runtime || opencodeClient.getSdkClient() !== client) throw new Error('Runtime changed');
  };
  const prompt = [
    'Generate candidate prompts for the user to review before running them. Do not execute any candidate or answer its task.',
    'The description can request variations on the original prompt, entirely new prompts, or both. Follow the requested mix. Each prompt must stand alone and include the context needed to run it independently. Variations preserve the original prompt\'s identifiers and explicit constraints. Entirely new prompts include original context only when relevant to the requested new task.',
    'Return only JSON with this shape: {"candidates":[{"title":"short title","text":"complete runnable prompt","kind":"variation"}]}. Use kind "variation" or "new". Return at most 20 candidates in the user\'s language.',
    `Original prompt, which may be empty:\n${input.original}`,
    `User description of the desired candidates:\n${input.description.trim()}`,
  ].join('\n\n');
  const outcomes = await Promise.allSettled(input.models.map(async (model) => {
    assertCurrent();
    const output = await generate(prompt, { model, directory: input.directory });
    assertCurrent();
    return parsePromptCandidates(output).map((candidate): PromptCandidate => ({ ...candidate, id: generateUuid(), model }));
  }));
  assertCurrent();
  const candidates: PromptCandidate[] = [];
  const failures: PromptGenerationFailure[] = [];
  outcomes.forEach((outcome, index) => {
    if (outcome.status === 'fulfilled') candidates.push(...outcome.value);
    else {
      const error = outcome.reason;
      // The stateless route deliberately resolves models from server-wide
      // configuration, even when a scoped client sends a directory header.
      const unavailable = error instanceof OpencodeApiError && error.operation === 'generate.text'
        && ((error.status === 400 && error.detail.startsWith('Model unavailable: '))
          || error.tag === 'ModelNotFoundError' || error.tag === 'ProviderNotFoundError');
      failures.push({ model: input.models[index], reason: unavailable ? 'model-unavailable' : 'generation' });
    }
  });
  return { candidates, failures };
}

/** Selection is explicit; no candidate is admitted merely because it was generated. */
export function selectPromptCandidates(candidates: readonly PromptCandidate[], selectedIds: ReadonlySet<string>): PromptCandidate[] {
  return candidates.filter((candidate) => selectedIds.has(candidate.id));
}
