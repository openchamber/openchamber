import vm from 'node:vm';

import { isPlainObject, isString } from '../shared/guards.js';

const WORKFLOW_SCRIPT_MAX_LENGTH = 100_000;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_PHASES = 20;
const MAX_PHASE_TITLE_LENGTH = 80;
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const META_DECLARATION = /^export\s+const\s+meta\s*=\s*/;

export class WorkflowScriptError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WorkflowScriptError';
  }
}

const skipBlank = (source, index) => {
  let position = index;
  while (position < source.length) {
    if (/\s/.test(source[position])) {
      position += 1;
    } else if (source.startsWith('//', position)) {
      const end = source.indexOf('\n', position);
      position = end === -1 ? source.length : end + 1;
    } else if (source.startsWith('/*', position)) {
      const end = source.indexOf('*/', position + 2);
      if (end === -1) throw new WorkflowScriptError('The script has an unclosed comment');
      position = end + 2;
    } else {
      break;
    }
  }
  return position;
};

/**
 * The end of the object literal that starts at `start`: braces are counted
 * outside strings, template literals and comments. The literal is evaluated
 * on its own afterwards, so this only has to find where it stops.
 */
const objectLiteralEnd = (source, start) => {
  let depth = 0;
  let position = start;
  while (position < source.length) {
    const char = source[position];
    if (char === '"' || char === "'" || char === '`') {
      position += 1;
      while (position < source.length && source[position] !== char) {
        position += source[position] === '\\' ? 2 : 1;
      }
    } else if (source.startsWith('//', position) || source.startsWith('/*', position)) {
      position = skipBlank(source, position) - 1;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return position + 1;
    }
    position += 1;
  }
  throw new WorkflowScriptError('The meta object is never closed');
};

const readMeta = (literal) => {
  let value;
  try {
    // A fresh context and a short timeout: meta is a plain literal, so
    // anything that needs more than that is not one. It crosses back as JSON,
    // so the object belongs to this realm and holds only literal values.
    value = JSON.parse(vm.runInNewContext(`JSON.stringify(${literal})`, {}, { timeout: 50 }) ?? 'null');
  } catch (error) {
    throw new WorkflowScriptError(`meta must be a plain object literal: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isPlainObject(value)) throw new WorkflowScriptError('meta must be a plain object literal');
  const name = isString(value.name) ? value.name.trim() : '';
  if (!NAME_PATTERN.test(name)) {
    throw new WorkflowScriptError('meta.name is required: lowercase letters, digits and dashes, at most 64 characters, such as audit-routes');
  }
  const description = isString(value.description) ? value.description.trim() : '';
  if (!description) throw new WorkflowScriptError('meta.description is required: one sentence on what the workflow does');
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new WorkflowScriptError(`meta.description is ${description.length} characters; the limit is ${MAX_DESCRIPTION_LENGTH}`);
  }
  const phases = value.phases === undefined ? [] : value.phases;
  if (!Array.isArray(phases) || phases.length > MAX_PHASES
    || !phases.every((phase) => isString(phase) && phase.trim() && phase.trim().length <= MAX_PHASE_TITLE_LENGTH)) {
    throw new WorkflowScriptError(`meta.phases, when given, is a list of at most ${MAX_PHASES} titles of at most ${MAX_PHASE_TITLE_LENGTH} characters`);
  }
  return { name, description, phases: phases.map((phase) => phase.trim()) };
};

/** The body as the sandbox runs it: an async function, so it can await and return. */
export const wrapWorkflowBody = (body) => `(async () => {\n${body}\n})()`;

/**
 * Splits a workflow script into its `meta` and the body the sandbox runs, and
 * checks that the body compiles. Throws WorkflowScriptError with a message
 * written for the agent that wrote the script.
 */
export const parseWorkflowScript = (source) => {
  if (!isString(source) || !source.trim()) {
    throw new WorkflowScriptError('script is required: export const meta = { name, description, phases } followed by the body');
  }
  if (source.length > WORKFLOW_SCRIPT_MAX_LENGTH) {
    throw new WorkflowScriptError(`script is ${source.length} characters; the limit is ${WORKFLOW_SCRIPT_MAX_LENGTH}`);
  }
  const start = skipBlank(source, 0);
  const declaration = META_DECLARATION.exec(source.slice(start));
  if (!declaration) throw new WorkflowScriptError('The script must start with export const meta = { name, description, phases }');
  const literalStart = start + declaration[0].length;
  if (source[literalStart] !== '{') throw new WorkflowScriptError('meta must be a plain object literal');
  const literalEnd = objectLiteralEnd(source, literalStart);
  const meta = readMeta(source.slice(literalStart, literalEnd));
  let bodyStart = skipBlank(source, literalEnd);
  if (source[bodyStart] === ';') bodyStart += 1;
  const body = source.slice(bodyStart);
  if (/^\s*import\s[\s\S]*?from\s/m.test(body)) {
    throw new WorkflowScriptError('A workflow cannot import modules; the body is plain JavaScript with agent(), parallel(), pipeline(), phase(), log() and args');
  }
  try {
    new vm.Script(wrapWorkflowBody(body), { filename: `${meta.name}.workflow.js` });
  } catch (error) {
    throw new WorkflowScriptError(`The script does not compile: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const title of findPhaseCalls(body)) {
    if (meta.phases.length > 0 && !meta.phases.includes(title)) {
      throw new WorkflowScriptError(`phase("${title}") is not listed in meta.phases; list every phase title exactly as phase() spells it`);
    }
  }
  return { meta, body };
};

/** Literal phase("...") titles in the body, for the plan the user approves. */
const findPhaseCalls = (body) => {
  const titles = [];
  for (const match of body.matchAll(/\bphase\(\s*(["'`])((?:(?!\1).)+)\1\s*\)/g)) {
    if (!titles.includes(match[2])) titles.push(match[2]);
  }
  return titles;
};

/** The phases the user is shown before a run: meta's list, else the literal phase() calls. */
export const plannedPhases = ({ meta, body }) => (meta.phases.length > 0 ? meta.phases : findPhaseCalls(body));
