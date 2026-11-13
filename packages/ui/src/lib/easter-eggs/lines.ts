import { isDeepNight, isFridayEvening, isSmallHours, occasionOf, type Occasion } from './calendar';
import type { EasterEggCopy, ToastLine } from './copy/types';

/**
 * A commit gets a deletion line only when it removes at least this many more
 * lines than it adds: a two-line cleanup is every other commit, and a joke
 * that shows every day stops being one.
 */
export const NET_DELETION_THRESHOLD = 10;

const pick = <T>(lines: readonly T[], seed: number): T | null => (
  lines.length === 0 ? null : lines[Math.abs(Math.trunc(seed)) % lines.length]
);

export type DraftMoment = Occasion | 'deepNight' | 'everyday';

export const draftMomentAt = (date: Date): DraftMoment => (
  occasionOf(date) ?? (isDeepNight(date) ? 'deepNight' : 'everyday')
);

/** A heading with `{project}` still in it; an empty moment list falls back to `everyday`. */
export const draftTitleLine = (copy: EasterEggCopy, moment: DraftMoment, seed: number): string | null => {
  const lines = copy.draftTitle[moment];
  return pick(lines.length > 0 ? lines : copy.draftTitle.everyday, seed);
};

export const gitCleanLine = (copy: EasterEggCopy, date: Date, seed: number): string | null => {
  const occasion = occasionOf(date);
  const lines = occasion && copy.gitClean[occasion].length > 0 ? copy.gitClean[occasion] : copy.gitClean.everyday;
  return pick(lines, seed);
};

/** The toast for a push at this moment, or null for the ordinary "Pushed". */
export const pushLine = (copy: EasterEggCopy, date: Date, intlLocale: string, seed: number): ToastLine | null => {
  if (isSmallHours(date)) {
    const line = pick(copy.push.smallHours, seed);
    if (!line) return null;
    const time = date.toLocaleTimeString(intlLocale, { hour: 'numeric', minute: '2-digit' });
    return { ...line, title: line.title.replace('{time}', () => time) };
  }
  if (isFridayEvening(date)) return pick(copy.push.fridayEvening, seed);
  return null;
};

/** The toast for a commit that removes clearly more than it adds, or null for the ordinary one. */
export const netDeletionLine = (
  copy: EasterEggCopy,
  summary: { insertions: number; deletions: number },
  intlLocale: string,
  seed: number,
): ToastLine | null => {
  const count = summary.deletions - summary.insertions;
  if (count < NET_DELETION_THRESHOLD) return null;
  const line = pick(copy.netDeletionCommit, seed);
  if (!line) return null;
  const template = line.title[new Intl.PluralRules(intlLocale).select(count)] ?? line.title.other;
  return {
    title: template.replace('{count}', new Intl.NumberFormat(intlLocale).format(count)),
    description: line.description,
  };
};

/**
 * One block of reasoning in this many gets a joke in place of "thinking": the
 * model thinks in nearly every step, and a joke shown every time stops being one.
 */
export const THINKING_LINE_ODDS = 4;

const hashSeed = (value: string): number => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  return Math.abs(hash);
};

/**
 * The joke for a block of reasoning, keyed on its part id so it stays while
 * the block runs; null for the ordinary "thinking".
 */
export const thinkingLine = (copy: EasterEggCopy, seed: string): string | null => {
  if (hashSeed(seed) % THINKING_LINE_ODDS !== 0) return null;
  return pick(copy.thinking, hashSeed(`${seed}:line`));
};
