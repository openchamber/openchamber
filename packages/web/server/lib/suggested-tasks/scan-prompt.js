// What a lens session is told, and how its answer becomes suggestions.
//
// The session answers in prose and ends with one fenced JSON block. The block
// is the contract: a session that ends without a readable block failed, which
// is different from a block with an empty list ("nothing worth suggesting").

import path from 'node:path';
import { z } from 'zod';
import { LEVELS, SEVERITIES, levelRank, severityRank } from './config.js';

const MAX_TITLE_LENGTH = 200;
const MAX_BODY_LENGTH = 8_000;
const MAX_FILES_PER_SUGGESTION = 20;
const MAX_CHANGED_FILES_LISTED = 300;
const MAX_KNOWN_LISTED = 150;

/** Whether `filePath` (relative, forward slashes) matches a glob with `**`, `*` and `?`. */
export const matchesGlob = (filePath, pattern) => {
  const normalized = pattern.replace(/^\.\//, '');
  let source = '';
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === '*') {
      if (normalized[index + 1] === '*') {
        index += 1;
        if (normalized[index + 1] === '/') {
          index += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  // A pattern without a slash names a file anywhere, the way .gitignore does.
  const anchored = normalized.includes('/') ? `^${source}$` : `^(?:.*/)?${source}$`;
  return new RegExp(anchored).test(filePath);
};

const matchesAny = (filePath, patterns) => patterns.some((pattern) => matchesGlob(filePath, pattern));

/** Whether a repository file is inside the configured scope. */
export const isInScope = (filePath, scope) => (
  (scope.include.length === 0 || matchesAny(filePath, scope.include)) && !matchesAny(filePath, scope.exclude)
);

const bulletList = (lines) => lines.map((line) => `- ${line}`).join('\n');

/**
 * The prompt a lens session receives.
 *
 * `known` is what the scan must not suggest again: open, snoozed and handled
 * suggestions, rejected ones with the user's reason, and the project's open
 * todos. `changedFiles` is null for a full scan.
 */
export const buildScanPrompt = ({ lens, scope, maxSuggestions, changedFiles, known }) => {
  const sections = [
    'You are running a scan for Suggested tasks in OpenChamber. Your job is to find work worth doing in this repository and report it. Only the JSON block at the end is used.',
    `## Lens: ${lens.name}\n\n${lens.prompt}`,
  ];

  const scopeLines = ['The repository is the current working directory. Report paths relative to it.'];
  if (scope.include.length > 0) scopeLines.push(`Only look at files matching: ${scope.include.join(', ')}`);
  if (scope.exclude.length > 0) scopeLines.push(`Ignore files matching: ${scope.exclude.join(', ')}`);
  if (changedFiles) {
    const listed = changedFiles.slice(0, MAX_CHANGED_FILES_LISTED);
    scopeLines.push(`This is an incremental scan. Only these files changed since the last scan; report problems in them or caused by them:\n${bulletList(listed)}`);
    if (changedFiles.length > listed.length) scopeLines.push(`${changedFiles.length - listed.length} more changed files are not listed.`);
  }
  sections.push(`## Scope\n\n${bulletList(scopeLines)}`);

  const sources = ['Repository files through read, glob, grep and skill.'];
  if (lens.web) sources.push('Web pages and search through webfetch and websearch.');
  for (const { server, tools } of lens.mcp ?? []) {
    for (const [tool, effect] of Object.entries(tools)) {
      if (effect !== 'deny') sources.push(`MCP ${server}: ${tool} (${effect}).`);
    }
  }
  sections.push(`## Data sources\n\n${bulletList(sources)}\n\nUse MCP tools only as permitted, including tools that write to external services. Unlisted tools are denied. Do not save memory.`);

  sections.push([
    '## Rules',
    '',
    bulletList([
      'You can read and search files. You cannot edit files or run commands; do not try.',
      `Report at most ${maxSuggestions} suggestions, the most valuable first. Fewer is fine.`,
      'Each suggestion is one task a developer could pick up: a clear title, why it matters, and what to change.',
      'Point to the files and lines involved. Do not report things you cannot point to.',
      'Do not suggest anything listed under "Already known", or a variation of it.',
    ]),
  ].join('\n'));

  const knownLines = [
    ...known.open.map((title) => `[open] ${title}`),
    ...known.handled.map((title) => `[being worked on] ${title}`),
    ...known.dismissed.map(({ title, reason }) => (reason ? `[rejected] ${title}. Reason: ${reason}` : `[rejected] ${title}`)),
    ...known.todos.map((text) => `[todo] ${text}`),
    ...known.issues.map((title) => `[open issue] ${title}`),
  ].slice(0, MAX_KNOWN_LISTED);
  if (knownLines.length > 0) {
    sections.push(`## Already known\n\nRejected items show what the user does not want; avoid suggestions like them.\n\n${bulletList(knownLines)}`);
  }

  sections.push([
    '## Answer',
    '',
    'End your answer with exactly one fenced JSON block in this form:',
    '',
    '```json',
    '{"suggestions":[{"title":"Short imperative title","explanation":"Why it matters and what to change. Markdown allowed.","files":[{"path":"src/example.ts","startLine":10,"endLine":24}],"confidence":"high","severity":"medium","evidence":[{"source":"Issue tracker","summary":"What the source confirms","url":"https://example.com/issue/1"}]}]}',
    '```',
    '',
    `\`confidence\` is one of ${LEVELS.join(', ')}: how sure you are the problem is real. \`severity\` is one of ${SEVERITIES.join(', ')}: how much it matters. Line numbers are optional.`,
    'When nothing is worth suggesting, answer with {"suggestions":[]}.',
    'Evidence is optional, with at most 10 entries containing source, summary and an optional http or https URL. Cite only sources you inspected.',
  ].join('\n'));

  return sections.join('\n\n');
};

const fileSchema = z.object({
  path: z.string().trim().min(1).max(1_000),
  startLine: z.number().int().min(1).optional().catch(undefined),
  endLine: z.number().int().min(1).optional().catch(undefined),
});

export const evidenceSchema = z.array(z.object({
  source: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(2_000),
  url: z.url({ protocol: /^https?$/ }).max(2_000).optional(),
})).max(10);

const reportedSuggestionSchema = z.object({
  title: z.string().trim().min(1),
  explanation: z.string().trim().default(''),
  files: z.array(z.unknown()).default([]),
  confidence: z.enum(LEVELS).catch('medium'),
  severity: z.enum(SEVERITIES).catch('medium'),
  evidence: evidenceSchema.optional(),
});

const reportSchema = z.object({ suggestions: z.array(z.unknown()) });

const FENCE_PATTERN = /```(?:json)?[^\n]*\n([\s\S]*?)```/g;

const parseJsonText = (text) => {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
};

/** The report in the answer: the last fenced block that parses, else the answer itself. */
const findReport = (text) => {
  const blocks = [...text.matchAll(FENCE_PATTERN)].map((match) => match[1]).reverse();
  for (const block of [...blocks, text]) {
    const json = parseJsonText(block.trim());
    if (!json.ok) continue;
    const report = reportSchema.safeParse(json.value);
    if (report.success) return report.data;
  }
  return null;
};

/**
 * A repository-relative path, or null for one outside the scanned checkout.
 * `root` is where the scan ran (the project or a temporary worktree), so
 * relative paths mean the same thing in the project.
 */
const repositoryPath = (reported, root) => {
  const unified = reported.replace(/\\/g, '/').replace(/^\.\//, '');
  const relative = path.isAbsolute(unified) ? path.relative(root, unified).replace(/\\/g, '/') : unified;
  const normalized = path.posix.normalize(relative);
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized === '..' || path.posix.isAbsolute(normalized)) return null;
  return normalized;
};

const toFile = (raw, root) => {
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) return null;
  const filePath = repositoryPath(parsed.data.path, root);
  if (!filePath) return null;
  const { startLine, endLine } = parsed.data;
  const file = { path: filePath };
  if (startLine) file.startLine = startLine;
  if (startLine && endLine && endLine >= startLine) file.endLine = endLine;
  return file;
};

export class ScanOutputError extends Error {}

/**
 * Suggestions from a lens session's final answer. Throws `ScanOutputError`
 * when there is no readable report; an entry that cannot be read is skipped
 * alone and counted in `invalid`.
 */
export const parseScanOutput = (text, root) => {
  const report = findReport(text);
  if (!report) throw new ScanOutputError('The scan ended without a readable list of suggestions.');
  const suggestions = [];
  let invalid = 0;
  for (const entry of report.suggestions) {
    const parsed = reportedSuggestionSchema.safeParse(entry);
    if (!parsed.success) {
      invalid += 1;
      continue;
    }
    const { title, explanation, files, confidence, severity, evidence } = parsed.data;
    const suggestion = {
      title: title.slice(0, MAX_TITLE_LENGTH),
      body: explanation.slice(0, MAX_BODY_LENGTH),
      files: files.map((file) => toFile(file, root)).filter(Boolean).slice(0, MAX_FILES_PER_SUGGESTION),
      confidence,
      severity,
    };
    if (evidence) suggestion.evidence = evidence;
    suggestions.push(suggestion);
  }
  return { suggestions, invalid };
};

const titleTokens = (title) => title
  .toLowerCase()
  .normalize('NFKD')
  .replace(/[^\p{L}\p{N}\s]/gu, ' ')
  .split(/\s+/)
  .filter((token) => token.length > 1);

/** Two titles name the same work: same words, or at least 75 percent of their words shared. */
export const isSimilarTitle = (left, right) => {
  const a = new Set(titleTokens(left));
  const b = new Set(titleTokens(right));
  if (a.size === 0 || b.size === 0) return false;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared) >= 0.75;
};

const duplicateStopWords = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'this', 'that', 'before', 'after', 'when', 'once', 'its', 'by', 'to', 'in', 'of', 'on', 'at', 'is', 'it', 'an', 'as', 'be']);

const repeatsFinding = (left, right) => {
  if (isSimilarTitle(left.title, right.title)) return true;
  const overlaps = left.files.some((a) => right.files.some((b) => (
    a.path === b.path && a.startLine && b.startLine
    && a.startLine <= (b.endLine ?? b.startLine)
    && b.startLine <= (a.endLine ?? a.startLine)
  )));
  if (!overlaps) return false;
  const a = new Set(titleTokens(left.title).filter((token) => !duplicateStopWords.has(token)));
  const b = new Set(titleTokens(right.title).filter((token) => !duplicateStopWords.has(token)));
  const shared = [...a].filter((token) => b.has(token)).length;
  // Shared locations alone also match independent problems in one function.
  if (shared >= 3 && shared / Math.min(a.size, b.size) >= 0.5) return true;
  if (shared === 0) return false;
  // Different lenses often name the same defect differently but describe the
  // same input, missing check and outcome. Require both a shared location and
  // substantial explanatory overlap before treating those as the same work.
  const detailsA = new Set(titleTokens(`${left.title} ${left.body}`).filter((token) => !duplicateStopWords.has(token)));
  const detailsB = new Set(titleTokens(`${right.title} ${right.body}`).filter((token) => !duplicateStopWords.has(token)));
  const sharedDetails = [...detailsA].filter((token) => detailsB.has(token)).length;
  return sharedDetails >= 8 && sharedDetails / Math.min(detailsA.size, detailsB.size) >= 0.35;
};

/**
 * Which reported suggestions a lens adds. Drops what is out of scope, below
 * the configured minimums, or already known, then keeps the most severe and
 * most certain ones up to `slots`. Each drop is counted, so the run can say
 * why a lens added less than it reported.
 */
export const selectSuggestions = ({ reported, scope, limits, knownTitles, knownSuggestions = [], slots }) => {
  const counts = { outOfScope: 0, belowMinimum: 0, duplicate: 0, overLimit: 0 };
  const accepted = [];
  for (const suggestion of reported) {
    const files = suggestion.files.filter((file) => isInScope(file.path, scope));
    if (suggestion.files.length > 0 && files.length === 0) {
      counts.outOfScope += 1;
      continue;
    }
    if (levelRank(suggestion.confidence) < levelRank(limits.minConfidence)
      || severityRank(suggestion.severity) < severityRank(limits.minSeverity)) {
      counts.belowMinimum += 1;
      continue;
    }
    if (knownTitles.some((title) => isSimilarTitle(title, suggestion.title))
      || [...knownSuggestions, ...accepted].some((entry) => repeatsFinding(entry, suggestion))) {
      counts.duplicate += 1;
      continue;
    }
    accepted.push({ ...suggestion, files });
  }
  accepted.sort((left, right) => (severityRank(right.severity) - severityRank(left.severity))
    || (levelRank(right.confidence) - levelRank(left.confidence)));
  const kept = accepted.slice(0, Math.max(0, slots));
  counts.overLimit = accepted.length - kept.length;
  return { suggestions: kept, counts };
};
