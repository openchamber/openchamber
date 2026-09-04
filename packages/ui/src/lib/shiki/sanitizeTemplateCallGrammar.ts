/**
 * Neutralize the JavaScript/TypeScript TextMate `template-call` rule.
 *
 * Upstream grammars use a triple-nested `{()[]}` lookahead to detect tagged
 * templates with type arguments (`foo<T>\`...\``). On the Oniguruma WASM engine
 * shipped with Shiki — which does not expose `setRetryLimit` / match-stack
 * limits — that pattern can enter exponential backtracking on ordinary
 * backtick template literals, grow the WASM heap without bound, and OOM the
 * renderer (openchamber/openchamber#2587).
 *
 * Clearing `template-call` is safe: the plain `#template` rule still highlights
 * backticks and simple tagged templates. Only the rare `ident<TypeArgs>\`...\``
 * form loses its specialized type-argument coloring and falls through to
 * normal tokenization.
 */

type GrammarRepository = Record<string, { patterns?: unknown[] } | undefined>;

export type TemplateCallGrammar = {
  name?: string;
  repository?: GrammarRepository;
};

const TEMPLATE_CALL_KEY = 'template-call';

export const hasCatastrophicTemplateCall = (grammar: TemplateCallGrammar): boolean => {
  const patterns = grammar.repository?.[TEMPLATE_CALL_KEY]?.patterns;
  return Array.isArray(patterns) && patterns.length > 0;
};

export const sanitizeTemplateCallGrammar = <T extends TemplateCallGrammar>(grammar: T): T => {
  if (!hasCatastrophicTemplateCall(grammar)) return grammar;

  const repository = { ...grammar.repository };
  repository[TEMPLATE_CALL_KEY] = { patterns: [] };
  return { ...grammar, repository };
};
