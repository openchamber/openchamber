import type { JsonObject, JsonValue } from '../shared/json-values.js';
import { isString } from './validation.js';

const text = (value: JsonValue | undefined): string => (isString(value) && value ? value : '');

export function gitPatchForDiff(file: JsonObject): string {
  const oldPath = text(file.old_path) || file.new_path;
  const newPath = text(file.new_path) || file.old_path;
  const lines = [`diff --git a/${oldPath} b/${newPath}`];
  if (file.new_file === true) lines.push(`new file mode ${text(file.b_mode) || '100644'}`);
  else if (file.deleted_file === true) lines.push(`deleted file mode ${text(file.a_mode) || '100644'}`);
  else if (text(file.a_mode) && text(file.b_mode) && file.a_mode !== file.b_mode) lines.push(`old mode ${file.a_mode}`, `new mode ${file.b_mode}`);
  if (file.renamed_file === true) lines.push(`rename from ${oldPath}`, `rename to ${newPath}`);
  const body = isString(file.diff) ? file.diff : '';
  if (body.startsWith('@@')) {
    lines.push(`--- ${file.new_file === true ? '/dev/null' : `a/${oldPath}`}`);
    lines.push(`+++ ${file.deleted_file === true ? '/dev/null' : `b/${newPath}`}`);
  }
  const header = `${lines.join('\n')}\n`;
  if (!body) return header;
  return `${header}${body.endsWith('\n') ? body : `${body}\n`}`;
}
