import {
  createLibrary,
  createParser,
  evaluateRoot,
  parseExpression,
  split,
  tokenize,
  walkAST,
} from '@openuidev/lang-core';
import { z } from 'zod/v4';
import { supportedOpenUIAction } from './actions.js';

/** Component references describe rendered child slots, not arbitrary object data. */
export function deriveOpenUIComponentSlots(schema) {
  const fragment = z.object({
    $ref: z.string().optional(),
    anyOf: z.array(z.json()).optional(),
    oneOf: z.array(z.json()).optional(),
    items: z.json().optional(),
  });
  const refs = (value) => {
    if (value.$ref) return /^#\/\$defs\/([^/]+)$/.exec(value.$ref)?.slice(1) ?? [];
    return [...value.anyOf ?? [], ...value.oneOf ?? [], value.items].flatMap((child) => {
      const parsed = fragment.safeParse(child);
      return parsed.success ? refs(parsed.data) : [];
    });
  };
  return Object.entries(schema.$defs ?? {}).flatMap(([component, definition]) => Object.entries(definition.properties ?? {}).flatMap(([prop, property]) => {
    if ((component === 'Stack' && prop === 'children') || (component === 'Col' && prop === 'data')) return [{ component, prop, allowed: null }];
    const parsed = fragment.safeParse(property);
    const allowed = parsed.success ? [...new Set(refs(parsed.data))].filter((name) => Object.hasOwn(schema.properties ?? {}, name)) : [];
    return allowed.length ? [{ component, prop, allowed }] : [];
  }));
}

/** Follow only actual child slots. Objects stored as data never become rendered nodes. */
export function walkRenderedOpenUINodes(root, slots) {
  const nodes = [];
  const visit = (value) => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!isElementNode(value)) return;
    nodes.push(value);
    for (const slot of slots) if (slot.component === value.typeName) visit(value.props[slot.prop]);
  };
  visit(root);
  return nodes;
}

function hasSupportedActions(value, slots) {
  if (Array.isArray(value)) return value.map((child) => hasSupportedActions(child, slots)).find(Boolean) ?? null;
  if (!isElementNode(value)) return null;
  if ((value.typeName === 'Button' || value.typeName === 'IconButton')
    && value.props.action != null && !supportedOpenUIAction.safeParse(value.props.action).success) {
    return { message: 'This OpenUI action plan is not supported.' };
  }
  for (const slot of slots) {
    if (slot.component !== value.typeName) continue;
    const error = hasSupportedActions(value.props[slot.prop], slots);
    if (error) return error;
  }
  return null;
}

function hasUnsafeActionExpression(source) {
  let unsafe = false;
  for (const statement of split(tokenize(source))) {
    walkAST(parseExpression(statement.tokens), (node) => {
      if (node.k !== 'Comp') return;
      if (node.name === 'Run') unsafe = true;
      if (node.name !== 'Action') return;
      const steps = node.args[0];
      if (steps?.k !== 'Arr') { unsafe = true; return; }
      const names = steps.els.map((step) => step.k === 'Comp' ? step.name : '');
      if (names.some((name) => !['Set', 'Reset', 'ToAssistant', 'OpenUrl'].includes(name))
        || (names.length > 1 && names.some((name) => name === 'ToAssistant' || name === 'OpenUrl'))) unsafe = true;
    });
  }
  return unsafe;
}
const elementHeader = z.object({ type: z.literal('element'), typeName: z.string(), props: z.object({}) });
function isElementNode(value) {
  return elementHeader.safeParse(value).success;
}

// The public core evaluator owns all 14 built-ins independently of components.
const evaluationLibrary = createLibrary({ components: [] });

/** Parses one complete program and rejects incomplete, external, or unsupported programs. */
export function inspectOpenUIProgram(source, schema, componentSlots = deriveOpenUIComponentSlots(schema)) {
  try {
    return inspect(source, schema, componentSlots);
  } catch {
    return { valid: false, diagnostics: [{ message: 'The OpenUI program could not be evaluated.' }] };
  }
}

function inspect(source, schema, componentSlots) {
  const result = createParser(schema, 'Stack').parse(source);
  // Keep official LLM-facing diagnostics, including component, statement and signature.
  const diagnostics = [...result.meta.errors];
  if (result.meta.incomplete) diagnostics.push({ message: 'The OpenUI program is incomplete.' });
  if (result.meta.unresolved.length) diagnostics.push({ message: `Unresolved references: ${result.meta.unresolved.join(', ')}` });
  if (result.queryStatements.length || result.mutationStatements.length) diagnostics.push({ message: 'Queries and mutations are unavailable.' });
  if (diagnostics.length) return { valid: false, diagnostics };
  if (hasUnsafeActionExpression(source)) {
    return { valid: false, diagnostics: [{ message: 'This OpenUI action plan is not supported.' }] };
  }

  const root = result.root;
  if ((!root && !result.rootExpression) || root?.partial) {
    return { valid: false, diagnostics: [{ message: 'The OpenUI program has no complete Stack root.' }] };
  }
  const errors = [];
  const evaluated = evaluateRoot(result, {
    library: evaluationLibrary,
    store: null,
    errors,
    ctx: {
      getState: (name) => result.stateDeclarations[name],
      resolveRef: () => undefined,
    },
  });
  if (errors.length) return { valid: false, diagnostics: errors };
  if (!evaluated || evaluated.typeName !== 'Stack') return { valid: false, diagnostics: [{ message: 'The OpenUI program must have a Stack root.' }] };
  const error = hasSupportedActions(evaluated, componentSlots);
  return error
    ? { valid: false, diagnostics: [error] }
    : { valid: true, root: evaluated };
}
