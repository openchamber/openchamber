import type { JsonValue } from '../../server/lib/shared/json-values.js';

export const shellQuote = (value: JsonValue | undefined, platform = process.platform) => {
  const text = String(value);
  if (/^[A-Za-z0-9._\-/:=]+$/.test(text)) return text;
  return `'${text.replaceAll("'", platform === 'win32' ? "''" : "'\"'\"'")}'`;
};
