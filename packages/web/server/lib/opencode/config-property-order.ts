// Writes a config map's properties in a chosen order. A fork module: upstream
// treats every config object as unordered.
import { applyEdits, findNodeAtLocation, parseTree } from 'jsonc-parser';
import type { JsonObject, JsonValue } from '../shared/json-values.js';

const isJsonObject = (value: JsonValue | undefined): value is JsonObject => (
  value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)
);

// Some config maps have a visible order, such as model pools. Move only their
// property nodes after the value edits so comments inside values and all trivia
// between properties survive. Ordinary config objects stay order-insensitive.
export function reorderConfigProperties(text: string, desired: JsonValue, orderedPaths: string[][]) {
  let reordered = text;
  for (const propertyPath of orderedPaths) {
    const root = parseTree(reordered, [], { allowTrailingComma: true });
    const object = root ? findNodeAtLocation(root, propertyPath) : undefined;
    if (object?.type !== 'object' || !object.children) continue;
    let next: JsonValue | undefined = desired;
    for (const key of propertyPath) next = isJsonObject(next) ? next[key] : undefined;
    if (!isJsonObject(next)) continue;
    const keys = Object.keys(next);
    const properties = object.children;
    const currentKeys = properties.map((property) => property.children?.[0]?.value);
    if (keys.length !== properties.length || keys.every((key, index) => key === currentKeys[index])) continue;
    const bodies = new Map(properties.map((property) => [
      property.children?.[0]?.value,
      reordered.slice(property.offset, property.offset + property.length),
    ]));
    const edits = properties.map((property, index) => ({
      offset: property.offset,
      length: property.length,
      content: bodies.get(keys[index]),
    }));
    const complete = edits.flatMap((edit) => (edit.content === undefined ? [] : [{ ...edit, content: edit.content }]));
    if (complete.length !== edits.length) throw new Error('Could not preserve ordered config properties');
    reordered = applyEdits(reordered, complete);
  }
  return reordered;
}
