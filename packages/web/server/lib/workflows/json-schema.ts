import { isBoolean, isPlainObject, isString } from '../shared/guards.js';
import type { JsonValue } from '../shared/json-values.js';
import type { WorkflowInput } from './contracts.js';

const isNull = (value: unknown): value is null => value === null;

const TYPE_CHECKS = {
  object: isPlainObject,
  array: Array.isArray,
  string: isString,
  number: Number.isFinite,
  integer: Number.isInteger,
  boolean: isBoolean,
  null: isNull,
};

const pointer = (path: readonly unknown[]) => (path.length === 0 ? 'the answer' : path.join('.'));

const includesKey = <Owner extends object, Key extends PropertyKey>(owner: Owner, key: Key): owner is Owner & Record<Key, unknown> => key in owner;

const lookup = <Owner extends object>(owner: Owner, key: PropertyKey) => includesKey(owner, key) ? owner[key] : undefined;

const isPropertyKey = (value: unknown): value is PropertyKey =>
  isString(value) || typeof value === 'number' || typeof value === 'symbol';

const isTypeCheck = (value: unknown): value is (this: typeof TYPE_CHECKS, input: WorkflowInput['answer']) => WorkflowInput['answer'] =>
  typeof value === 'function';

function propertyKey(key: WorkflowInput['answer']): PropertyKey {
  if (isPropertyKey(key)) return key;
  const [coerced] = Reflect.ownKeys(Object.fromEntries([[key, null]]));
  if (coerced === undefined) throw new TypeError('No property key');
  return coerced;
}

function matchesType(type: WorkflowInput['answer'], value: WorkflowInput['answer']) {
  const check = lookup(TYPE_CHECKS, propertyKey(type));
  if (check == null) return false;
  if (!isTypeCheck(check)) throw new TypeError('Schema type check is not callable');
  return Boolean(check.call(TYPE_CHECKS, value));
}

export const validateJsonSchema = (schema: WorkflowInput['answer'], value: WorkflowInput['answer'], path: readonly unknown[] = []): string | null => {
  if (!isPlainObject(schema)) return null;
  const types = Array.isArray(schema.type) ? schema.type : (isString(schema.type) ? [schema.type] : []);
  if (types.length > 0 && !types.some((type) => matchesType(type, value))) {
    return `${pointer(path)} must be ${types.join(' or ')}`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) {
    return `${pointer(path)} must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(', ')}`;
  }
  if (isPlainObject(value)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.hasOwn(value, propertyKey(key))) return `${pointer([...path, key])} is required`;
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

export const findSchemaContradiction = (schema: WorkflowInput['answer'], path: readonly unknown[] = []): string | null => {
  if (!isPlainObject(schema)) return null;
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  if (schema.additionalProperties === false && Array.isArray(schema.required)) {
    const impossible = schema.required.find((key) => !Object.hasOwn(properties, propertyKey(key)));
    if (impossible) return `${pointer([...path, impossible])} is required but additionalProperties: false leaves it out of properties`;
  }
  for (const [key, propertySchema] of Object.entries(properties)) {
    const nested = findSchemaContradiction(propertySchema, [...path, key]);
    if (nested) return nested;
  }
  return isPlainObject(schema.items) ? findSchemaContradiction(schema.items, [...path, '[]']) : null;
};

export const parseJsonAnswer = (text: string) => {
  const candidates = [text.trim()];
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((match) => (match[1] ?? '').trim());
  candidates.push(...fenced.reverse());
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const value: JsonValue = JSON.parse(candidate);
      return { value };
    } catch {
      continue;
    }
  }
  return null;
};
