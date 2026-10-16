import type { Edit, JSONPath } from 'jsonc-parser';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type ArrayItemEdit =
  | { type: 'insert-item'; path: JSONPath; value: JsonValue }
  | { type: 'remove-item'; path: JSONPath };

export function diffArrayItems(
  current: JsonValue[],
  next: JsonValue[],
  basePath: JSONPath,
  isEqual: (left: JsonValue, right: JsonValue) => boolean,
): ArrayItemEdit[] | null;

export function removeNodeEdits(
  text: string,
  start: number,
  end: number,
  neighbours: { nextStart: number; previousEnd: number },
): Edit[];

export function arrayItemTextEdits(text: string, edit: ArrayItemEdit, eol: string): Edit[] | null;
