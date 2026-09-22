import { describe, expect, mock, test } from 'bun:test';

/**
 * Contract tests for the DEFAULT Enhance Prompt instructions
 * (`composer.enhance.instructions`). The template is the behavioral contract
 * for the rewrite: it must frame the operation as semantic normalization of
 * the draft's whole meaning — never routing on individual keywords or verbs —
 * and must preserve the action ceiling, compound and conditional actions,
 * uncertainty, unresolved references, and entity identity, while forbidding
 * factual invention, boilerplate, and over-expansion. These assertions anchor
 * on distinctive phrases of the template, not the full text — the exact
 * wording may evolve, the contract may not. They test the instruction
 * contract only; model behavior against real drafts is covered by the manual
 * semantic eval in `enhance/SEMANTIC_EVAL.md`.
 *
 * Only `@/lib/runtime-fetch` is replaced (the sibling tests' precedent):
 * the getter under test is pure and touches no network.
 */
mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: async (): Promise<Response> => {
    throw new Error('runtime-fetch must not be reached by template lookups');
  },
}));

const { getDefaultMagicPromptTemplate } = await import('@/lib/magicPrompts');

const template = getDefaultMagicPromptTemplate('composer.enhance.instructions');

describe('enhance instructions default template contract', () => {
  test('frames the operation as semantic normalization, not copy editing', () => {
    expect(template).toMatch(/semantic normalization, not copy editing/i);
    expect(template).toMatch(/meaning of the draft as a whole/i);
  });

  test('explicitly rejects routing on keywords and trigger phrases', () => {
    expect(template).toMatch(/not from individual keywords, verbs, trigger phrases/i);
    expect(template).toMatch(/Never route or rewrite by matching a phrase to a canned template/i);
  });

  test('preserves the action ceiling across understand and modification intent', () => {
    // Authorization must be bounded by the complete meaning of the draft…
    expect(template).toMatch(/Do not authorize any action beyond what the complete meaning of the draft supports/i);
    // …and an information-seeking request must not become a change request,
    // while authorized modification may include the necessary understanding,
    // but never unrelated work.
    expect(template).toMatch(/into a request to change that target/i);
    expect(template).toMatch(/must not expand into unrelated work/i);
  });

  test('preserves compound actions and their meaningful order', () => {
    expect(template).toMatch(/preserve all of them and their meaningful order/i);
  });

  test('preserves conditional authorization', () => {
    expect(template).toMatch(/preserve that condition rather than converting it into unconditional authorization/i);
  });

  test('limits inference to strong semantic consequences', () => {
    expect(template).toMatch(/strongly supported by the meaning of the draft/i);
  });

  test('preserves uncertainty when confidence is low', () => {
    expect(template).toMatch(/incomplete refinement is better than a confident invented requirement/i);
  });

  test('forbids factual invention', () => {
    expect(template).toMatch(/Never invent:/);
    expect(template).toMatch(/factual context;/);
    expect(template).toMatch(/causes or diagnoses;/);
    expect(template).toMatch(/files or modules;/);
    expect(template).toMatch(/libraries or technologies;/);
    expect(template).toMatch(/information from conversation history, external tools, files, or sources that are not present in the draft/);
  });

  test('preserves unresolved references instead of resolving them from own knowledge', () => {
    expect(template).toMatch(/Do not resolve ambiguous or contextual references from your own knowledge/i);
    expect(template).toMatch(/preserve them unless the draft itself resolves them/i);
  });

  test('preserves entity identity without requiring exact presentation', () => {
    expect(template).toMatch(/Preserve entity identity/i);
    expect(template).toMatch(/normalize harmless presentation when it does not change meaning/i);
    expect(template).toMatch(/never reinterpret or enrich an entity using outside knowledge/i);
  });

  test('keeps already-precise prompts concise and forbids boilerplate', () => {
    expect(template).toMatch(/Do not turn every short request into a specification/i);
    expect(template).toMatch(/Do not add generic boilerplate/i);
    expect(template).toMatch(/Do not automatically add implementation plans, tests, documentation, refactors, cleanup, dependencies, or broader scope/i);
    expect(template).toMatch(/Do not over-specify how to accomplish an outcome when the user specified only the outcome/i);
  });

  test('never answers or executes the draft', () => {
    expect(template).toMatch(/Never answer it, execute it, solve it, or perform the requested work/i);
  });

  test('preserves composer references', () => {
    expect(template).toMatch(/composer references such as @ mentions, \/ commands, and # snippets/i);
  });

  test('returns only the rewritten prompt', () => {
    expect(template).toMatch(/Return only the rewritten prompt/i);
  });
});
