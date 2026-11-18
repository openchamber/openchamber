import { isPlainObject, isString } from '../shared/guards.js';

export const isGitString = (value: unknown): value is string => isString(value);

export const isGitObject = (value: unknown): value is object => isPlainObject(value);

export const isGitArray = (value: unknown): value is unknown[] => Array.isArray(value);
