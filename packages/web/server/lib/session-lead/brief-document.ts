export const BRIEF_MAX_LENGTH = 12_000;
export const BRIEF_NUDGE_LENGTH = 9_000;
export const STRAND_MAX_LENGTH = 600;

const STRANDS_MARKER = '<!-- lead strands: set and closed with lead.brief strands -->';
const STRANDS_HEADING = '## Strands';
const STRAND_HEADING = /^### ([a-z0-9][a-z0-9-]{0,39})$/;
const ANY_HEADING = /^\s*#{1,6}\s/m;
const LARGEST_SHOWN = 3;

export interface Strand {
  id: string;
  text: string;
}

export type StrandChange = { id: string; text: string } | { id: string; close: true };

export interface BriefDocument {
  free: string;
  strands: Strand[];
}

export const holdsStrandsSection = (text: string) => text.split(/\r?\n/).some((line) => line.trim() === STRANDS_MARKER);

export const readBriefDocument = (file: string): BriefDocument => {
  const lines = file.split(/\r?\n/);
  const marker = lines.findIndex((line) => line.trim() === STRANDS_MARKER);
  if (marker === -1) return { free: file, strands: [] };
  const free = lines.slice(0, marker);
  const strands: { id: string; lines: string[] }[] = [];
  let inStrand = false;
  for (const line of lines.slice(marker + 1)) {
    const id = STRAND_HEADING.exec(line.trimEnd())?.[1];
    if (id) strands.push({ id, lines: [] });
    if (id || ANY_HEADING.test(line)) inStrand = Boolean(id);
    if (id || line.trim() === STRANDS_HEADING) continue;
    if (inStrand) strands.at(-1)?.lines.push(line);
    else free.push(line);
  }
  return { free: free.join('\n'), strands: strands.map(({ id, lines: body }) => ({ id, text: body.join('\n').trim() })) };
};

export const writeBriefDocument = ({ free, strands }: BriefDocument) => {
  if (strands.length === 0) return free.trim();
  return [free.trim(), STRANDS_MARKER, STRANDS_HEADING, ...strands.map(({ id, text }) => `### ${id}\n\n${text}`)].join('\n\n');
};

const invalidChange = (change: StrandChange) => {
  if (!STRAND_HEADING.test(`### ${change.id}`)) return `"${change.id.slice(0, 60)}" is not a strand id: use lowercase letters, digits and hyphens, at most 40`;
  if ('close' in change) return null;
  const text = change.text.trim();
  if (!text) return `Strand ${change.id} has no text; to remove it, send { id, close: true }`;
  if (text.length > STRAND_MAX_LENGTH) return `Strand ${change.id} is ${text.length} characters; the limit is ${STRAND_MAX_LENGTH}. Keep the expected result, the session and where it stands now, without history`;
  if (ANY_HEADING.test(text) || holdsStrandsSection(text)) return `Strand ${change.id}: its text is plain lines without headings`;
  return null;
};

export const changeStrands = (current: readonly Strand[], changes: readonly StrandChange[]) => {
  const changed = { added: new Array<string>(), replaced: new Array<string>(), closed: new Array<string>() };
  let strands = [...current];
  const seen = new Set<string>();
  for (const change of changes) {
    const invalid = invalidChange(change);
    if (invalid) return { error: invalid };
    if (seen.has(change.id)) return { error: `Strand ${change.id} is named twice in one call` };
    seen.add(change.id);
    const index = strands.findIndex(({ id }) => id === change.id);
    if ('close' in change) {
      if (index === -1) return { error: `There is no strand ${change.id}. Open strands: ${strands.map(({ id }) => id).join(', ') || 'none'}` };
      strands = strands.filter(({ id }) => id !== change.id);
      changed.closed.push(change.id);
      continue;
    }
    const next = { id: change.id, text: change.text.trim() };
    if (index === -1) strands.push(next);
    else strands = strands.flatMap((strand, position) => (position === index ? [next] : strand.id === change.id ? [] : [strand]));
    changed[index === -1 ? 'added' : 'replaced'].push(change.id);
  }
  return { strands, changed };
};

export const briefFill = (document: BriefDocument) => {
  const length = writeBriefDocument(document).length;
  const largest = document.strands
    .map(({ id, text }) => ({ id, length: text.length }))
    .sort((left, right) => right.length - left.length)
    .slice(0, LARGEST_SHOWN);
  const fill = { length, limit: BRIEF_MAX_LENGTH, full: `${Math.round((length / BRIEF_MAX_LENGTH) * 100)}%`, freeTextLength: document.free.trim().length, largestStrands: largest };
  if (length < BRIEF_NUDGE_LENGTH) return fill;
  return { ...fill, note: 'The brief is close to its limit, and a write above the limit is refused. Condense it now: close finished strands, shorten the largest parts, and drop rules that live elsewhere.' };
};
