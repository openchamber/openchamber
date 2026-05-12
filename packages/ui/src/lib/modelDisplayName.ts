const ACRONYM_TOKENS = new Map<string, string>([
  ['gpt', 'GPT'],
  ['oss', 'OSS'],
  ['llm', 'LLM'],
  ['ai', 'AI'],
]);

const titleToken = (token: string): string => {
  const acronym = ACRONYM_TOKENS.get(token.toLowerCase());
  if (acronym) return acronym;
  if (/^o\d+/i.test(token)) return token.toUpperCase();
  return token.charAt(0).toUpperCase() + token.slice(1);
};

export const formatModelDisplayName = (modelId: string | null | undefined): string | undefined => {
  const trimmed = typeof modelId === 'string' ? modelId.trim() : '';
  if (!trimmed) return undefined;

  const localId = trimmed.includes('/') ? trimmed.slice(trimmed.lastIndexOf('/') + 1) : trimmed;
  const gptMatch = localId.match(/^gpt[-_\s]+(\d+)(?:[-_\s]+(\d+))?(.*)$/i);
  if (gptMatch) {
    const major = gptMatch[1];
    const minor = gptMatch[2];
    const suffix = gptMatch[3]?.trim().replace(/^[-_\s]+/, '') ?? '';
    const version = minor ? `${major}.${minor}` : major;
    const suffixLabel = suffix ? ` ${suffix.split(/[-_\s]+/).filter(Boolean).map(titleToken).join(' ')}` : '';
    return `GPT-${version}${suffixLabel}`;
  }

  const rawTokens = localId.split(/[-_\s]+/).filter(Boolean);
  if (rawTokens.length === 0) return localId;

  const tokens: string[] = [];
  for (let index = 0; index < rawTokens.length; index += 1) {
    const current = rawTokens[index];
    const next = rawTokens[index + 1];
    if (/^\d+$/.test(current) && next && /^\d+$/.test(next)) {
      tokens.push(`${current}.${next}`);
      index += 1;
      continue;
    }
    tokens.push(current);
  }

  return tokens.map(titleToken).join(' ');
};
