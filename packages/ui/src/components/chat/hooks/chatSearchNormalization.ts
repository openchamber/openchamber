/**
 * Normalizes raw markdown to the text exposed by the rendered inline DOM.
 * Fenced code is replaced before structural markdown is inspected so code
 * punctuation and identifiers never become search syntax.
 */
export function stripMarkdownForSearch(text: string): string {
  const withoutFencedCode = text.replace(/```[\s\S]*?```/gm, ' ');
  const lines = withoutFencedCode.split('\n');
  const separatorIndexes = new Set<number>();
  const tableRowIndexes = new Set<number>();
  const isTableSeparator = (line: string): boolean => (
    /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(line)
  );
  const hasPipe = (line: string): boolean => line.includes('|');

  for (let index = 0; index < lines.length; index += 1) {
    if (!isTableSeparator(lines[index] ?? '')) {
      continue;
    }

    separatorIndexes.add(index);
    if (index > 0 && hasPipe(lines[index - 1] ?? '')) {
      tableRowIndexes.add(index - 1);
    }
    for (let next = index + 1; next < lines.length && hasPipe(lines[next] ?? ''); next += 1) {
      tableRowIndexes.add(next);
    }
  }

  const structuralText = lines
    .map((line, sourceIndex) => ({ line, sourceIndex }))
    .filter(({ sourceIndex }) => !separatorIndexes.has(sourceIndex))
    .map(({ line, sourceIndex }) => {
      const isTableRow = tableRowIndexes.has(sourceIndex);
      let normalized = line;
      if (isTableRow) {
        normalized = normalized.trim().replace(/^\|/, '').replace(/\|$/, '');
        normalized = normalized.split('|').map((cell) => cell.trim()).filter(Boolean).join(' ');
      }
      return normalized
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/^\s{0,3}(?:[-+*]|\d+[.)])\s+/, '')
        .replace(/^(?:\s{0,3}>[ \t]?)+/, '');
    })
    .join('\n');

  return structuralText
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/(^|[^\w])__([^_\n]+)__($|[^\w])/g, '$1$2$3')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/(^|[^\w])_([^_\n]+)_($|[^\w])/g, '$1$2$3')
    .replace(/~~([^~\n]+)~~/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
}
