export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export const parseJson = (text: string): JsonValue => JSON.parse(text);

export const isJsonObject = (value: JsonValue): value is JsonObject => value instanceof Object && !Array.isArray(value);
