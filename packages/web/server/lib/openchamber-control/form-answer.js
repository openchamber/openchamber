/**
 * The reply OpenCode accepts for a form a service answers, built the way the
 * chat's form card builds it (`packages/ui/src/components/chat/formCardState.ts`):
 * every field starts from its declared default, the service's values replace
 * them, and only fields active under their `when` clauses contribute. OpenCode
 * fills in no default and refuses a value for an inactive field, so passing
 * the service's values through would fail a form with a hidden field or a
 * condition the service did not evaluate.
 */

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

const defaultOf = (field) => {
  switch (field.type) {
    case 'string':
      return typeof field.default === 'string' && field.default.trim() ? field.default : undefined;
    case 'number':
    case 'integer':
      return isFiniteNumber(field.default) ? field.default : undefined;
    case 'boolean':
      // The card shows an untouched switch as off and sends it so.
      return typeof field.default === 'boolean' ? field.default : false;
    case 'multiselect':
      return Array.isArray(field.default) && field.default.length > 0 ? [...field.default] : undefined;
    default:
      return undefined;
  }
};

/** OpenCode's `matches()`: a clause against an unanswered field is false for both `eq` and `neq`. */
const clauseMatches = (clause, answer) => {
  if (answer === undefined) return false;
  const hit = Array.isArray(answer) ? answer.some((entry) => entry === clause.value) : answer === clause.value;
  return clause.op === 'eq' ? hit : !hit;
};

/**
 * @param {Array<{ key: string, type: string, default?: unknown, when?: Array<{ key: string, op: 'eq' | 'neq', value: unknown }> }>} fields
 * @param {Record<string, unknown>} values
 */
export const completeFormAnswer = (fields, values) => {
  const answer = {};
  for (const field of Array.isArray(fields) ? fields : []) {
    if (!field || typeof field.key !== 'string') continue;
    const given = Object.hasOwn(values, field.key) ? values[field.key] : undefined;
    // A link only the user can open is never gated; the service answers it or the reply misses it.
    if (field.type === 'external') {
      if (given !== undefined) answer[field.key] = given;
      continue;
    }
    if (!(field.when ?? []).every((clause) => clauseMatches(clause, answer[clause.key]))) continue;
    const value = given !== undefined ? given : defaultOf(field);
    if (value !== undefined) answer[field.key] = value;
  }
  return answer;
};
