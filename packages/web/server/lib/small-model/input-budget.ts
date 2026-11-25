import type { JsonValue, ModelInfo } from '@opencode/client';

const DEFAULT_CONTEXT_TOKENS = 64_000;
const OUTPUT_RESERVE_TOKENS = 4_000;
const ANSWER_CONTEXT_SHARE = 0.25;
const CHARS_PER_TOKEN = 4;

export const getModelInputCharBudget = ({ modelInfo, outputReserveTokens }: {
  modelInfo: ModelInfo | null;
  outputReserveTokens?: number | undefined;
}) => {
  const context = Number(modelInfo?.limit?.context);
  const known = context > 0;
  const contextTokens = known ? context : DEFAULT_CONTEXT_TOKENS;
  const reserve = Number(outputReserveTokens) > 0 ? Number(outputReserveTokens) : OUTPUT_RESERVE_TOKENS;
  const inputBudgetTokens = Math.max(1_000, contextTokens - reserve);
  return { maxChars: inputBudgetTokens * CHARS_PER_TOKEN, contextTokens, contextKnown: known };
};

export const getModelInputTokenCap = (modelInfo: ModelInfo | null): number | null => {
  const context = Number(modelInfo?.limit?.context);
  const input = Number(modelInfo?.limit?.input);
  const output = Number(modelInfo?.limit?.output);
  const caps: number[] = [];
  if (context > 0) {
    const answer = Math.min(OUTPUT_RESERVE_TOKENS, context * ANSWER_CONTEXT_SHARE, output > 0 ? output : Infinity);
    caps.push(Math.floor(context - answer));
  }
  if (input > 0) caps.push(input);
  return caps.length > 0 ? Math.min(...caps) : null;
};

const LETTERS_PER_TOKEN = 7.6;
const DIGITS_PER_TOKEN = 3;
const SYMBOLS_PER_TOKEN = 2.1;
const REPEATS_PER_TOKEN = 16;
const ALPHABET_CHARS_PER_TOKEN = 4;
const IDEOGRAPHS_PER_TOKEN = 1.8;
const FIRST_IDEOGRAPH = 0x2e80;

const isUpper = (code: number) => code >= 65 && code <= 90;
const isLower = (code: number) => code >= 97 && code <= 122;
const isDigit = (code: number) => code >= 48 && code <= 57;
const isSpace = (code: number) => code <= 32;

const runEnd = (text: string, from: number, matches: (code: number) => boolean) => {
  let index = from;
  while (index < text.length && matches(text.charCodeAt(index))) index += 1;
  return index;
};

const SLACK_TOKENS = 2_000;
const SLACK_SHARE = 0.15;

const scan = (text: string, limit: number) => {
  let tokens = 0;
  let index = 0;
  while (index < text.length) {
    const start = index;
    const before = tokens;
    const code = text.charCodeAt(index);
    if (isUpper(code) || isLower(code)) {
      index = runEnd(text, runEnd(text, index, isUpper), isLower);
      tokens += Math.max(1, (index - start) / LETTERS_PER_TOKEN);
    } else if (isDigit(code)) {
      index = runEnd(text, index, isDigit);
      tokens += Math.ceil((index - start) / DIGITS_PER_TOKEN);
    } else if (isSpace(code)) {
      index = runEnd(text, index, isSpace);
      if (index - start > 1 || code !== 32) tokens += 1;
    } else if (code < 128) {
      index = runEnd(text, index, (next) => next === code);
      tokens += Math.max(1 / SYMBOLS_PER_TOKEN, (index - start) / REPEATS_PER_TOKEN);
    } else {
      index += 1;
      tokens += 1 / (code < FIRST_IDEOGRAPH ? ALPHABET_CHARS_PER_TOKEN : IDEOGRAPHS_PER_TOKEN);
    }
    if (tokens > limit) {
      return { tokens, end: start + Math.floor((index - start) * (limit - before) / (tokens - before)) };
    }
  }
  return { tokens, end: index };
};

export const estimateTokens = (text: string) => Math.ceil(scan(text, Infinity).tokens);

export const fittingChars = ({ text, around, charBudget, tokenCap }: {
  text: string;
  around: string;
  charBudget: number;
  tokenCap: number | null;
}) => {
  const chars = Math.min(text.length, charBudget);
  if (tokenCap === null || text.length + around.length <= tokenCap) return chars;
  const slack = Math.min(SLACK_TOKENS, tokenCap * SLACK_SHARE);
  const tokens = tokenCap + slack - estimateTokens(around);
  return tokens > 0 ? Math.min(chars, scan(text, tokens).end) : 0;
};

export const buildSchemaInstruction = (responseSchema: JsonValue) =>
  `Reply with JSON matching this schema and nothing else: ${JSON.stringify(responseSchema)}`;

interface ProviderFailure {
  message?: unknown;
  reason?: unknown;
  status?: unknown;
}

export const isProviderFailure = (value: unknown): value is ProviderFailure => value !== null && typeof value === 'object';
const isText = (value: unknown): value is string => typeof value === 'string';

const OVERFLOW_MESSAGES = [
  /prompt is too long/i,
  /input is too long for (?:the )?(?:requested|selected) model/i,
  /too large for the model'?s configured input limit/i,
  /exceed(?:s|ed) (?:the|this model) context window/i,
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i,
  /input token count.*exceeds the maximum/i,
  /number of input tokens exceeds maximum length/i,
  /tokens in request more than max tokens allowed/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /requested input length \d+ exceeds maximum input length/i,
  /maximum context length is [\d,]+ tokens/i,
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i,
  /input(?: \(\d+ tokens\))? is longer than the model'?s context length/i,
  /(?:prompt|token count).*exceeds the limit of \d+/i,
  /exceeds the available context size/i,
  /greater than the context length/i,
  /`inputs` tokens \+ `max_new_tokens` must be <= \d+/i,
  /context window exceed(?:s limit|ed)/i,
  /exceeded model token limit/i,
  /context[_ ]length[_ ]exceeded/i,
  /context length is only \d+ tokens/i,
  /input length.*exceeds.*context length/i,
  /prompt (?:too long|exceeds max length|超长)/i,
  /too large for model with \d+ maximum context length/i,
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i,
  /model_context_window_exceeded/i,
  /range of input length should be/i,
  /too many tokens/i,
  /token limit exceeded/i,
  /request exceeds the maximum size/i,
  /(?:request|payload)(?: entity|_)?[ _]too[ _]large/i,
];
const NOT_OVERFLOW_MESSAGES = [/rate limit/i, /too many requests/i, /max[_ ]tokens must be less than/i, /too many tokens.*please wait/i];

export const isInputOverflow = (failure: ProviderFailure) => {
  if (failure.reason === 'rate_limit') return false;
  if (Number(failure.status) === 413) return true;
  const message = isText(failure.message) ? failure.message : '';
  return OVERFLOW_MESSAGES.some((pattern) => pattern.test(message))
    && !NOT_OVERFLOW_MESSAGES.some((pattern) => pattern.test(message));
};
