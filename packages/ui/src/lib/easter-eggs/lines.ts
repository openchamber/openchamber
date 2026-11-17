import { isDeepNight, isFridayEvening, isSmallHours, occasionOf, type Occasion } from './calendar';
import type { EasterEggCopy, ToastLine } from './copy/types';

export const NET_DELETION_THRESHOLD = 10;

const pick = <T>(lines: readonly T[], seed: number): T | null => (
  lines.length === 0 ? null : lines[Math.abs(Math.trunc(seed)) % lines.length]
);

export type DraftMoment = Occasion | 'deepNight' | 'everyday';

export const draftMomentAt = (date: Date): DraftMoment => (
  occasionOf(date) ?? (isDeepNight(date) ? 'deepNight' : 'everyday')
);

export const draftTitleLine = (copy: EasterEggCopy, moment: DraftMoment, seed: number): string | null => {
  const lines = copy.draftTitle[moment];
  return pick(lines.length > 0 ? lines : copy.draftTitle.everyday, seed);
};

export const gitCleanLine = (copy: EasterEggCopy, date: Date, seed: number): string | null => {
  const occasion = occasionOf(date);
  const lines = occasion && copy.gitClean[occasion].length > 0 ? copy.gitClean[occasion] : copy.gitClean.everyday;
  return pick(lines, seed);
};

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

export const THINKING_LINE_ODDS = 4;

const hashSeed = (value: string): number => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  return Math.abs(hash);
};

export const thinkingLine = (copy: EasterEggCopy, seed: string): string | null => {
  if (hashSeed(seed) % THINKING_LINE_ODDS !== 0) return null;
  return pick(copy.thinking, hashSeed(`${seed}:line`));
};
