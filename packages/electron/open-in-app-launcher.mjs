const TARGET_FIELD_CODES = new Set(['f', 'F', 'u', 'U']);
const DROPPED_FIELD_CODES = new Set(['i', 'c', 'k', 'd', 'D', 'n', 'N', 'v', 'm']);

const tokenizeLinuxDesktopExec = (execValue) => {
  const tokens = [];
  let current = '';
  let quote = '';
  let escaped = false;

  for (const char of String(execValue || '').trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = '';
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (escaped) {
    current += '\\';
  }
  if (current) {
    tokens.push(current);
  }

  return tokens;
};

const stripEnvPrefix = (tokens) => {
  if (tokens[0] !== 'env') return tokens;
  let index = 1;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] || '')) {
    index += 1;
  }
  return tokens.slice(index);
};

export const parseLinuxDesktopExecArgv = (execValue) => stripEnvPrefix(tokenizeLinuxDesktopExec(execValue));

export const parseLinuxDesktopExecProgram = (execValue) => parseLinuxDesktopExecArgv(execValue)[0] || '';

const resolveLinuxDesktopExecToken = (token, targetPath) => {
  let value = '';
  let usesTarget = false;

  for (let index = 0; index < token.length; index += 1) {
    const char = token[index];
    if (char !== '%') {
      value += char;
      continue;
    }

    const code = token[index + 1];
    if (!code) {
      continue;
    }
    index += 1;

    if (code === '%') {
      value += '%';
      continue;
    }
    if (TARGET_FIELD_CODES.has(code)) {
      value += targetPath;
      usesTarget = true;
      continue;
    }
    if (DROPPED_FIELD_CODES.has(code)) {
      return null;
    }
  }

  return value ? { value, usesTarget } : null;
};

export const buildLinuxDesktopExecSpec = (execValue, targetPath) => {
  const [program, ...rawArgs] = parseLinuxDesktopExecArgv(execValue);
  if (!program) return null;

  const args = [];
  let hasTargetPlaceholder = false;

  for (const rawArg of rawArgs) {
    const resolved = resolveLinuxDesktopExecToken(rawArg, targetPath);
    if (!resolved) continue;
    args.push(resolved.value);
    hasTargetPlaceholder ||= resolved.usesTarget;
  }

  if (targetPath && !hasTargetPlaceholder) {
    args.push(targetPath);
  }

  return { program, args };
};
