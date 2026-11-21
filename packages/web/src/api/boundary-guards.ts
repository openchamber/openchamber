export type BoundaryScalar = string | number | boolean | null | undefined;
export const isStringValue = (value: BoundaryScalar): value is string => Object.prototype.toString.call(value) === '[object String]';
export const isBooleanValue = (value: BoundaryScalar): value is boolean => Object.prototype.toString.call(value) === '[object Boolean]';
export const isNumberValue = (value: BoundaryScalar): value is number => Object.prototype.toString.call(value) === '[object Number]';
export const isNonEmptyString = (value: BoundaryScalar): value is string => isStringValue(value) && value.trim().length > 0;
export const isPositiveSafeInteger = (value: BoundaryScalar): value is number => isNumberValue(value) && Number.isSafeInteger(value) && value >= 1;
