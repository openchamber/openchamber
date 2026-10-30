import { describe, expect, test } from 'bun:test';

import { LOCALES, type Locale } from '@/lib/i18n/runtime';

import { celebrationOf, isDeepNight, isFridayEvening, isSmallHours, occasionOf } from './calendar';
import { copy as ar } from './copy/ar';
import { copy as de } from './copy/de';
import { copy as en } from './copy/en';
import { copy as es } from './copy/es';
import { copy as fr } from './copy/fr';
import { copy as he } from './copy/he';
import { copy as ja } from './copy/ja';
import { copy as ko } from './copy/ko';
import { copy as nl } from './copy/nl';
import { copy as pl } from './copy/pl';
import { copy as ptBR } from './copy/pt-BR';
import { copy as tr } from './copy/tr';
import type { EasterEggCopy } from './copy/types';
import { copy as uk } from './copy/uk';
import { copy as zhCN } from './copy/zh-CN';
import { copy as zhTW } from './copy/zh-TW';
import { draftMomentAt, draftTitleLine, gitCleanLine, netDeletionLine, NET_DELETION_THRESHOLD, pushLine } from './lines';

const COPIES = {
  en, de, fr, nl, 'zh-CN': zhCN, 'zh-TW': zhTW, uk, es, 'pt-BR': ptBR, ko, pl, ja, tr, ar, he,
} satisfies Record<Locale, EasterEggCopy>;

// Local time, the way the app reads the clock. 2026-10-30 is a Friday.
const at = (month: number, day: number, hour: number, minute = 0) => new Date(2026, month - 1, day, hour, minute);

describe('calendar', () => {
  test('names the occasions by local date', () => {
    expect(occasionOf(at(10, 31, 0))).toBe('halloween');
    expect(occasionOf(at(10, 31, 23, 59))).toBe('halloween');
    expect(occasionOf(at(11, 1, 0))).toBeNull();
    expect(occasionOf(at(12, 31, 12))).toBe('newYearsEve');
    expect(occasionOf(at(1, 1, 12))).toBe('newYearsDay');
    expect(occasionOf(at(6, 15, 12))).toBeNull();
  });

  test('a celebration runs from the day before to the day after', () => {
    const kyiv = 'Europe/Kyiv';
    expect(celebrationOf(at(10, 29, 12), kyiv)).toBeNull();
    expect(celebrationOf(at(10, 30, 0), kyiv)).toBe('halloween');
    expect(celebrationOf(at(11, 1, 23, 59), kyiv)).toBe('halloween');
    expect(celebrationOf(at(11, 2, 0), kyiv)).toBeNull();
    expect(celebrationOf(at(12, 30, 12), kyiv)).toBe('newYear');
    expect(celebrationOf(new Date(2027, 0, 2, 12), kyiv)).toBe('newYear');
    expect(celebrationOf(at(2, 13, 12), kyiv)).toBe('valentines');
    expect(celebrationOf(at(3, 18, 12), kyiv)).toBe('stPatricks');
    expect(celebrationOf(at(12, 24, 12), kyiv)).toBe('winterHolidays');
  });

  test('moving holidays follow their own calendars', () => {
    const london = 'Europe/London';
    // Lunar New Year 2026 is February 17th (engines disagree on some years,
    // 2027 among them, by a day), Eid al-Fitr 2027 March 9th, Hanukkah 2026
    // runs from December 5th for eight days.
    expect(celebrationOf(at(2, 16, 12), london)).toBe('lunarNewYear');
    expect(celebrationOf(at(2, 19, 12), london)).toBeNull();
    expect(celebrationOf(new Date(2027, 2, 10, 12), london)).toBe('eidAlFitr');
    expect(celebrationOf(at(12, 4, 12), london)).toBe('winterHolidays');
    expect(celebrationOf(at(12, 13, 12), london)).toBe('winterHolidays');
    expect(celebrationOf(at(12, 14, 12), london)).toBeNull();
  });

  test('national days show only in their country', () => {
    expect(celebrationOf(at(8, 24, 12), 'Europe/Kyiv')).toBe('ukraineIndependence');
    expect(celebrationOf(at(8, 24, 12), 'America/New_York')).toBeNull();
    expect(celebrationOf(at(7, 4, 12), 'America/Indiana/Indianapolis')).toBe('usIndependence');
    expect(celebrationOf(at(7, 4, 12), 'America/Indianapolis')).toBe('usIndependence');
    expect(celebrationOf(at(7, 4, 12), 'Europe/Kyiv')).toBeNull();
    // Thanksgiving 2026 is Thursday, November 26th.
    expect(celebrationOf(at(11, 27, 12), 'America/Chicago')).toBe('thanksgiving');
    expect(celebrationOf(at(11, 19, 12), 'America/Chicago')).toBeNull();
    expect(celebrationOf(at(11, 26, 12), 'Europe/London')).toBeNull();
  });

  test('seasons start on the 1st and swap south of the equator', () => {
    expect(celebrationOf(at(3, 1, 12), 'Europe/Kyiv')).toBe('spring');
    expect(celebrationOf(at(5, 31, 12), 'Europe/Kyiv')).toBe('summer');
    expect(celebrationOf(at(9, 2, 12), 'Europe/Kyiv')).toBe('autumn');
    expect(celebrationOf(at(11, 30, 12), 'Asia/Tokyo')).toBe('winter');
    expect(celebrationOf(at(12, 1, 12), 'Australia/Sydney')).toBe('summer');
    expect(celebrationOf(at(3, 1, 12), 'America/Argentina/Buenos_Aires')).toBe('autumn');
    expect(celebrationOf(at(3, 1, 12), 'America/Cordoba')).toBe('autumn');
    expect(celebrationOf(at(9, 3, 12), 'Europe/Kyiv')).toBeNull();
  });

  test('Friday evening runs from 18:00 to midnight', () => {
    expect(isFridayEvening(at(10, 30, 17, 59))).toBe(false);
    expect(isFridayEvening(at(10, 30, 18))).toBe(true);
    expect(isFridayEvening(at(10, 30, 23, 59))).toBe(true);
    expect(isFridayEvening(at(10, 31, 0, 30))).toBe(false);
    expect(isFridayEvening(at(10, 29, 20))).toBe(false);
  });

  test('small hours start at midnight, deep night at 01:00, both end at 05:00', () => {
    expect(isSmallHours(at(10, 28, 0, 10))).toBe(true);
    expect(isSmallHours(at(10, 28, 4, 59))).toBe(true);
    expect(isSmallHours(at(10, 28, 5))).toBe(false);
    expect(isDeepNight(at(10, 28, 0, 59))).toBe(false);
    expect(isDeepNight(at(10, 28, 1))).toBe(true);
    expect(isDeepNight(at(10, 28, 5))).toBe(false);
  });
});

describe('lines', () => {
  test('an occasion outranks the night for the draft heading', () => {
    expect(draftMomentAt(at(10, 31, 2))).toBe('halloween');
    expect(draftMomentAt(at(10, 28, 2))).toBe('deepNight');
    expect(draftMomentAt(at(10, 28, 14))).toBe('everyday');
    expect(draftTitleLine(en, 'deepNight', 6)).toBe('Still up? What are we working on in {project}?');
  });

  test('an empty occasion list falls back to everyday lines', () => {
    const plain: EasterEggCopy = { ...en, gitClean: { ...en.gitClean, halloween: [] } };
    expect(en.gitClean.everyday).toContain(gitCleanLine(plain, at(10, 31, 12), 0) ?? '');
  });

  test('a late push names its time, a Friday evening push gets the brave line', () => {
    expect(pushLine(en, at(10, 28, 2, 14), 'en-US', 0)?.title).toBe('Pushed at 2:14 AM.');
    expect(pushLine(en, at(10, 28, 2, 14), 'en-US', 4)?.title).toBe('2:14 AM, pushed.');
    expect(pushLine(en, at(10, 30, 19), 'en-US', 0)?.title).toBe('Brave.');
    expect(pushLine(en, at(10, 30, 19), 'en-US', 1)?.title).toBe('Bold move.');
    expect(pushLine(en, at(10, 28, 14), 'en-US', 0)).toBeNull();
    // Friday evening is the weekend there already: an ordinary toast.
    expect(pushLine(he, at(10, 30, 19), 'he-IL', 0)).toBeNull();
  });

  test('only a clear net deletion gets a line, in the right plural', () => {
    expect(netDeletionLine(en, { insertions: 5, deletions: 5 + NET_DELETION_THRESHOLD - 1 }, 'en-US', 0)).toBeNull();
    expect(netDeletionLine(en, { insertions: 3, deletions: 415 }, 'en-US', 0)?.title).toBe('412 lines retired.');
    expect(netDeletionLine(uk, { insertions: 0, deletions: 22 }, 'uk-UA', 1)?.title).toBe('−22 рядки.');
    expect(netDeletionLine(uk, { insertions: 0, deletions: 25 }, 'uk-UA', 1)?.title).toBe('−25 рядків.');
    expect(netDeletionLine(en, { insertions: 0, deletions: 1200 }, 'en-US', 1)?.title).toBe('−1,200 lines.');
  });
});

describe('every locale', () => {
  test('has its own copy', () => {
    expect(Object.keys(COPIES).sort()).toEqual([...LOCALES].sort());
  });

  for (const [locale, copy] of Object.entries(COPIES)) {
    test(`${locale}: placeholders are where the code fills them`, () => {
      expect(copy.draftTitle.everyday.length).toBeGreaterThan(0);
      expect(copy.gitClean.everyday.length).toBeGreaterThan(0);
      expect(copy.netDeletionCommit.length).toBeGreaterThan(0);
      for (const line of Object.values(copy.draftTitle).flat()) expect(`${locale}: ${line}`).toContain('{project}');
      expect(copy.push.smallHours.length).toBeGreaterThan(0);
      for (const { title } of copy.push.smallHours) expect(`${locale}: ${title}`).toContain('{time}');
      for (const { title } of copy.netDeletionCommit) {
        for (const form of Object.values(title)) expect(`${locale}: ${form}`).toContain('{count}');
      }
    });
  }
});
