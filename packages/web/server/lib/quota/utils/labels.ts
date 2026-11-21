import { isString } from '../../shared/object-guards.js';

export const lowerCaseLabel = <Value>(value: Value, expression: string) => {
  if (!isString(value)) throw new TypeError(`${expression}.toLowerCase is not a function`);
  return value.toLowerCase();
};
