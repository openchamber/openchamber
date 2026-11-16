
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

const defaultOf = (field) => {
  switch (field.type) {
    case 'string':
      return typeof field.default === 'string' && field.default.trim() ? field.default : undefined;
    case 'number':
    case 'integer':
      return isFiniteNumber(field.default) ? field.default : undefined;
    case 'boolean':
      return typeof field.default === 'boolean' ? field.default : false;
    case 'multiselect':
      return Array.isArray(field.default) && field.default.length > 0 ? [...field.default] : undefined;
    default:
      return undefined;
  }
};

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
