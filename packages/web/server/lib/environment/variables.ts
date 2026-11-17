const VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export type EnvironmentVariables = Record<string, string>;
export type ProcessEnvironment = Record<string, string | undefined>;
type EnvironmentOutputJson = null | boolean | number | string | EnvironmentOutputJson[] | EnvironmentOutputRecord;
type EnvironmentOutputRecord = { [name: string]: EnvironmentOutputJson };
export const MAX_VARIABLES = 200;
const MAX_VARIABLE_NAME_LENGTH = 256;
export const MAX_VARIABLE_VALUE_LENGTH = 32_000;
export const MAX_COMMAND_LENGTH = 4000;

export const isVariableName = (name: string) => name.length <= MAX_VARIABLE_NAME_LENGTH
  && VARIABLE_NAME_PATTERN.test(name)
  && name !== '__proto__';

const hasOwn = (record: ProcessEnvironment, key: string) => Object.prototype.hasOwnProperty.call(record, key);

const isRecord = (value: EnvironmentOutputJson | undefined): value is EnvironmentOutputRecord => value !== null
  && !Array.isArray(value) && Object(value) === value;

const isString = (value: unknown): value is string => String(value) === value;

const readTypedVariables = (variables: EnvironmentOutputRecord, out: EnvironmentVariables) => {
  for (const [name, entry] of Object.entries(variables)) {
    if (!isVariableName(name) || !isRecord(entry)) continue;
    if (entry.type !== 'exported' || !isString(entry.value)) continue;
    out[name] = entry.value;
  }
};

const readFlatVariables = (record: EnvironmentOutputRecord, out: EnvironmentVariables) => {
  for (const [name, value] of Object.entries(record)) {
    if (!isVariableName(name) || !isString(value)) continue;
    out[name] = value;
  }
};

const NIX_SANDBOX_HOME = '/homeless-shelter';
const SANDBOX_TEMP_VARIABLES = ['TMP', 'TMPDIR', 'TEMP', 'TEMPDIR'];
const dropNixSandboxVariables = (variables: EnvironmentVariables) => {
  const buildTop = variables.NIX_BUILD_TOP;
  delete variables.NIX_BUILD_TOP;
  if (variables.HOME === NIX_SANDBOX_HOME) delete variables.HOME;
  if (buildTop === undefined) return variables;
  for (const name of SANDBOX_TEMP_VARIABLES) {
    if (variables[name] === buildTop) delete variables[name];
  }
  return variables;
};

const unquote = (value: string) => {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
};

const expandReferences = (value: string, parsed: EnvironmentVariables, baseEnv: ProcessEnvironment) => value.replace(
  /\\\$|\$(\w+)|\$\{([^}]+)\}/g,
  (match: string, bare: string | undefined, braced: string | undefined) => {
    if (match === '\\$') return '$';
    const name = bare ?? braced ?? '';
    if (hasOwn(parsed, name)) return String(parsed[name]);
    if (hasOwn(baseEnv, name)) return String(baseEnv[name]);
    return match;
  },
);

const readAssignment = (line: string, out: EnvironmentVariables, baseEnv: ProcessEnvironment) => {
  const entry = line.trim().replace(/^export\s+/, '');
  if (!entry || entry.startsWith('#')) return;
  const equalsIndex = entry.indexOf('=');
  if (equalsIndex <= 0) return;
  const name = entry.slice(0, equalsIndex).trim();
  if (!isVariableName(name)) return;
  out[name] = expandReferences(unquote(entry.slice(equalsIndex + 1).trim()), out, baseEnv);
};

export const parseEnvironmentOutput = (stdout: string, baseEnv: ProcessEnvironment = {}) => {
  const text = stdout.trim();
  if (!text) return null;
  const out: EnvironmentVariables = {};

  if (text.startsWith('{')) {
    let parsed: EnvironmentOutputJson;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (isRecord(parsed)) {
      const typed = parsed.variables;
      if (isRecord(typed)) {
        readTypedVariables(typed, out);
      } else {
        readFlatVariables(parsed, out);
      }
      return Object.keys(out).length > 0 ? dropNixSandboxVariables(out) : null;
    }
  }

  const lines = text.includes('\0') ? text.split('\0') : text.split(/\r?\n/);
  for (const line of lines) readAssignment(line, out, baseEnv);
  return Object.keys(out).length > 0 ? dropNixSandboxVariables(out) : null;
};

const isPathListName = (name: string) => {
  const upper = name.toUpperCase();
  return upper === 'PATH' || upper === 'CDPATH' || upper.endsWith('_PATH');
};

const existingSpelling = (baseEnv: ProcessEnvironment, name: string) => {
  if (hasOwn(baseEnv, name)) return name;
  const upper = name.toUpperCase();
  return Object.keys(baseEnv).find((key) => key.toUpperCase() === upper) ?? name;
};

const mergeListValue = (front: string, back: string, delimiter: string) => {
  const seen = new Set();
  const segments: string[] = [];
  for (const segment of [...front.split(delimiter), ...back.split(delimiter)]) {
    if (!segment || seen.has(segment)) continue;
    seen.add(segment);
    segments.push(segment);
  }
  return segments.join(delimiter);
};

export const overlayEnvironment = (baseEnv: ProcessEnvironment, variables: EnvironmentVariables, delimiter = process.platform === 'win32' ? ';' : ':') => {
  const next = { ...baseEnv };
  for (const [name, value] of Object.entries(variables)) {
    if (!isPathListName(name)) {
      next[name] = value;
      continue;
    }
    const key = existingSpelling(next, name);
    const inherited = next[key];
    next[key] = inherited ? mergeListValue(value, inherited, delimiter) : value;
  }
  return next;
};
