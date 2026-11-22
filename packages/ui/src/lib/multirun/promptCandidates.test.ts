import { expect, test } from 'bun:test';
import { generatePromptCandidates, parsePromptCandidates, selectPromptCandidates } from './promptCandidates';
import { OpencodeApiError, opencodeClient } from '@/lib/opencode/client';
import type { ModelSelection, Session } from '@/lib/opencode/model';

function generationIO(generate: typeof opencodeClient.generateText): NonNullable<Parameters<typeof generatePromptCandidates>[1]> {
  const models = new Map<string, ModelSelection>();
  const requests = new Map<string, string>();
  const directories = new Map<string, string>();
  return {
    create: async (params, directory) => {
      if (!params?.model || !directory) throw new Error('Missing generation model or directory');
      const id = `generation-${models.size}`;
      models.set(id, params.model); directories.set(id, directory);
      const session: Session = { id, projectID: 'p', directory, title: params.title ?? id,
        model: { providerID: params.model.providerID, id: params.model.id, variant: params.model.variant ?? undefined },
        cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 }, metadata: params.metadata };
      return session;
    },
    generate: async (id, hint) => {
      const model = models.get(id);
      if (!model) throw new Error('Missing generation session');
      return generate(requests.get(id) ?? hint, { model, directory: directories.get(id) });
    },
    record: async (id, kind, text) => { if (kind === 'request') requests.set(id, text); },
    archive: async () => {}, publish: (session) => session,
  };
}

// Oracle: the declared candidate JSON schema and the explicit selected-ID set.
test('accepts variations and new prompts and preserves complete prompt text', () => {
  const candidates = [
    { title: 'Review', text: 'Keep identifier api_v2.\nCheck the parser.', kind: 'variation' },
    { title: 'New work', text: 'Write a new accessibility audit.', kind: 'new' },
  ];
  expect(parsePromptCandidates(JSON.stringify({ candidates }))).toEqual(candidates);
  expect(parsePromptCandidates(`\`\`\`json\n${JSON.stringify({ candidates })}\n\`\`\``)).toEqual(candidates);
});

for (const output of ['invalid', '{}', '{"candidates":[]}', '{"candidates":[{"title":"","text":"x","kind":"new"}]}', '{"candidates":[{"title":"x","text":"","kind":"new"}]}', '{"candidates":[{"title":"x","text":"y","kind":"execute"}]}']) {
  test(`rejects invalid generation output ${output}`, () => { expect(() => parsePromptCandidates(output)).toThrow(); });
}

test('generates with each chosen model, forwards its effort, and preserves successful candidates after partial failure', async () => {
  const models = [{ providerID: 'p', id: 'good', variant: 'high' }, { providerID: 'p', id: 'bad' }];
  const calls: string[] = [];
  const result = await generatePromptCandidates({ original: 'Original API task', description: 'One variation and one brand-new prompt', models, directory: '/repo' }, generationIO(async (prompt, options) => {
    expect(prompt).toContain('Original API task');
    expect(prompt).toContain('One variation and one brand-new prompt');
    expect(options?.directory).toBe('/repo');
    if (!options?.model) throw new Error('Model selection missing');
    calls.push(options.model.id);
    if (options.model.id === 'bad') throw new Error('provider failure');
    expect(options.model.variant).toBe('high');
    return JSON.stringify({ candidates: [{ title: 'Candidate', text: 'Run the actual variation', kind: 'variation' }] });
  }));
  expect(calls).toEqual(['good', 'bad']);
  expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0].model).toEqual(models[0]);
  expect(result.failures).toEqual([{ model: models[1], reason: 'generation' }]);
  expect(selectPromptCandidates(result.candidates, new Set())).toEqual([]);
});

test('project-only model failure names server-wide unavailability while retaining successful candidates', async () => {
  const models = [{ providerID: 'project', id: 'only-here' }, { providerID: 'global', id: 'available' }];
  const result = await generatePromptCandidates({ original: 'Original', description: 'Two variations', models, directory: '/repo' }, generationIO(async (_prompt, options) => {
    if (options?.model?.providerID === 'project') throw new OpencodeApiError('generate.text', 'Model unavailable: project/only-here', { status: 400 });
    return JSON.stringify({ candidates: [{ title: 'Available', text: 'Keep the successful prompt', kind: 'variation' }] });
  }));
  expect(result.failures).toEqual([{ model: models[0], reason: 'model-unavailable' }]);
  expect(result.candidates.map((candidate) => candidate.text)).toEqual(['Keep the successful prompt']);
});

test('supports new prompts without an original and multiselects only chosen candidates', async () => {
  const result = await generatePromptCandidates({ original: '', description: 'Brand-new prompts', models: [{ providerID: 'p', id: 'm' }], directory: '/repo' }, generationIO(async () => JSON.stringify({ candidates: [
    { title: 'A', text: 'Task A', kind: 'new' }, { title: 'B', text: 'Task B', kind: 'new' }, { title: 'C', text: 'Task C', kind: 'new' },
  ] })));
  const before = JSON.stringify(result.candidates);
  const chosen = selectPromptCandidates(result.candidates, new Set([result.candidates[0].id, result.candidates[2].id, 'unknown']));
  expect(chosen.map((candidate) => candidate.text)).toEqual(['Task A', 'Task C']);
  expect(JSON.stringify(result.candidates)).toBe(before);
  expect(new Set(result.candidates.map((candidate) => candidate.id)).size).toBe(3);
});

test('generated Unicode prompts round-trip without altering internal whitespace or identifiers', () => {
  let seed = 0x99ae4;
  for (let index = 0; index < 2_000; index += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const value = { title: `Task ${index}`, text: `Keep api_${seed}.\n  العربية 日本語 😀\n\t${seed}`, kind: 'variation' };
    expect(parsePromptCandidates(JSON.stringify({ candidates: [value] }))).toEqual([value]);
  }
});

test('retention failure preserves usable candidates and generation session references', async () => {
  const io = generationIO(async () => JSON.stringify({ candidates: [{ title: 'Kept', text: 'Keep the generated prompt.', kind: 'new' }] }));
  io.archive = async () => { throw new Error('Archive failed'); };
  io.record = async () => { throw new Error('Record failed'); };
  const model = { providerID: 'p', id: 'm' };
  const result = await generatePromptCandidates({ original: '', description: 'New task', models: [model], directory: '/repo' }, io);
  expect(result.candidates.map((candidate) => candidate.text)).toEqual(['Keep the generated prompt.']);
  expect(result.generationSessions.map((session) => session.sessionID)).toEqual(['generation-0']);
  expect(result.failures).toEqual([{ model, reason: 'retention' }]);
});
