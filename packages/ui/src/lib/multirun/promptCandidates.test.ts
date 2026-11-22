import { expect, test } from 'bun:test';
import { generatePromptCandidates, parsePromptCandidates, selectPromptCandidates } from './promptCandidates';

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
  const result = await generatePromptCandidates({ original: 'Original API task', description: 'One variation and one brand-new prompt', models, directory: '/repo' }, async (prompt, options) => {
    expect(prompt).toContain('Original API task');
    expect(prompt).toContain('One variation and one brand-new prompt');
    expect(options?.directory).toBe('/repo');
    if (!options?.model) throw new Error('Model selection missing');
    calls.push(options.model.id);
    if (options.model.id === 'bad') throw new Error('provider failure');
    expect(options.model.variant).toBe('high');
    return JSON.stringify({ candidates: [{ title: 'Candidate', text: 'Run the actual variation', kind: 'variation' }] });
  });
  expect(calls).toEqual(['good', 'bad']);
  expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0].model).toEqual(models[0]);
  expect(result.failedModels).toEqual([models[1]]);
  expect(selectPromptCandidates(result.candidates, new Set())).toEqual([]);
});

test('supports new prompts without an original and multiselects only chosen candidates', async () => {
  const result = await generatePromptCandidates({ original: '', description: 'Brand-new prompts', models: [{ providerID: 'p', id: 'm' }], directory: '/repo' }, async () => JSON.stringify({ candidates: [
    { title: 'A', text: 'Task A', kind: 'new' }, { title: 'B', text: 'Task B', kind: 'new' }, { title: 'C', text: 'Task C', kind: 'new' },
  ] }));
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
