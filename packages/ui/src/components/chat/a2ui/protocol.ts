import { z } from 'zod';

/**
 * Lightweight native A2UI (Agent-to-User Interface) v0.9/v0.10 wire-format
 * parser, JSON-Pointer data model engine, and reactive expression evaluator.
 *
 * Kept dependency-free (Zod v4 + plain TypeScript) to match OpenChamber's
 * bundle budget and theme ownership without pulling in Lit or Zod v3.
 */

const jsonValue: z.ZodType<A2uiJson> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);

export type A2uiJson =
  | string
  | number
  | boolean
  | null
  | A2uiJson[]
  | { [key: string]: A2uiJson };

export type A2uiObject = { [key: string]: A2uiJson };

export const A2UI_COMPONENT_TYPES = [
  // Standard A2UI Basic Catalog layout & display
  'Column',
  'Row',
  'Card',
  'List',
  'Tabs',
  'Modal',
  'Divider',
  'Details',
  'Text',
  'Badge',
  'Callout',
  'KeyValue',
  'Table',
  'Stat',
  'Progress',
  'Steps',
  // Standard A2UI Basic Catalog interactive controls
  'ChoicePicker',
  'TextField',
  'CheckBox',
  'Slider',
  'DateTimeInput',
  'Button',
  // OpenChamber visualization & batch-decision extensions
  'LineChart',
  'BarChart',
  'QuestionBatch',
] as const;

export type A2uiComponentType = (typeof A2UI_COMPONENT_TYPES)[number];

const KNOWN_COMPONENT_TYPES = new Set<string>(A2UI_COMPONENT_TYPES);

const componentSchema = z
  .object({
    id: z.string().min(1),
    component: z.string().min(1),
  })
  .catchall(jsonValue);

export type A2uiComponent = z.infer<typeof componentSchema>;

const createSurfaceEnvelope = z.object({
  createSurface: z.object({
    surfaceId: z.string().min(1),
    catalogId: z.string().optional(),
    title: z.string().optional(),
    rootId: z.string().optional(),
  }),
});

const beginRenderingAlias = z.object({
  beginRendering: z.object({
    surfaceId: z.string().min(1),
    root: z.string().optional(),
    catalogId: z.string().optional(),
    title: z.string().optional(),
  }),
});

const updateComponentsEnvelope = z.object({
  updateComponents: z.object({
    surfaceId: z.string().min(1),
    components: z.array(z.unknown()),
  }),
});

const surfaceUpdateAlias = z.object({
  surfaceUpdate: z.object({
    surfaceId: z.string().min(1),
    components: z.array(z.unknown()),
  }),
});

const updateDataModelEnvelope = z.object({
  updateDataModel: z.object({
    surfaceId: z.string().min(1),
    path: z.string().optional(),
    value: jsonValue.optional(),
  }),
});

const dataModelUpdateAlias = z.object({
  dataModelUpdate: z.object({
    surfaceId: z.string().min(1),
    path: z.string().optional(),
    value: jsonValue.optional(),
  }),
});

const deleteSurfaceEnvelope = z.object({
  deleteSurface: z.object({
    surfaceId: z.string().min(1),
  }),
});

const a2uiMessageSchema = z.union([
  createSurfaceEnvelope,
  beginRenderingAlias,
  updateComponentsEnvelope,
  surfaceUpdateAlias,
  updateDataModelEnvelope,
  dataModelUpdateAlias,
  deleteSurfaceEnvelope,
]);

export type A2uiMessage = z.infer<typeof a2uiMessageSchema>;

export interface A2uiSurfaceState {
  surfaceId: string;
  catalogId?: string;
  title?: string;
  rootId: string;
  components: Map<string, A2uiComponent>;
  dataModel: A2uiJson;
}

export type A2uiParseResult =
  | { kind: 'empty' }
  | { kind: 'ready'; surface: A2uiSurfaceState }
  | { kind: 'invalid'; errors: string[] };

// --- JSON Pointer (RFC 6901) helpers ---

const decodeSegment = (segment: string): string =>
  segment.replaceAll('~1', '/').replaceAll('~0', '~');

const encodeSegment = (segment: string): string =>
  segment.replaceAll('~', '~0').replaceAll('/', '~1');

export function pointerSegments(pointer: string): string[] {
  const trimmed = pointer.trim();
  if (!trimmed || trimmed === '/') return [];
  const normalized = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
  if (!normalized) return [];
  return normalized.split('/').map(decodeSegment);
}

/**
 * Resolves a data-model path relative to an optional List item scope.
 * Leading "/" is always absolute from surface root; bare names resolve inside scope.
 */
export function resolvePointer(path: string, scope = ''): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed === '/') return scope || '/';
  if (trimmed.startsWith('/')) return trimmed;
  const base = scope && scope !== '/' ? scope.replace(/\/+$/, '') : '';
  return `${base}/${trimmed}`;
}

export function joinPointer(base: string, segment: string | number): string {
  const encoded = encodeSegment(String(segment));
  const cleanBase = base && base !== '/' ? base.replace(/\/+$/, '') : '';
  return `${cleanBase}/${encoded}`;
}

export function isPlainObject(value: unknown): value is A2uiObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function getByPointer(model: A2uiJson, pointer: string, scope = ''): A2uiJson | undefined {
  const resolved = resolvePointer(pointer, scope);
  const segments = pointerSegments(resolved);
  let current: A2uiJson | undefined = model;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
    } else if (isPlainObject(current)) {
      if (!Object.hasOwn(current, segment)) return undefined;
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

/**
 * Immutably sets a value at a JSON Pointer path, creating intermediate objects
 * or arrays as needed when a path writes into an uninitialized subtree.
 */
export function setByPointer(model: A2uiJson, pointer: string, value: A2uiJson, scope = ''): A2uiJson {
  const resolved = resolvePointer(pointer, scope);
  const segments = pointerSegments(resolved);
  if (segments.length === 0) return value;

  const updateAt = (current: A2uiJson | undefined, depth: number): A2uiJson => {
    const segment = segments[depth];
    const isLast = depth === segments.length - 1;
    const nextSegment = segments[depth + 1];
    const index = /^\d+$/.test(segment) ? Number(segment) : null;

    if (Array.isArray(current) && index !== null) {
      const copy = current.slice();
      copy[index] = isLast ? value : updateAt(copy[index], depth + 1);
      return copy;
    }

    if (current === undefined && index !== null) {
      const copy: A2uiJson[] = [];
      copy[index] = isLast ? value : updateAt(undefined, depth + 1);
      return copy;
    }

    const base: A2uiObject = isPlainObject(current) ? { ...current } : {};
    if (isLast) {
      base[segment] = value;
      return base;
    }
    const existingChild = Object.hasOwn(base, segment) ? base[segment] : undefined;
    const defaultContainer = existingChild !== undefined
      ? existingChild
      : (nextSegment !== undefined && /^\d+$/.test(nextSegment) ? [] : {});
    base[segment] = updateAt(defaultContainer, depth + 1);
    return base;
  };

  return updateAt(model, 0);
}

// --- Reactive DynamicValue & safe expression evaluation ---

const INTERPOLATION_RE = /\$\{([^}]+)\}/g;

const isPathBinding = (value: unknown): value is { path: string } =>
  isPlainObject(value) && typeof value.path === 'string' && Object.keys(value).length === 1;

const isCallBinding = (value: unknown): value is { call: string; args?: A2uiObject } =>
  isPlainObject(value) && typeof value.call === 'string';

const isAnsweredValue = (value: A2uiJson | undefined): boolean => {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
};

export function interpolateTemplate(template: string, model: A2uiJson, scope = ''): string {
  if (!template.includes('${')) return template;
  return template.replace(INTERPOLATION_RE, (_, expr: string) => {
    const resolved = getByPointer(model, expr.trim(), scope);
    if (resolved === undefined || resolved === null) return '';
    if (typeof resolved === 'string' || typeof resolved === 'number' || typeof resolved === 'boolean') {
      return String(resolved);
    }
    if (Array.isArray(resolved)) {
      return resolved.map((entry) => (typeof entry === 'string' || typeof entry === 'number' ? String(entry) : '')).filter(Boolean).join(', ');
    }
    return JSON.stringify(resolved);
  });
}

function evaluateCall(call: string, args: A2uiObject | undefined, model: A2uiJson, scope: string): A2uiJson {
  const resolveArg = (key: string): A2uiJson | undefined =>
    args && Object.hasOwn(args, key) ? resolveDynamicValue(args[key], model, scope) : undefined;

  switch (call) {
    case 'formatString': {
      const raw = resolveArg('value');
      return typeof raw === 'string' ? interpolateTemplate(raw, model, scope) : String(raw ?? '');
    }
    case 'equals':
      return JSON.stringify(resolveArg('left') ?? resolveArg('a')) === JSON.stringify(resolveArg('right') ?? resolveArg('b'));
    case 'notEquals':
      return JSON.stringify(resolveArg('left') ?? resolveArg('a')) !== JSON.stringify(resolveArg('right') ?? resolveArg('b'));
    case 'not':
      return !resolveArg('value');
    case 'and': {
      const items = args && Array.isArray(args.values) ? args.values : [];
      return items.every((item) => Boolean(resolveDynamicValue(item, model, scope)));
    }
    case 'or': {
      const items = args && Array.isArray(args.values) ? args.values : [];
      return items.some((item) => Boolean(resolveDynamicValue(item, model, scope)));
    }
    case 'isEmpty':
      return !isAnsweredValue(resolveArg('value'));
    case 'nonEmpty':
      return isAnsweredValue(resolveArg('value'));
    case 'count': {
      const value = resolveArg('value');
      if (Array.isArray(value)) return value.length;
      if (isPlainObject(value)) return Object.keys(value).length;
      return 0;
    }
    case 'countAnswered': {
      const value = resolveArg('value');
      if (Array.isArray(value)) return value.filter((item) => isAnsweredValue(item)).length;
      if (isPlainObject(value)) return Object.values(value).filter((item) => isAnsweredValue(item)).length;
      return 0;
    }
    case 'gt':
      return Number(resolveArg('left') ?? resolveArg('a')) > Number(resolveArg('right') ?? resolveArg('b'));
    case 'gte':
      return Number(resolveArg('left') ?? resolveArg('a')) >= Number(resolveArg('right') ?? resolveArg('b'));
    case 'lt':
      return Number(resolveArg('left') ?? resolveArg('a')) < Number(resolveArg('right') ?? resolveArg('b'));
    case 'lte':
      return Number(resolveArg('left') ?? resolveArg('a')) <= Number(resolveArg('right') ?? resolveArg('b'));
    default:
      return null;
  }
}

export function resolveDynamicValue(value: A2uiJson | undefined, model: A2uiJson, scope = ''): A2uiJson | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value === 'string') return interpolateTemplate(value, model, scope);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (isPathBinding(value)) return getByPointer(model, value.path, scope);
  if (isCallBinding(value)) return evaluateCall(value.call, value.args, model, scope);
  if (Array.isArray(value)) return value.map((item) => resolveDynamicValue(item, model, scope) ?? null);
  if (isPlainObject(value)) {
    const out: A2uiObject = {};
    for (const [key, entry] of Object.entries(value)) {
      const resolved = resolveDynamicValue(entry, model, scope);
      if (resolved !== undefined) out[key] = resolved;
    }
    return out;
  }
  return value;
}

export function resolveString(value: A2uiJson | undefined, model: A2uiJson, scope = ''): string {
  const resolved = resolveDynamicValue(value, model, scope);
  if (typeof resolved === 'string') return resolved;
  if (typeof resolved === 'number' || typeof resolved === 'boolean') return String(resolved);
  return '';
}

export function resolveBoolean(value: A2uiJson | undefined, model: A2uiJson, scope = '', fallback = false): boolean {
  if (value === undefined) return fallback;
  const resolved = resolveDynamicValue(value, model, scope);
  if (typeof resolved === 'boolean') return resolved;
  return Boolean(resolved);
}

export function extractBoundPath(value: A2uiJson | undefined): string | null {
  if (isPathBinding(value)) return value.path;
  if (typeof value === 'string' && value.startsWith('/')) return value;
  return null;
}

export function resolveActionContext(
  context: A2uiJson | undefined,
  model: A2uiJson,
  scope = '',
): A2uiObject {
  if (context === undefined) return isPlainObject(model) ? { ...model } : { value: model };
  const resolved = resolveDynamicValue(context, model, scope);
  if (isPlainObject(resolved)) return resolved;
  return { value: resolved ?? null };
}

// --- Safe deterministic JSON recovery for minor LLM delimiter slips ---

function stripTrailingCommas(input: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      let lookahead = i + 1;
      while (lookahead < input.length && /\s/.test(input[lookahead])) lookahead += 1;
      if (input[lookahead] === '}' || input[lookahead] === ']') continue;
    }
    out += ch;
  }
  return out;
}

function scanDelimiterBalance(input: string): { stack: string[]; inString: boolean; extraTrailing: number } {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let extraTrailing = 0;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      stack.push('}');
    } else if (ch === '[') {
      stack.push(']');
    } else if (ch === '}' || ch === ']') {
      if (stack.length > 0 && stack[stack.length - 1] === ch) {
        stack.pop();
      } else if (stack.length === 0) {
        extraTrailing += 1;
      }
    }
  }
  return { stack, inString, extraTrailing };
}

/**
 * Parses a single JSON value with deterministic recovery for common LLM trailing
 * delimiter slips (trailing commas, 1-4 missing closing braces/brackets at EOL,
 * or 1-2 extra closing braces/brackets). Never fabricates content or runs eval.
 */
export function parseJsonWithSafeRepair(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (initialError) {
    const cleaned = stripTrailingCommas(raw.trim());
    try {
      return { ok: true, value: JSON.parse(cleaned) };
    } catch {
      // Fall through to delimiter-balance repair.
    }

    const { stack, inString, extraTrailing } = scanDelimiterBalance(cleaned);
    if (!inString && stack.length > 0 && stack.length <= 4 && extraTrailing === 0) {
      const candidate = cleaned + stack.slice().reverse().join('');
      try {
        return { ok: true, value: JSON.parse(candidate) };
      } catch {
        // Fall through.
      }
    }

    if (!inString && stack.length === 0 && extraTrailing > 0 && extraTrailing <= 2) {
      let trimmed = cleaned;
      for (let count = 0; count < extraTrailing; count += 1) {
        if (trimmed.endsWith('}') || trimmed.endsWith(']')) trimmed = trimmed.slice(0, -1).trimEnd();
      }
      try {
        return { ok: true, value: JSON.parse(trimmed) };
      } catch {
        // Fall through.
      }
    }

    return {
      ok: false,
      error: initialError instanceof Error ? initialError.message : String(initialError),
    };
  }
}

const ENVELOPE_KEY_ORDER = [
  'createSurface',
  'beginRendering',
  'updateComponents',
  'surfaceUpdate',
  'updateDataModel',
  'dataModelUpdate',
  'deleteSurface',
] as const;

/**
 * Splits a merged multi-key envelope (e.g. `{ updateComponents, updateDataModel }`)
 * into individual A2UI envelopes in lifecycle order so models that combine keys
 * in one JSON object never silently drop data or components.
 */
function expandMergedEnvelope(raw: unknown): unknown[] | null {
  if (!isPlainObject(raw)) return null;
  const presentKeys = ENVELOPE_KEY_ORDER.filter((key) => Object.hasOwn(raw, key));
  if (presentKeys.length <= 1) return null;

  let fallbackSurfaceId: string | undefined;
  for (const key of presentKeys) {
    const payload = raw[key];
    if (isPlainObject(payload) && typeof payload.surfaceId === 'string' && payload.surfaceId.trim()) {
      fallbackSurfaceId = payload.surfaceId.trim();
      break;
    }
  }

  return presentKeys.map((key) => {
    const payload = raw[key];
    if (
      fallbackSurfaceId
      && isPlainObject(payload)
      && (typeof payload.surfaceId !== 'string' || !payload.surfaceId.trim())
    ) {
      return { [key]: { ...payload, surfaceId: fallbackSurfaceId } };
    }
    return { [key]: payload };
  });
}

function expandShorthandObject(raw: unknown): unknown[] | null {
  const merged = expandMergedEnvelope(raw);
  if (merged) return merged;
  if (!isPlainObject(raw)) return null;
  if (!Array.isArray(raw.components)) return null;
  const surfaceId = typeof raw.surfaceId === 'string' && raw.surfaceId.trim() ? raw.surfaceId.trim() : 's1';
  const envelopes: unknown[] = [
    {
      createSurface: {
        surfaceId,
        ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
        ...(typeof raw.rootId === 'string' ? { rootId: raw.rootId } : {}),
      },
    },
    { updateComponents: { surfaceId, components: raw.components } },
  ];
  const modelData = raw.dataModel ?? raw.data ?? raw.value;
  if (modelData !== undefined) {
    envelopes.push({ updateDataModel: { surfaceId, value: modelData } });
  }
  return envelopes;
}

// --- Parsing JSONL, multi-line JSON envelopes, shorthand object, or JSON array ---

function extractRawObjects(source: string, complete: boolean): { items: unknown[]; errors: string[] } {
  const trimmed = source.trim();
  if (!trimmed) return { items: [], errors: [] };

  // Support a single JSON array of A2UI envelopes (e.g., from structured tool calls).
  if (trimmed.startsWith('[')) {
    const parsed = parseJsonWithSafeRepair(trimmed);
    if (parsed.ok) {
      if (Array.isArray(parsed.value)) {
        const flattened: unknown[] = [];
        for (const entry of parsed.value) {
          const expanded = expandShorthandObject(entry);
          if (expanded) flattened.push(...expanded);
          else flattened.push(entry);
        }
        return { items: flattened, errors: [] };
      }
      return { items: [], errors: ['Expected a JSONL stream or JSON array of A2UI messages'] };
    }
    if (!complete) return { items: [], errors: [] };
    return { items: [], errors: [`Invalid JSON array: ${parsed.error}`] };
  }

  // Support a single shorthand JSON object ({ surfaceId?, components, data? }) or single pretty-printed envelope.
  if (trimmed.startsWith('{') && trimmed.includes('\n')) {
    const whole = parseJsonWithSafeRepair(trimmed);
    if (whole.ok && isPlainObject(whole.value)) {
      const expanded = expandShorthandObject(whole.value);
      if (expanded) return { items: expanded, errors: [] };
      if (a2uiMessageSchema.safeParse(whole.value).success) return { items: [whole.value], errors: [] };
    }
  }

  // Standard A2UI JSONL (one JSON object per line, with multi-line object buffering fallback).
  const lines = trimmed.split(/\r?\n/);
  const items: unknown[] = [];
  const errors: string[] = [];

  let buffer = '';
  let bufferStartLine = 0;

  const flushLine = (text: string, lineNumber: number, isLastLine: boolean) => {
    const parsed = parseJsonWithSafeRepair(text);
    if (parsed.ok) {
      const expanded = expandShorthandObject(parsed.value);
      if (expanded) items.push(...expanded);
      else items.push(parsed.value);
      return;
    }
    if (!complete && isLastLine) return;
    errors.push(`Line ${lineNumber}: invalid JSON (${parsed.error})`);
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith('//')) continue;

    if (!buffer) {
      const direct = parseJsonWithSafeRepair(line);
      if (direct.ok) {
        const expanded = expandShorthandObject(direct.value);
        if (expanded) items.push(...expanded);
        else items.push(direct.value);
        continue;
      }
      // If braces are unbalanced and more lines follow, buffer as a pretty-printed multi-line object.
      const balance = scanDelimiterBalance(line);
      if (index < lines.length - 1 && (balance.stack.length > 0 || balance.inString)) {
        buffer = line;
        bufferStartLine = index + 1;
        continue;
      }
      flushLine(line, index + 1, index === lines.length - 1);
    } else {
      buffer += '\n' + line;
      const balance = scanDelimiterBalance(buffer);
      if (!balance.inString && balance.stack.length === 0) {
        flushLine(buffer, bufferStartLine, index === lines.length - 1);
        buffer = '';
      }
    }
  }

  if (buffer) {
    flushLine(buffer, bufferStartLine, true);
  }

  return { items, errors };
}

export function parseA2uiMessages(source: string, complete: boolean): A2uiParseResult {
  const { items, errors } = extractRawObjects(source, complete);
  if (items.length === 0) {
    if (errors.length > 0 && complete) return { kind: 'invalid', errors };
    return { kind: 'empty' };
  }

  const surfaces = new Map<string, A2uiSurfaceState>();
  const order: string[] = [];
  const validationErrors: string[] = [...errors];

  const ensureSurface = (surfaceId: string): A2uiSurfaceState => {
    let surface = surfaces.get(surfaceId);
    if (!surface) {
      surface = {
        surfaceId,
        rootId: 'root',
        components: new Map(),
        dataModel: {},
      };
      surfaces.set(surfaceId, surface);
      order.push(surfaceId);
    }
    return surface;
  };

  items.forEach((raw, index) => {
    const parsed = a2uiMessageSchema.safeParse(raw);
    if (!parsed.success) {
      // Recover stray top-level component objects (e.g. a model closing updateComponents one item early).
      const strayComponent = componentSchema.safeParse(raw);
      const lastActiveId = order[order.length - 1];
      if (strayComponent.success && lastActiveId && KNOWN_COMPONENT_TYPES.has(strayComponent.data.component)) {
        const targetSurface = surfaces.get(lastActiveId);
        if (targetSurface) {
          targetSurface.components.set(strayComponent.data.id, strayComponent.data);
          return;
        }
      }
      validationErrors.push(`Message ${index + 1}: unrecognized A2UI envelope (expected createSurface, updateComponents, updateDataModel, or deleteSurface)`);
      return;
    }
    const message = parsed.data;

    if ('createSurface' in message) {
      const { surfaceId, catalogId, title, rootId } = message.createSurface;
      const surface = ensureSurface(surfaceId);
      if (catalogId) surface.catalogId = catalogId;
      if (title) surface.title = title;
      if (rootId) surface.rootId = rootId;
      return;
    }

    if ('beginRendering' in message) {
      const { surfaceId, root, catalogId, title } = message.beginRendering;
      const surface = ensureSurface(surfaceId);
      if (catalogId) surface.catalogId = catalogId;
      if (title) surface.title = title;
      if (root) surface.rootId = root;
      return;
    }

    if ('updateComponents' in message || 'surfaceUpdate' in message) {
      const update = 'updateComponents' in message ? message.updateComponents : message.surfaceUpdate;
      const surface = ensureSurface(update.surfaceId);
      for (const rawComponent of update.components) {
        // Ignore stray primitive tokens (e.g. an accidental child-id string) while validating component objects.
        if (!isPlainObject(rawComponent)) continue;
        const validated = componentSchema.safeParse(rawComponent);
        if (!validated.success) continue;
        const component = validated.data;
        if (!KNOWN_COMPONENT_TYPES.has(component.component)) {
          validationErrors.push(`Unknown component "${component.component}" on id "${component.id}"`);
          continue;
        }
        surface.components.set(component.id, component);
      }
      return;
    }

    if ('updateDataModel' in message || 'dataModelUpdate' in message) {
      const update = 'updateDataModel' in message ? message.updateDataModel : message.dataModelUpdate;
      const surface = ensureSurface(update.surfaceId);
      const nextValue = update.value === undefined ? {} : update.value;
      const targetPath = update.path?.trim() ?? '';
      if (!targetPath || targetPath === '/') {
        if (isPlainObject(surface.dataModel) && isPlainObject(nextValue)) {
          surface.dataModel = { ...surface.dataModel, ...nextValue };
        } else {
          surface.dataModel = nextValue;
        }
      } else {
        surface.dataModel = setByPointer(surface.dataModel, targetPath, nextValue);
      }
      return;
    }

    if ('deleteSurface' in message) {
      surfaces.delete(message.deleteSurface.surfaceId);
    }
  });

  const activeId = order.find((id) => surfaces.has(id));
  const surface = activeId ? surfaces.get(activeId) : undefined;

  if (!surface) {
    if (complete && validationErrors.length > 0) return { kind: 'invalid', errors: validationErrors };
    return { kind: 'empty' };
  }

  if (!surface.components.has(surface.rootId)) {
    if (!complete) return { kind: 'empty' };
    validationErrors.push(`Missing root component "${surface.rootId}" in updateComponents`);
  }

  if (complete && validationErrors.length > 0) {
    return { kind: 'invalid', errors: validationErrors };
  }

  if (!surface.components.has(surface.rootId)) return { kind: 'empty' };
  return { kind: 'ready', surface };
}

export function extractA2uiQuestionPreview(source: string): string {
  const parsed = parseA2uiMessages(source, true);
  if (parsed.kind !== 'ready') return source.trim().slice(0, 2000);
  const { surface } = parsed;
  const lines: string[] = [];
  if (surface.title) lines.push(surface.title);
  for (const component of surface.components.values()) {
    if (component.component === 'Text' && typeof component.text === 'string') {
      lines.push(interpolateTemplate(component.text, surface.dataModel));
    } else if (component.component === 'Card' && typeof component.title === 'string') {
      lines.push(interpolateTemplate(component.title, surface.dataModel));
    } else if (component.component === 'QuestionBatch') {
      const items = resolveDynamicValue(component.items, surface.dataModel);
      if (Array.isArray(items)) {
        lines.push(`${items.length} questions`);
        for (const item of items.slice(0, 12)) {
          if (isPlainObject(item) && typeof item.question === 'string') lines.push(`- ${item.question}`);
        }
      }
    }
  }
  return lines.join('\n').trim().slice(0, 2000);
}

const MAX_PAGE_SUMMARY_LENGTH = 500;

export function formatA2uiSummary(actionName: string, data: A2uiObject, note?: string): string {
  const parts: string[] = [];

  if (typeof data.summary === 'string' && data.summary.trim()) {
    parts.push(data.summary.trim());
  } else if (isPlainObject(data.answers)) {
    const entries = Object.entries(data.answers).filter(([, v]) => isAnsweredValue(v));
    const total = typeof data.totalCount === 'number' ? data.totalCount : entries.length;
    parts.push(`Answered ${entries.length} of ${total}`);
    const preview = entries
      .slice(0, 6)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
      .join('; ');
    if (preview) parts.push(preview);
  } else {
    parts.push(actionName);
    const scalars = Object.entries(data)
      .filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
      .slice(0, 6)
      .map(([k, v]) => `${k}: ${String(v)}`);
    if (scalars.length > 0) parts.push(scalars.join('; '));
  }

  if (note && note.trim()) parts.push(`Note: ${note.trim()}`);

  const combined = parts.join(' — ');
  return combined.length > MAX_PAGE_SUMMARY_LENGTH
    ? `${combined.slice(0, MAX_PAGE_SUMMARY_LENGTH - 1)}…`
    : combined;
}

export interface QuestionBatchOption {
  label: string;
  value: string;
  description?: string;
  detail?: string;
  badge?: string;
}

export interface QuestionBatchItem {
  id: string;
  question: string;
  category?: string;
  detail?: string;
  options: QuestionBatchOption[];
  recommended?: string;
  multiple?: boolean;
  allowNote?: boolean;
}

function normalizeOption(raw: A2uiJson): QuestionBatchOption | null {
  if (typeof raw === 'string') return { label: raw, value: raw };
  if (!isPlainObject(raw)) return null;
  const label = typeof raw.label === 'string' ? raw.label : typeof raw.value === 'string' ? raw.value : '';
  const value = typeof raw.value === 'string' ? raw.value : label;
  if (!label) return null;
  return {
    label,
    value,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    detail: typeof raw.detail === 'string' ? raw.detail : undefined,
    badge: typeof raw.badge === 'string' ? raw.badge : undefined,
  };
}

export function normalizeQuestionBatchItems(raw: A2uiJson | undefined): QuestionBatchItem[] {
  if (!Array.isArray(raw)) return [];
  const items: QuestionBatchItem[] = [];
  raw.forEach((entry, index) => {
    if (!isPlainObject(entry)) return;
    const question = typeof entry.question === 'string' ? entry.question : typeof entry.title === 'string' ? entry.title : '';
    const id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : `q${index + 1}`;
    const rawOptions = Array.isArray(entry.options) ? entry.options : [];
    const options = rawOptions.map(normalizeOption).filter((opt): opt is QuestionBatchOption => opt !== null);
    if (!question || options.length === 0) return;
    items.push({
      id,
      question,
      category: typeof entry.category === 'string' ? entry.category : undefined,
      detail: typeof entry.detail === 'string' ? entry.detail : undefined,
      options,
      recommended: typeof entry.recommended === 'string' ? entry.recommended : undefined,
      multiple: entry.multiple === true,
      allowNote: entry.allowNote !== false,
    });
  });
  return items;
}
