export function isString(value) {
  return Object.prototype.toString.call(value) === '[object String]';
}

export function isPlainObject(value) {
  if (value == null || Array.isArray(value)) {
    return false;
  }
  return Object.getPrototypeOf(value) === Object.prototype;
}

export function readTrimmedString(value) {
  return isString(value) && value.trim() ? value.trim() : '';
}

export function readFiniteNumber(value) {
  return Number.isFinite(value) ? value : null;
}

export function readEnv(name) {
  const raw = process.env[name];
  return raw ? raw.trim() : '';
}
