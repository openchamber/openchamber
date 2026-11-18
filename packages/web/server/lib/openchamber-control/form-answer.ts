
export interface FormField {
  key: string;
  type: string;
  default?: unknown;
  when?: readonly FormClause[];
}

interface FormClause {
  key: string;
  op: 'eq' | 'neq';
  value: unknown;
}

export interface FormValues {
  [key: string]: FormField['default'];
}

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isText = (value: unknown): value is string => typeof value === 'string';
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';

const defaultOf = (field: FormField) => {
  switch (field.type) {
    case 'string':
      return isText(field.default) && field.default.trim() ? field.default : undefined;
    case 'number':
    case 'integer':
      return isFiniteNumber(field.default) ? field.default : undefined;
    case 'boolean':
      return isBoolean(field.default) ? field.default : false;
    case 'multiselect':
      return Array.isArray(field.default) && field.default.length > 0 ? [...field.default] : undefined;
    default:
      return undefined;
  }
};

const clauseMatches = (clause: FormClause, answer: FormValues[string]) => {
  if (answer === undefined) return false;
  const hit = Array.isArray(answer) ? answer.some((entry) => entry === clause.value) : answer === clause.value;
  return clause.op === 'eq' ? hit : !hit;
};

export const completeFormAnswer = (fields: readonly FormField[], values: FormValues) => {
  const answer: FormValues = {};
  const formFields: readonly FormField[] = Array.isArray(fields) ? fields : [];
  for (const field of formFields) {
    if (!field || !isText(field.key)) continue;
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
