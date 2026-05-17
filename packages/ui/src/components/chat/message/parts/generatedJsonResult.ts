export type GeneratedCommitResult = {
  kind: 'commit';
  subject: string;
  highlights: string[];
  raw: string;
};

export type GeneratedPrResult = {
  kind: 'pr';
  title: string;
  body: string;
  raw: string;
};

export type GeneratedResult = GeneratedCommitResult | GeneratedPrResult;

const parseJsonObjects = (value: string): Record<string, unknown>[] => {
  const text = value.trim();
  const candidates = new Set<string>();

  const fencedMatches = text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi);
  for (const match of fencedMatches) {
    if (match[1]) candidates.add(match[1].trim());
  }

  const firstObjectStart = text.indexOf('{');
  if (firstObjectStart >= 0) {
    for (let end = text.length; end > firstObjectStart; end -= 1) {
      if (text[end - 1] === '}') {
        candidates.add(text.slice(firstObjectStart, end));
        break;
      }
    }
  }

  const parsed: Record<string, unknown>[] = [];
  for (const candidate of candidates) {
    try {
      const item = JSON.parse(candidate) as unknown;
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        parsed.push(item as Record<string, unknown>);
      }
    } catch {
      // Ignore non-JSON prose; the model may include markdown before the object.
    }
  }
  return parsed;
};

export const parseGeneratedJsonResult = (value: string): GeneratedResult | null => {
  for (const item of parseJsonObjects(value)) {
    const subject = typeof item.subject === 'string' ? item.subject.trim() : '';
    const highlights = Array.isArray(item.highlights)
      ? item.highlights.filter((entry) => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean).slice(0, 3)
      : [];
    if (subject) {
      return { kind: 'commit', subject, highlights, raw: JSON.stringify({ subject, highlights }, null, 2) };
    }

    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const body = typeof item.body === 'string' ? item.body.trim() : '';
    if (title || body) {
      return { kind: 'pr', title, body, raw: JSON.stringify({ title, body }, null, 2) };
    }
  }
  return null;
};
