import type { JsonValue, SessionMessageAssistant } from '@opencode/client';
import { isRecord, isString } from '../shared/guards.js';
import type { BackgroundResult, ToolActivity } from './contracts.js';

const LABEL_CHAR_LIMIT = 60;
const COMMAND_STEP_LIMIT = 4;
const FILES_CHAR_LIMIT = 120;
const COMMANDS_CHAR_LIMIT = 180;
const TOOLS_CHAR_LIMIT = 100;
const RECORD_SHARES = [1, 0.75, 0.5, 0.25, 0];
const SEPARATOR = '; ';
export const STARTED = 'started in background';

type ToolPart = Extract<SessionMessageAssistant['content'][number], { type: 'tool' }>;
type Metadata = { [key: string]: JsonValue };
export type AssistContentPart = { type: string; text?: string; name?: string; state?: ToolPart['state'] };

const clip = (text: string) => (text.length <= LABEL_CHAR_LIMIT ? text : `${text.slice(0, LABEL_CHAR_LIMIT - 1)}…`);
const baseName = (file: string) => clip(file.split(/[\\/]/).findLast(Boolean) ?? '');

const PROGRAM = /^[\w./@+-]{1,60}$/;
const SUBCOMMAND = /^[a-z][a-z:-]{0,15}$/;
const SCRIPT_FILE = /^[\w./-]{1,60}\.(?:js|mjs|cjs|ts|mts|tsx|py|sh|rb|pl|sql)$/;
const FLAG = /^(?:-[A-Za-z]|--[a-z][a-z-]*)$/;
const SILENT = new Set(['cd', 'echo', 'printf', 'export', 'set', 'sleep', 'true', 'fi', 'done']);

const PLAIN_HEREDOC = /^([^#'"\\`$(<]*)<<[ \t]*(['"])(\w+)\2(?=[ \t\n;|&>])([^#'"\\`$(<\n]*)\n(?:[\s\S]*?\n)??\3(?:\n|$)/;
const QUOTED_OR_COMMENT = /\\[\s\S]|\$'(?:\\[\s\S]|[^'\\])*'|'[^']*'|"(?:\\[\s\S]|[^"\\])*"|(?<=^|[\s;|&(])#[^\n]*/g;

function commandWords(step: string) {
  const [program, next, script] = step.replace(/\d?>.*$/s, '').trim().replace(/^(?:\w+=\S*\s+(?:§\s+)?)+/, '').split(/\s+/, 3);
  if (!program || program.startsWith('-') || !PROGRAM.test(program) || SILENT.has(program)) return [];
  const words = [baseName(program)];
  if (!next) return words;
  if (SCRIPT_FILE.test(next)) return [...words, baseName(next)];
  if (!SUBCOMMAND.test(next) && !FLAG.test(next)) return words;
  words.push(next);
  if (next === 'run' && script && SUBCOMMAND.test(script)) words.push(script);
  return words;
}

function commandStep(step: string) {
  const target = step.match(/(?:^|[^\d&])>>?\s*([\w./-]{1,60})/)?.[1];
  const written = target && target !== '/dev/null' ? `> ${baseName(target)}` : '';
  return [...commandWords(step), written].filter(Boolean).join(' ');
}

function describeCommand(command: string) {
  const withoutBody = command.replace(PLAIN_HEREDOC, '$1$4\n');
  const [direct = ''] = withoutBody.split(/[$<>](?:\\\n)*\(|`/, 1);
  const readable = direct
    .replace(QUOTED_OR_COMMENT, (match) => (match.startsWith('#') || match === '\\\n' ? '' : ' § '))
    .replace(/\d?>&\d|&>/g, '');
  const bare = readable.replace(/(?:<<|['"\\])[\s\S]*$/, '');
  const parsed = bare.trim().split(/&&|\|\||[;|&\n]/).map((step) => commandStep(step.trim()));
  const steps = [...new Set(parsed.filter(Boolean))];
  const kept = steps.slice(0, COMMAND_STEP_LIMIT).join(', ');
  const label = clip(kept || 'shell command') + (steps.length > COMMAND_STEP_LIMIT ? ', …' : '');
  const chain = bare.trim();
  const lastShown = Boolean(kept) && label === kept && steps.at(-1) === parsed.at(-1);
  let coverage: ToolActivity['coverage'] = parsed.length > 1 ? 'every' : 'one';
  if (/[;|\n]/.test(chain)) coverage = lastShown ? 'last' : 'none';
  if (/(?<!&)&(?!&)|\|\|/.test(chain)) coverage = 'none';
  else if (direct !== withoutBody || bare !== readable) coverage = 'part';
  return { label, coverage };
}

function commandOutcome(status: string, metadata: Metadata) {
  if (metadata.interrupted === true || metadata.state === 'cancelled' || metadata.killed === true || metadata.timeout === true || isString(metadata.signal)) return 'stopped';
  if (metadata.status === 'running') return STARTED;
  if (Number.isInteger(metadata.exit)) return metadata.exit === 0 ? 'ok' : `failed, exit ${metadata.exit}`;
  if (status === 'error') return 'failed';
  if (status === 'completed') return 'finished';
  return 'unfinished';
}

function jobId(metadata: Metadata) {
  return { shell: metadata.shellID, subagent: metadata.childID, codemode: metadata.jobID, generate_image: metadata.jobID, generate_video: metadata.jobID }[String(metadata.source)];
}

export function readBackgroundResult(metadata: Metadata): BackgroundResult | null {
  const id = jobId(metadata);
  if (!isString(id)) return null;
  return { jobID: id, outcome: commandOutcome(metadata.state === 'completed' ? 'completed' : 'error', metadata) };
}

function changedFiles(name: string, status: string, input: Metadata, metadata: Metadata) {
  const diffs = Array.isArray(metadata.files) ? metadata.files : [];
  const files = [];
  for (const diff of diffs) {
    if (!isRecord(diff) || !isString(diff.file)) continue;
    files.push(baseName(diff.file) + (diff.status === 'deleted' ? ' (deleted)' : ''));
  }
  if (!files.length && status === 'completed' && name === 'write' && isString(input.path)) files.push(baseName(input.path));
  return files;
}

function readCalls(metadata: Metadata) {
  const calls = [];
  for (const call of Array.isArray(metadata.toolCalls) ? metadata.toolCalls : []) {
    if (isRecord(call) && isString(call.tool)) calls.push({ tool: call.tool, status: call.status });
  }
  return calls;
}

export function readActivity(content: readonly AssistContentPart[]): ToolActivity[] {
  const activity: ToolActivity[] = [];
  const tool = (name: string, failed: boolean) => activity.push({ kind: 'tool', label: clip(name), outcome: failed ? 'failed' : 'ok' });
  for (const part of content) {
    if (part?.type !== 'tool' || !isString(part.name) || !part.state) continue;
    const { name, state } = part;
    const input: Metadata = state.status === 'streaming' || !isRecord(state.input) ? {} : state.input;
    const metadata: Metadata = state.status === 'streaming' ? {} : state.metadata ?? {};
    if (name === 'shell' && isString(input.command)) {
      activity.push({
        kind: 'command', ...describeCommand(input.command), outcome: commandOutcome(state.status, metadata),
        jobID: isString(metadata.shellID) ? metadata.shellID : undefined,
      });
      continue;
    }
    if (name === 'subagent' && isString(input.description)) {
      activity.push({
        kind: 'command', label: clip(`subagent "${input.description}"`), outcome: commandOutcome(state.status, metadata),
        jobID: isString(metadata.sessionID) ? metadata.sessionID : undefined,
      });
      continue;
    }
    if (isString(metadata.jobID)) {
      activity.push({ kind: 'command', label: clip(`${name} job`), outcome: STARTED, jobID: metadata.jobID });
      continue;
    }
    const failed = state.status === 'error' || metadata.error === true;
    const files = changedFiles(name, state.status, input, metadata);
    for (const file of files) activity.push({ kind: 'file', label: file, outcome: 'ok' });
    const calls = readCalls(metadata);
    for (const call of calls) tool(call.status === 'running' ? `${call.tool} (unfinished)` : call.tool, call.status === 'error');
    const unfinished = state.status !== 'completed' && !failed;
    if (failed || unfinished || (!files.length && !calls.length)) tool(unfinished ? `${name} (unfinished)` : name, failed);
  }
  return activity;
}

const EXIT_ZERO = { one: 'ok', every: 'ok', last: 'last step ok', none: 'result unknown', part: 'whole script exit 0, not all steps shown' };

function shownOutcome({ outcome, coverage = 'one' }: ToolActivity) {
  if (outcome === 'ok') return EXIT_ZERO[coverage];
  return coverage !== 'one' && outcome.startsWith('failed') ? `a step ${outcome}` : outcome;
}

function fit(items: string[], limit: number) {
  const kept = [];
  let length = 0;
  for (const item of items) {
    length += item.length + SEPARATOR.length;
    if ((kept.length || limit < 0) && length > limit) break;
    kept.push(item);
  }
  const hidden = items.length - kept.length;
  return [...kept, ...(hidden ? [`+${hidden} more`] : [])].join(SEPARATOR);
}

export function renderActivity(activity: readonly ToolActivity[], charBudget = Infinity) {
  if (!activity.length) return 'none';
  const files = new Set<string>();
  const commands = new Set<string>();
  const tools = new Map<string, { count: number; failed: number }>();
  for (const entry of activity.toReversed()) {
    const { kind, label, outcome } = entry;
    if (kind === 'file') files.add(label);
    else if (kind === 'command') {
      commands.add(`${label} (${shownOutcome(entry)})`);
    } else {
      const seen = tools.get(label) ?? { count: 0, failed: 0 };
      tools.set(label, { count: seen.count + 1, failed: seen.failed + (outcome === 'failed' ? 1 : 0) });
    }
  }
  const toolEntries = [...tools].sort(([, a], [, b]) => Number(b.failed > 0) - Number(a.failed > 0));
  const toolLabels = toolEntries.map(([label, { count, failed }]) => `${label} x${count}${failed ? ` (${failed} failed)` : ''}`);
  const render = (share: number) => [
    files.size ? `Files changed: ${fit([...files], FILES_CHAR_LIMIT * share)}` : '',
    commands.size ? `Ran, newest first: ${fit([...commands], COMMANDS_CHAR_LIMIT * share)}` : '',
    tools.size ? `Tools: ${fit(toolLabels, TOOLS_CHAR_LIMIT * share)}` : '',
  ].filter(Boolean).join('\n');
  return RECORD_SHARES.map(render).find((record) => record.length <= charBudget) ?? render(-1);
}
