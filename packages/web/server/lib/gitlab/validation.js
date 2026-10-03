export const isString = (value) => Object.prototype.toString.call(value) === '[object String]';

export const isPlainObject = (value) => value === Object(value)
  && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
