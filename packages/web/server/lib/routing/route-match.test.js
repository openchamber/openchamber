import { describe, expect, it } from 'vitest';
import { expressionTerms, matchExpressionProblem, parseMatchExpression } from './route-match.js';

// Oracle: OpenCode's model-route-match grammar and examples, pinned at b70580b.
describe('OpenCode pool matching grammar', () => {
  it.each(['*luna*', '(*luna* or *haiku*) and not *-mini', "'re:gpt-(5|6)$' or small", 'NOT (cheap OR fast)', '"and"'])('accepts %s', (source) => {
    expect(matchExpressionProblem(source)).toBeNull();
  });
  it.each(['', '(', 'a b', 'a xor b', 'a and', 'a)', "'unclosed", 're:', "'re:('"] )('refuses %s', (source) => {
    expect(matchExpressionProblem(source)).toBeTruthy();
  });
  it('tracks positive references through nested negation', () => {
    const parsed = parseMatchExpression('cheap or not (fast and not sturdy)');
    expect(parsed.error).toBeUndefined();
    expect(expressionTerms(parsed.expression)).toEqual([
      { text: 'cheap', negated: false }, { text: 'fast', negated: true }, { text: 'sturdy', negated: false },
    ]);
  });
});
