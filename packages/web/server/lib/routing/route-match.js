/**
 * The matching grammar of a model pool, as OpenCode reads it
 * (packages/core/src/model-route-match.ts in the fork OpenChamber pins).
 * OpenCode skips a whole pool whose `include`, `exclude`, `match` or
 * `variantRules` entry it cannot read, and says so only in its log, so the
 * validator refuses those entries here where the user can see why.
 *
 * Restated rather than imported: the server is plain JavaScript and never
 * loads OpenCode's packages. `route-match.test.js` pins the accepted and
 * refused shapes against OpenCode's own documented examples.
 */

const TOKEN = /\s+|[()]|'[^']*'|"[^"]*"|[^\s()]+/g;

/**
 * Why OpenCode refuses one pattern, or null. `re:` starts a regular
 * expression compiled with the `i` flag; anything else is a glob where `*`
 * stands for any run of characters.
 */
export const patternProblem = (text) => {
  if (text === '' || text === 're:') return 'is an empty pattern';
  if (!text.startsWith('re:')) return null;
  try {
    new RegExp(text.slice(3), 'i');
    return null;
  } catch (error) {
    return `is not a regular expression OpenCode can compile (${error instanceof Error ? error.message : String(error)})`;
  }
};

/**
 * Parses a `match` expression: terms joined by `and`, `or` and `not`, with
 * parentheses. `not` binds tightest and `or` loosest; a quoted token is
 * always a term. Returns `{ expression }` or `{ error }` with OpenCode's
 * wording.
 */
export const parseMatchExpression = (source) => {
  const tokens = Array.from(String(source).matchAll(TOKEN), (match) => match[0]).filter((token) => token.trim() !== '');
  const unclosed = tokens.find((token) => /^['"]/.test(token) && (token.length < 2 || !token.endsWith(token[0])));
  if (unclosed !== undefined) return { error: `unclosed quote in ${unclosed}` };
  if (tokens.length === 0) return { error: 'empty expression' };
  const keyword = (index, word) => tokens[index]?.toLowerCase() === word;
  const shown = (index) => (index < tokens.length ? `"${tokens[index]}"` : 'the end');

  const primary = (index) => {
    if (tokens[index] === '(') {
      const inner = either(index + 1);
      if (inner.error) return inner;
      return tokens[inner.next] === ')'
        ? { expression: inner.expression, next: inner.next + 1 }
        : { error: `missing ")" before ${shown(inner.next)}` };
    }
    if (index >= tokens.length || tokens[index] === ')' || keyword(index, 'and') || keyword(index, 'or'))
      return { error: `expected a pattern or pool name, found ${shown(index)}` };
    const token = tokens[index];
    const text = /^['"]/.test(token) ? token.slice(1, -1) : token;
    return { expression: { type: 'term', text }, next: index + 1 };
  };
  const negation = (index) => {
    if (!keyword(index, 'not')) return primary(index);
    const operand = negation(index + 1);
    return operand.error ? operand : { expression: { type: 'not', operand: operand.expression }, next: operand.next };
  };
  const chain = (type, operand) => (index) => {
    const first = operand(index);
    if (first.error || !keyword(first.next, type)) return first;
    const rest = chain(type, operand)(first.next + 1);
    return rest.error ? rest : { expression: { type, left: first.expression, right: rest.expression }, next: rest.next };
  };
  const both = chain('and', negation);
  const either = chain('or', both);

  const parsed = either(0);
  if (parsed.error) return { error: parsed.error };
  if (parsed.next === tokens.length) return { expression: parsed.expression };
  if (keyword(parsed.next, 'xor')) return { error: 'xor is not supported: write (a or b) and not (a and b)' };
  if (tokens[parsed.next] === ')') return { error: 'unmatched ")"' };
  return { error: `expected "and" or "or" before ${shown(parsed.next)}` };
};

/** Every term of a parsed expression, each with whether an odd number of `not`s negates it. */
export const expressionTerms = (expression, negated = false) => {
  if (expression.type === 'term') return [{ text: expression.text, negated }];
  if (expression.type === 'not') return expressionTerms(expression.operand, !negated);
  return [...expressionTerms(expression.left, negated), ...expressionTerms(expression.right, negated)];
};

/** Why OpenCode refuses a `match` expression, or null: its grammar first, then each term as a pattern. */
export const matchExpressionProblem = (source) => {
  const parsed = parseMatchExpression(source);
  if (parsed.error) return parsed.error;
  for (const term of expressionTerms(parsed.expression)) {
    const problem = patternProblem(term.text);
    if (problem) return `term "${term.text}" ${problem}`;
  }
  return null;
};
