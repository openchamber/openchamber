/**
 * The small text <-> object bridge for the project shell environment's extra
 * variables. The config stores an object; the Settings field edits one
 * `NAME=value` per line, which is what the command output looks like too.
 */

const SHELL_ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The result of reading the textarea: the parsed object and the lines it rejected. */
interface ParsedProjectShellEnvVars {
  vars: Record<string, string>;
  invalid: string[];
}

/**
 * Parse the textarea into the stored object. Blank lines and `#` comments are
 * skipped; a line without a valid `NAME=` prefix is reported (not silently
 * dropped), so the caller can show what needs fixing before saving.
 */
export const parseProjectShellEnvVars = (text: string): ParsedProjectShellEnvVars => {
  const vars: Record<string, string> = {};
  const invalid: string[] = [];
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const equalsIndex = line.indexOf('=');
    if (equalsIndex <= 0) {
      invalid.push(line);
      continue;
    }
    const key = line.slice(0, equalsIndex).trim();
    if (!SHELL_ENV_VAR_NAME_PATTERN.test(key)) {
      invalid.push(key || line);
      continue;
    }
    vars[key] = line.slice(equalsIndex + 1).trim();
  }
  return { vars, invalid };
};

/** Render the stored object back into `NAME=value` lines, in insertion order. */
export const serializeProjectShellEnvVars = (vars: Record<string, string> | null | undefined): string => (
  Object.entries(vars ?? {}).map(([key, value]) => `${key}=${value}`).join('\n')
);
