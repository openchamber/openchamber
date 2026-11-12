/**
 * Pure helpers for environment variables a user gives OpenChamber: the name
 * rule, reading the output of an environment command (devenv, direnv, a
 * script of `export` lines), and laying variables over a child process's
 * environment. No filesystem or process access here.
 */

const VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_VARIABLES = 200;
const MAX_VARIABLE_NAME_LENGTH = 256;
export const MAX_VARIABLE_VALUE_LENGTH = 32_000;
export const MAX_COMMAND_LENGTH = 4000;

// `__proto__` matches the pattern but would replace an object's prototype
// when assigned as a key, and no real tool reads it.
export const isVariableName = (name) => name.length <= MAX_VARIABLE_NAME_LENGTH
  && VARIABLE_NAME_PATTERN.test(name)
  && name !== '__proto__';

const hasOwn = (record, key) => Object.prototype.hasOwnProperty.call(record, key);

// `nix print-dev-env --json` (what `devenv print-dev-env --json` prints)
// reports the derivation's whole environment as `variables.NAME = { type,
// value }`. Only `exported` entries belong in a child environment; `var`,
// `array` and the rest are the builder's own shell state (IFS, PS4, hooks).
const readTypedVariables = (variables, out) => {
  for (const [name, entry] of Object.entries(variables)) {
    if (!isVariableName(name) || entry === null || Array.isArray(entry)) continue;
    if (entry?.type !== 'exported' || String(entry.value) !== entry.value) continue;
    out[name] = entry.value;
  }
};

// `direnv export json` and other flat objects: `{ NAME: "value" }`. direnv
// marks a variable to unset with null; there is nothing to unset in an
// overlay, so it is skipped.
const readFlatVariables = (record, out) => {
  for (const [name, value] of Object.entries(record)) {
    if (!isVariableName(name) || String(value) !== value) continue;
    out[name] = value;
  }
};

// The Nix build sandbox's identity rides along in that same environment:
// HOME is `/homeless-shelter` and the temp variables point at NIX_BUILD_TOP.
// devenv's shell hook repairs them when it enters a shell; a plain spawn has
// no hook, so they are dropped, but only those sandbox values.
const NIX_SANDBOX_HOME = '/homeless-shelter';
const SANDBOX_TEMP_VARIABLES = ['TMP', 'TMPDIR', 'TEMP', 'TEMPDIR'];
const dropNixSandboxVariables = (variables) => {
  const buildTop = variables.NIX_BUILD_TOP;
  delete variables.NIX_BUILD_TOP;
  if (variables.HOME === NIX_SANDBOX_HOME) delete variables.HOME;
  if (buildTop === undefined) return variables;
  for (const name of SANDBOX_TEMP_VARIABLES) {
    if (variables[name] === buildTop) delete variables[name];
  }
  return variables;
};

const unquote = (value) => {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
};

// `$NAME` and `${NAME}` resolve against earlier lines, then the base
// environment; an unknown reference stays literal so a value is never emptied
// by accident. Only `\$` is unescaped, so `C:\Tools` survives.
const expandReferences = (value, parsed, baseEnv) => value.replace(
  /\\\$|\$(\w+)|\$\{([^}]+)\}/g,
  (match, bare, braced) => {
    if (match === '\\$') return '$';
    const name = bare ?? braced;
    if (hasOwn(parsed, name)) return parsed[name];
    if (hasOwn(baseEnv, name)) return baseEnv[name];
    return match;
  },
);

const readAssignment = (line, out, baseEnv) => {
  const entry = line.trim().replace(/^export\s+/, '');
  if (!entry || entry.startsWith('#')) return;
  const equalsIndex = entry.indexOf('=');
  if (equalsIndex <= 0) return;
  const name = entry.slice(0, equalsIndex).trim();
  if (!isVariableName(name)) return;
  out[name] = expandReferences(unquote(entry.slice(equalsIndex + 1).trim()), out, baseEnv);
};

/**
 * The variables an environment command printed. Recognizes devenv/nix JSON,
 * flat JSON objects (direnv), `NAME=value` lines with or without `export`,
 * and NUL-separated `env -0` output. Answers null when the output holds no
 * variable in any of those shapes, so the caller can tell the user the
 * output was not understood instead of silently applying nothing.
 */
export const parseEnvironmentOutput = (stdout, baseEnv = {}) => {
  const text = stdout.trim();
  if (!text) return null;
  const out = {};

  if (text.startsWith('{')) {
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (parsed !== null && !Array.isArray(parsed) && Object(parsed) === parsed) {
      const typed = parsed.variables;
      if (typed !== null && !Array.isArray(typed) && Object(typed) === typed) {
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

const isPathListName = (name) => {
  const upper = name.toUpperCase();
  return upper === 'PATH' || upper === 'CDPATH' || upper.endsWith('_PATH');
};

// The base's own spelling of a list variable (`Path` on Windows), so the
// child never gets both `PATH` and `Path`.
const existingSpelling = (baseEnv, name) => {
  if (hasOwn(baseEnv, name)) return name;
  const upper = name.toUpperCase();
  return Object.keys(baseEnv).find((key) => key.toUpperCase() === upper) ?? name;
};

const mergeListValue = (front, back, delimiter) => {
  const seen = new Set();
  const segments = [];
  for (const segment of [...front.split(delimiter), ...back.split(delimiter)]) {
    if (!segment || seen.has(segment)) continue;
    seen.add(segment);
    segments.push(segment);
  }
  return segments.join(delimiter);
};

/**
 * `baseEnv` with `variables` laid over it, as a new object. A PATH-like
 * variable is put in front of the inherited list (duplicates dropped), so
 * a project's tools win and system tools stay reachable; everything else
 * replaces the inherited value.
 */
export const overlayEnvironment = (baseEnv, variables, delimiter = process.platform === 'win32' ? ';' : ':') => {
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
