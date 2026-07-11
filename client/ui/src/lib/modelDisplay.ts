export type DisplayModel = Record<string, unknown> & {
  id?: unknown;
  name?: unknown;
};

export type DisplayProvider = {
  models?: DisplayModel[] | Record<string, DisplayModel | undefined>;
} | null | undefined;

type ModelDisplayOptions = {
  fallbackLabel?: string;
  maxLength?: number;
};

const normalizeString = (value: unknown): string => {
  return typeof value === 'string' ? value.trim() : '';
};

const truncate = (value: string, maxLength?: number): string => {
  if (!maxLength || maxLength <= 0 || value.length <= maxLength) {
    return value;
  }

  if (maxLength <= 3) {
    return value.slice(0, maxLength);
  }

  return `${value.slice(0, maxLength - 3)}...`;
};

const TOKEN_LABELS: Record<string, string> = {
  ai: 'AI',
  api: 'API',
  ernie: 'ERNIE',
  glm: 'GLM',
  gpt: 'GPT',
  it: 'IT',
  lfm: 'LFM',
  lm: 'LM',
  oss: 'OSS',
  pdf: 'PDF',
  rp: 'RP',
  slerp: 'SLERP',
  tars: 'TARS',
  ui: 'UI',
  vl: 'VL',
  vlm: 'VLM',
  aion: 'Aion',
  anthropic: 'Anthropic',
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  codex: 'Codex',
  codestral: 'Codestral',
  command: 'Command',
  deepseek: 'DeepSeek',
  gemini: 'Gemini',
  gemma: 'Gemma',
  grok: 'Grok',
  hunyuan: 'Hunyuan',
  kimi: 'Kimi',
  llama: 'Llama',
  minimax: 'MiniMax',
  mistral: 'Mistral',
  mixtral: 'Mixtral',
  nemotron: 'Nemotron',
  openai: 'OpenAI',
  qwen: 'Qwen',
  rekaai: 'RekaAI',
};

const titleCaseToken = (token: string): string => {
  if (!token) {
    return '';
  }
  return token[0].toUpperCase() + token.slice(1).toLowerCase();
};

const stripProviderPrefix = (value: string): string => {
  const withoutAliasMarker = value.startsWith('~') ? value.slice(1) : value;
  const slashIndex = withoutAliasMarker.lastIndexOf('/');
  return slashIndex >= 0 ? withoutAliasMarker.slice(slashIndex + 1) : withoutAliasMarker;
};

const splitColonSuffix = (value: string): { base: string; suffix: string } => {
  const colonIndex = value.lastIndexOf(':');
  if (colonIndex <= 0 || colonIndex >= value.length - 1) {
    return { base: value, suffix: '' };
  }

  return {
    base: value.slice(0, colonIndex),
    suffix: value.slice(colonIndex + 1),
  };
};

const tokenizeModelId = (value: string): string[] => {
  const rawTokens = value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .split(/[-_\s]+/)
    .map((token) => token.trim())
    .filter(Boolean);

  const tokens: string[] = [];
  for (let index = 0; index < rawTokens.length; index += 1) {
    const current = rawTokens[index];
    const next = rawTokens[index + 1];
    const nextNext = rawTokens[index + 2];

    if (/^(19|20)\d{2}$/.test(current) && /^\d{2}$/.test(next ?? '') && /^\d{2}$/.test(nextNext ?? '')) {
      tokens.push(`${current}-${next}-${nextNext}`);
      index += 2;
      continue;
    }

    if (/^\d$/.test(current) && /^\d$/.test(next ?? '')) {
      tokens.push(`${current}.${next}`);
      index += 1;
      continue;
    }

    tokens.push(current);
  }

  return tokens;
};

const formatModelToken = (token: string): string => {
  const lower = token.toLowerCase();
  const mapped = TOKEN_LABELS[lower];
  if (mapped) {
    return mapped;
  }

  const qwenMatch = lower.match(/^qwen(\d(?:\.\d+)?)$/);
  if (qwenMatch) {
    return `Qwen${qwenMatch[1]}`;
  }

  if (/^o\d/.test(lower)) {
    return lower;
  }

  if (/^v\d/.test(lower)) {
    return `V${token.slice(1).toUpperCase()}`;
  }

  if (/^\d+[on]$/.test(lower)) {
    return lower;
  }

  if (/^[a-z]\d+[a-z]?$/.test(lower)) {
    return lower.toUpperCase();
  }

  if (/^\d+(?:x\d+)?[a-z]+$/.test(lower)) {
    return lower.replace(/[a-z]+$/i, (unit) => unit.toUpperCase());
  }

  if (/^\d+(?:\.\d+)?[a-z]$/.test(lower)) {
    return lower.replace(/[a-z]$/i, (unit) => unit.toUpperCase());
  }

  if (/^[a-z]+\d+(?:\.\d+)?[a-z]*$/.test(lower)) {
    return titleCaseToken(lower).replace(/([a-z])(\d)/i, '$1$2');
  }

  return titleCaseToken(token);
};

const combineModelTokens = (tokens: string[]): string[] => {
  const result = [...tokens];

  if (result[0] === 'GPT' && result[1] && /^(?:\d|\d+[a-z]|OSS$)/i.test(result[1])) {
    result.splice(0, 2, `GPT-${result[1]}`);
  }

  if (result[0] === 'GLM' && result[1] && /^\d/.test(result[1])) {
    result.splice(0, 2, `GLM-${result[1]}`);
  }

  if (result[0] === 'LFM' && result[1] && /^\d/.test(result[1])) {
    result.splice(0, 2, `LFM${result[1]}`);
  }

  if (result[0] === 'Qwen' && result[1] && /^\d/.test(result[1])) {
    result.splice(0, 2, `Qwen${result[1]}`);
  }

  return result;
};

const formatSuffix = (suffix: string): string => {
  const normalized = normalizeString(suffix).toLowerCase();
  if (!normalized) {
    return '';
  }

  if (normalized === 'free' || normalized === 'thinking') {
    return normalized;
  }

  return humanizeModelId(normalized);
};

export const humanizeModelId = (modelId: string | null | undefined): string => {
  const normalized = normalizeString(modelId);
  if (!normalized) {
    return '';
  }

  const { base, suffix } = splitColonSuffix(stripProviderPrefix(normalized));
  const formattedTokens = combineModelTokens(tokenizeModelId(base).map(formatModelToken));

  if (formattedTokens.length >= 2) {
    const last = formattedTokens[formattedTokens.length - 1];
    const previous = formattedTokens[formattedTokens.length - 2];
    if (last === 'Reasoning' && previous === 'Non') {
      formattedTokens.splice(formattedTokens.length - 2, 2, '(Non-Reasoning)');
    }
  }

  const lastToken = formattedTokens[formattedTokens.length - 1];
  if (/^(19|20)\d{2}-\d{2}-\d{2}$/.test(lastToken ?? '')) {
    formattedTokens[formattedTokens.length - 1] = `(${lastToken})`;
  }

  const displayName = formattedTokens.join(' ').replace(/\s+\(/g, ' (').trim();
  const displaySuffix = formatSuffix(suffix);
  return displaySuffix ? `${displayName} (${displaySuffix})` : displayName;
};

export const getModelDisplayName = (
  model: DisplayModel | null | undefined,
  fallbackModelId?: string | null,
  options: ModelDisplayOptions = {},
): string => {
  const name = normalizeString(model?.name);
  if (name) {
    return truncate(name, options.maxLength);
  }

  const modelId = normalizeString(model?.id) || normalizeString(fallbackModelId);
  if (modelId) {
    return truncate(humanizeModelId(modelId), options.maxLength);
  }

  return options.fallbackLabel ?? '';
};

const getProviderModel = (provider: DisplayProvider, modelId: string): DisplayModel | undefined => {
  const models = provider?.models;
  if (!models || !modelId) {
    return undefined;
  }

  if (Array.isArray(models)) {
    return models.find((model) => normalizeString(model.id) === modelId);
  }

  return models[modelId];
};

export const getProviderModelDisplayName = (
  provider: DisplayProvider,
  modelId: string | null | undefined,
  options: ModelDisplayOptions = {},
): string => {
  const normalizedModelId = normalizeString(modelId);
  const model = getProviderModel(provider, normalizedModelId);
  return getModelDisplayName(model, normalizedModelId, options);
};
