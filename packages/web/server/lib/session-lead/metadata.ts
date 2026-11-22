import { z } from 'zod';
import type { SessionMetadata } from '../openchamber-sessions/session-metadata-store.js';
import type { SessionMetadata as KnowledgeSessionMetadata } from '../session-knowledge/contracts.js';

export const DIGEST_LIMITS = Object.freeze({ needsYou: 3, now: 8, news: 5, suggestions: 3, itemLength: 300, options: 4, optionLength: 80 });

const questionSchema = z.object({
  question: z.string(),
  options: z.array(z.string()).catch([]),
  recommended: z.string().optional().catch(undefined),
});

const storedQuestionSchema = z.union([z.string().transform((question): LeadQuestion => ({ question, options: [] })), questionSchema]);

const digestSchema = z.object({
  needsYou: z.array(storedQuestionSchema).catch([]),
  now: z.array(z.string()).catch([]),
  news: z.array(z.string()).catch([]),
  suggestions: z.array(z.string()).catch([]),
  updatedAt: z.number().finite(),
});

const leadSchema = z.object({
  at: z.number().finite(),
  digest: digestSchema.optional().catch(undefined),
  dismissed: z.array(z.string()).catch([]).optional(),
});

const metadataSchema = z.object({ openchamber: z.object({ lead: leadSchema }) });

export type LeadQuestion = z.infer<typeof questionSchema>;
export type LeadDigest = z.infer<typeof digestSchema>;
export type Lead = z.infer<typeof leadSchema>;

export const readLead = (metadata: SessionMetadata | KnowledgeSessionMetadata | null | undefined): Lead | null => metadataSchema.safeParse(metadata).data?.openchamber.lead ?? null;

const LINE_SECTIONS = ['now', 'news', 'suggestions'] as const;
type LineSection = typeof LINE_SECTIONS[number];

const jsonListSchema = z.string().transform((text, context) => {
  try {
    return z.array(z.unknown()).parse(JSON.parse(text));
  } catch {
    context.addIssue({ code: 'custom', message: 'not a JSON list' });
    return z.NEVER;
  }
});

export const sectionInputSchema = z.union([z.array(z.unknown()), z.string(), z.null()]).optional();
type SectionInput = z.infer<typeof sectionInputSchema>;

const listOf = (value: SectionInput): unknown[] | null => {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  if (!value.trim().startsWith('[')) return value.split(/\r?\n/);
  return jsonListSchema.safeParse(value.trim()).data ?? null;
};

const cleanLine = (item: string) => item.replace(/^\s*[-*]\s+/, '').replace(/\s+/g, ' ').trim();

const tooLong = (item: string, limit: number) => (item.length > limit
  ? `Each item is one line of at most ${limit} characters; this one is ${item.length}: "${item.slice(0, 60)}…"`
  : null);

type Parsed<Value> = { value: Value } | { error: string };

const readLines = (value: SectionInput, name: LineSection): Parsed<string[]> => {
  const list = z.array(z.string()).safeParse(listOf(value));
  if (!list.success) return { error: `${name} must be a list of strings` };
  const items = list.data.map(cleanLine).filter(Boolean);
  if (items.length > DIGEST_LIMITS[name]) return { error: `${name} takes at most ${DIGEST_LIMITS[name]} items; keep only what matters most` };
  const long = items.map((item) => tooLong(item, DIGEST_LIMITS.itemLength)).find(Boolean);
  return long ? { error: long } : { value: items };
};

const questionInputSchema = z.union([
  z.string().transform((question) => ({ question, options: [], recommended: undefined })),
  z.object({ question: z.string(), options: z.array(z.string()).optional(), recommended: z.string().optional() }),
]);

const readQuestion = (input: z.infer<typeof questionInputSchema>): Parsed<LeadQuestion | null> => {
  const question = cleanLine(input.question);
  if (!question) return { value: null };
  const long = tooLong(question, DIGEST_LIMITS.itemLength);
  if (long) return { error: long };
  const options = [...new Set((input.options ?? []).map(cleanLine).filter(Boolean))];
  if (options.length > DIGEST_LIMITS.options) return { error: `A question takes at most ${DIGEST_LIMITS.options} options` };
  const longOption = options.find((option) => option.length > DIGEST_LIMITS.optionLength);
  if (longOption) return { error: `Each option is a short answer of at most ${DIGEST_LIMITS.optionLength} characters: "${longOption.slice(0, 40)}…"` };
  const recommended = input.recommended === undefined ? undefined : cleanLine(input.recommended);
  if (recommended && !options.includes(recommended)) return { error: `recommended must be one of the options, word for word: "${recommended.slice(0, 40)}"` };
  return { value: recommended ? { question, options, recommended } : { question, options } };
};

const readQuestions = (value: SectionInput): Parsed<LeadQuestion[]> => {
  const list = z.array(questionInputSchema).safeParse(listOf(value));
  if (!list.success) return { error: 'needsYou is a list of strings or { question, options, recommended }' };
  const questions: LeadQuestion[] = [];
  for (const input of list.data) {
    const question = readQuestion(input);
    if ('error' in question) return question;
    if (question.value) questions.push(question.value);
  }
  if (questions.length > DIGEST_LIMITS.needsYou) return { error: `needsYou takes at most ${DIGEST_LIMITS.needsYou} items; keep only what matters most` };
  return { value: questions };
};

const sameText = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();

export type DigestInput = Partial<Record<LineSection | 'needsYou', SectionInput>>;

export const withoutDismissed = (digest: LeadDigest, dismissed: readonly string[]) => {
  const refused = new Set(dismissed.map(sameText));
  return {
    digest: { ...digest, suggestions: digest.suggestions.filter((item) => !refused.has(sameText(item))) },
    dropped: digest.suggestions.filter((item) => refused.has(sameText(item))),
  };
};

export const parseDigestInput = (input: DigestInput, updatedAt: number): { digest: LeadDigest } | { error: string } => {
  const needsYou = readQuestions(input.needsYou);
  if ('error' in needsYou) return needsYou;
  const digest: LeadDigest = { needsYou: needsYou.value, now: [], news: [], suggestions: [], updatedAt };
  for (const name of LINE_SECTIONS) {
    const items = readLines(input[name], name);
    if ('error' in items) return items;
    digest[name] = items.value;
  }
  return { digest };
};

export const digestPatch = (digest: LeadDigest) => ({ openchamber: { lead: { digest } } });
