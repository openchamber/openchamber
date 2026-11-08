import { isPlainObject, isString } from '../shared/guards.js';

/**
 * The part of JSON Schema a workflow's agent({ schema }) uses: type,
 * properties, required, additionalProperties: false, items and enum. Other
 * keywords are accepted and not checked; an agent that gets the shape right
 * on these passes, which is what the script relies on.
 *
 * Answers the first mismatch as a sentence the agent can act on, or null.
 */

const TYPE_CHECKS = {
  object: isPlainObject,
  array: Array.isArray,
  string: isString,
  number: Number.isFinite,
  integer: Number.isInteger,
  boolean: (value) => value === true || value === false,
  null: (value) => value === null,
};

const pointer = (path) => (path.length === 0 ? 'the answer' : path.join('.'));

export const validateJsonSchema = (schema, value, path = []) => {
  if (!isPlainObject(schema)) return null;
  const types = Array.isArray(schema.type) ? schema.type : (isString(schema.type) ? [schema.type] : []);
  if (types.length > 0 && !types.some((type) => TYPE_CHECKS[type]?.(value))) {
    return `${pointer(path)} must be ${types.join(' or ')}`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) {
    return `${pointer(path)} must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(', ')}`;
  }
  if (isPlainObject(value)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.hasOwn(value, key)) return `${pointer([...path, key])} is required`;
    }
    if (schema.additionalProperties === false) {
      const extra = Object.keys(value).find((key) => !Object.hasOwn(properties, key));
      if (extra) return `${pointer([...path, extra])} is not allowed`;
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (!Object.hasOwn(value, key)) continue;
      const error = validateJsonSchema(propertySchema, value[key], [...path, key]);
      if (error) return error;
    }
  }
  if (Array.isArray(value) && isPlainObject(schema.items)) {
    for (const [index, item] of value.entries()) {
      const error = validateJsonSchema(schema.items, item, [...path, String(index)]);
      if (error) return error;
    }
  }
  return null;
};

/**
 * A `required` key that `additionalProperties: false` rules out can never be
 * satisfied; such a schema fails before an agent spends anything on it.
 */
export const findSchemaContradiction = (schema, path = []) => {
  if (!isPlainObject(schema)) return null;
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  if (schema.additionalProperties === false && Array.isArray(schema.required)) {
    const impossible = schema.required.find((key) => !Object.hasOwn(properties, key));
    if (impossible) return `${pointer([...path, impossible])} is required but additionalProperties: false leaves it out of properties`;
  }
  for (const [key, propertySchema] of Object.entries(properties)) {
    const nested = findSchemaContradiction(propertySchema, [...path, key]);
    if (nested) return nested;
  }
  return isPlainObject(schema.items) ? findSchemaContradiction(schema.items, [...path, '[]']) : null;
};

/**
 * The JSON an agent answered with: the whole reply, else its last fenced
 * block. Null when neither parses.
 */
export const parseJsonAnswer = (text) => {
  const candidates = [text.trim()];
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((match) => match[1].trim());
  candidates.push(...fenced.reverse());
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return { value: JSON.parse(candidate) };
    } catch {
      // Try the next candidate.
    }
  }
  return null;
};
