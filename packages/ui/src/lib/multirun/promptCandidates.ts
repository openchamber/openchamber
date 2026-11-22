import { z } from 'zod';
import type { Message, ModelSelection } from '@/lib/opencode/model';
import { OpencodeApiError, opencodeClient } from '@/lib/opencode/client';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { generateUuid } from '@/lib/uuid';
import type { PromptGenerationSession } from './identity';
import { registerMultiRunSession } from '@/stores/useMultiRunStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

// Candidates enter session prompts and render in a review dialog. The limits
// bound one model's response while leaving room for ordinary coding prompts.
const candidateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  text: z.string().trim().min(1).max(20_000),
  kind: z.enum(['variation', 'new']),
});
const candidatesSchema = z.object({ candidates: z.array(candidateSchema).min(1).max(20) });

export type PromptCandidate = z.infer<typeof candidateSchema> & { id: string; model: ModelSelection };
type PromptGenerationFailure = { model: ModelSelection; reason: 'model-unavailable' | 'generation' | 'retention' };
type PromptGenerationEffects = {
  create: typeof opencodeClient.createSession;
  generate: typeof opencodeClient.generateSessionText;
  record: typeof opencodeClient.recordPromptGeneration;
  archive: (id: string) => Promise<void>;
  publish: typeof registerMultiRunSession;
};
const effects: PromptGenerationEffects = {
  create: (params, directory) => opencodeClient.createSession(params, directory),
  generate: (id, prompt, directory) => opencodeClient.generateSessionText(id, prompt, directory),
  record: (id, kind, text, directory) => opencodeClient.recordPromptGeneration(id, kind, text, directory),
  archive: async (id) => {
    const result = await useSessionUIStore.getState().archiveSessions([id]);
    if (result.failedIds.includes(id)) throw new Error('Generation session could not be archived');
  },
  publish: registerMultiRunSession,
};

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
  title?: string;
}, io: PromptGenerationEffects = effects): Promise<{
  candidates: PromptCandidate[];
  failures: PromptGenerationFailure[];
  generationSessions: PromptGenerationSession[];
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
  const generationSessions: PromptGenerationSession[] = [];
  const outcomes = await Promise.allSettled(input.models.map(async (model) => {
    assertCurrent();
    const session = await io.create({ title: input.title ? `${input.title} · ${model.id}` : model.id, model,
      // Candidate generation must never acquire file, shell, MCP, or other
      // tool authority through the session's configured agent.
      permissions: [{ action: '*', resource: '*', effect: 'deny' }],
      metadata: { openchamber: { kind: 'prompt-generation' } } }, input.directory);
    assertCurrent();
    generationSessions.push({ sessionID: session.id, directory: session.directory, providerID: model.providerID, modelID: model.id, variant: model.variant ?? undefined });
    io.publish(session, session.directory);
    let archived = false;
    let retentionFailed = false;
    try { await io.archive(session.id); assertCurrent(); archived = true; } catch { assertCurrent(); }
    let output: string | undefined;
    let failure: PromptGenerationFailure | undefined;
    try {
      // Synthetic records without a user turn are not included in generation
      // context, so send the full request and retain its history separately.
      output = await io.generate(session.id, prompt, session.directory);
      assertCurrent();
    } catch (error) { assertCurrent(); failure = { model, reason: error instanceof OpencodeApiError && modelUnavailable(error) ? 'model-unavailable' : 'generation' }; }
    try { await io.record(session.id, 'request', prompt, session.directory); assertCurrent(); }
    catch { assertCurrent(); retentionFailed = true; }
    if (output !== undefined) {
      try { await io.record(session.id, 'result', output, session.directory); assertCurrent(); }
      catch { assertCurrent(); retentionFailed = true; }
    }
    if (!archived) {
      try { await io.archive(session.id); assertCurrent(); } catch { assertCurrent(); retentionFailed = true; }
    }
    const failures: PromptGenerationFailure[] = failure ? [failure] : [];
    if (retentionFailed) failures.push({ model, reason: 'retention' });
    let candidates: PromptCandidate[] = [];
    if (output !== undefined) {
      try { candidates = parsePromptCandidates(output).map((candidate): PromptCandidate => ({ ...candidate, id: generateUuid(), model })); }
      catch { failures.push({ model, reason: 'generation' }); }
    }
    return { candidates, failures };
  }));
  assertCurrent();
  const candidates: PromptCandidate[] = [];
  const failures: PromptGenerationFailure[] = [];
  outcomes.forEach((outcome, index) => {
    if (outcome.status === 'fulfilled') { candidates.push(...outcome.value.candidates); failures.push(...outcome.value.failures); }
    else failures.push({ model: input.models[index], reason: outcome.reason instanceof OpencodeApiError && modelUnavailable(outcome.reason) ? 'model-unavailable' : 'generation' });
  });
  return { candidates, failures, generationSessions };
}

const modelUnavailable = (error: OpencodeApiError): boolean => error.tag === 'ModelNotFoundError'
  || error.tag === 'ProviderNotFoundError' || error.detail.includes('Model unavailable: ');

/** Selection is explicit; no candidate is admitted merely because it was generated. */
export function selectPromptCandidates(candidates: readonly PromptCandidate[], selectedIds: ReadonlySet<string>): PromptCandidate[] {
  return candidates.filter((candidate) => selectedIds.has(candidate.id));
}

const generationRecordSchema = z.object({ openchamberPromptGeneration: z.object({ kind: z.enum(['request', 'result']) }) });

/** Read the retained records themselves; the transient generation never made an assistant turn. */
export async function loadPromptGenerationSession(source: Pick<PromptGenerationSession, 'sessionID' | 'directory'>): Promise<{ request: string | null; result: string | null }> {
  const runtime = getRuntimeKey();
  const client = opencodeClient.getSdkClient();
  const current = () => { if (getRuntimeKey() !== runtime || opencodeClient.getSdkClient() !== client) throw new Error('Runtime changed'); };
  const page = await opencodeClient.getSessionMessages(source.sessionID, { order: 'asc', limit: 200 }, source.directory);
  current();
  let request: string | null = null;
  let result: string | null = null;
  const retain = (info: Message) => {
    if (info.role !== 'synthetic') return;
    const parsed = generationRecordSchema.safeParse(info.metadata);
    if (!parsed.success) return;
    if (parsed.data.openchamberPromptGeneration.kind === 'request' && request === null) request = info.text;
    if (parsed.data.openchamberPromptGeneration.kind === 'result' && result === null) result = info.text;
  };
  for (const entry of page.items) retain(entry.info);
  // resume:false synthetic records are durable inbox entries until another
  // turn admits them. Archived generation sessions deliberately never run it.
  if (request === null || result === null) {
    const inbox = await opencodeClient.getSessionInbox(source.sessionID, source.directory);
    current();
    for (const entry of inbox) retain(entry.info);
  }
  return { request, result };
}
