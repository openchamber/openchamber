/**
 * The moments the easter eggs react to, read from the viewer's local clock:
 * a push at 2am means 2am where the person sits, whatever the server thinks.
 */

export type Occasion = 'halloween' | 'newYearsEve' | 'newYearsDay';

export const occasionOf = (date: Date): Occasion | null => {
  const month = date.getMonth();
  const day = date.getDate();
  if (month === 9 && day === 31) return 'halloween';
  if (month === 11 && day === 31) return 'newYearsEve';
  if (month === 0 && day === 1) return 'newYearsDay';
  return null;
};

/** What a push or merge celebration looks like on a given day. */
export type Celebration =
  | 'halloween'
  | 'newYear'
  | 'valentines'
  | 'stPatricks'
  | 'lunarNewYear'
  | 'eidAlFitr'
  | 'winterHolidays'
  | 'ukraineIndependence'
  | 'usIndependence'
  | 'thanksgiving'
  | 'spring'
  | 'summer'
  | 'autumn'
  | 'winter';

type Season = 'spring' | 'summer' | 'autumn' | 'winter';

/** One holiday: does it start on this date, and for how many days does it run. */
interface Holiday {
  celebration: Celebration;
  startsOn: (date: Date) => boolean;
  days?: number;
  /** Shown only where the viewer's time zone says they live in that country. */
  country?: 'UA' | 'US';
}

// A calendar the engine lacks makes Intl fall back to Gregorian without a
// word, and a Gregorian "1/1" would put Lunar New Year on January 1st.
const calendarFormat = (calendar: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat | null => {
  try {
    const format = new Intl.DateTimeFormat(`en-u-ca-${calendar}`, options);
    return format.resolvedOptions().calendar === calendar ? format : null;
  } catch {
    return null;
  }
};

let calendarFormats: Record<'chinese' | 'hebrew' | 'islamic', Intl.DateTimeFormat | null> | null = null;
const formats = () => {
  calendarFormats ??= {
    chinese: calendarFormat('chinese', { month: 'numeric', day: 'numeric' }),
    hebrew: calendarFormat('hebrew', { month: 'long', day: 'numeric' }),
    islamic: calendarFormat('islamic-umalqura', { month: 'numeric', day: 'numeric' }),
  };
  return calendarFormats;
};

const monthDayIn = (format: Intl.DateTimeFormat | null, date: Date): string | null => {
  if (!format) return null;
  const parts = format.formatToParts(date);
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  return month && day ? `${month}/${day}` : null;
};

const on = (month: number, day: number) => (date: Date) => date.getMonth() === month - 1 && date.getDate() === day;

const HOLIDAYS: readonly Holiday[] = [
  { celebration: 'newYear', startsOn: on(12, 31), days: 2 },
  { celebration: 'halloween', startsOn: on(10, 31) },
  { celebration: 'winterHolidays', startsOn: on(12, 25) },
  { celebration: 'winterHolidays', startsOn: (date) => monthDayIn(formats().hebrew, date) === 'Kislev/25', days: 8 },
  { celebration: 'lunarNewYear', startsOn: (date) => monthDayIn(formats().chinese, date) === '1/1' },
  // The Umm al-Qura date is computed; many countries start Eid on a sighting
  // of the moon, a day either side, which the day before and after cover.
  { celebration: 'eidAlFitr', startsOn: (date) => monthDayIn(formats().islamic, date) === '10/1' },
  { celebration: 'ukraineIndependence', startsOn: on(8, 24), country: 'UA' },
  { celebration: 'usIndependence', startsOn: on(7, 4), country: 'US' },
  // The fourth Thursday of November.
  { celebration: 'thanksgiving', startsOn: (date) => date.getMonth() === 10 && date.getDay() === 4 && date.getDate() >= 22 && date.getDate() <= 28, country: 'US' },
  { celebration: 'valentines', startsOn: on(2, 14) },
  { celebration: 'stPatricks', startsOn: on(3, 17) },
];

// Seasons start on the 1st, the way Ukraine counts them; south of the
// equator the same day starts the opposite season.
const SEASON_STARTS: readonly { month: number; north: Season; south: Season }[] = [
  { month: 3, north: 'spring', south: 'autumn' },
  { month: 6, north: 'summer', south: 'winter' },
  { month: 9, north: 'autumn', south: 'spring' },
  { month: 12, north: 'winter', south: 'summer' },
];

const UKRAINE_ZONES = new Set(['Europe/Kyiv', 'Europe/Kiev', 'Europe/Simferopol', 'Europe/Uzhgorod', 'Europe/Zaporozhye']);

const US_ZONES = new Set([
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles',
  'America/Anchorage', 'America/Adak', 'America/Boise', 'America/Detroit', 'America/Juneau', 'America/Menominee',
  'America/Metlakatla', 'America/Nome', 'America/Sitka', 'America/Yakutat', 'Pacific/Honolulu', 'America/Puerto_Rico',
  // Chromium reports the old names of these zones.
  'America/Indianapolis', 'America/Louisville', 'America/Fort_Wayne', 'America/Knox_IN',
]);
const US_ZONE_PREFIXES = ['America/Indiana/', 'America/Kentucky/', 'America/North_Dakota/', 'US/'];

const SOUTHERN_ZONES = new Set([
  'Pacific/Auckland', 'Pacific/Chatham', 'Pacific/Norfolk', 'America/Santiago', 'America/Punta_Arenas',
  'America/Sao_Paulo', 'America/Montevideo', 'America/Asuncion', 'America/Buenos_Aires',
  // Chromium reports the old names of Argentina's zones, without the Argentina/ prefix.
  'America/Cordoba', 'America/Catamarca', 'America/Jujuy', 'America/Mendoza', 'America/Lima', 'America/La_Paz',
  'America/Bahia', 'America/Cuiaba', 'America/Campo_Grande', 'America/Recife', 'America/Porto_Velho',
  'America/Maceio', 'America/Araguaina', 'Africa/Johannesburg', 'Africa/Maseru', 'Africa/Mbabane', 'Africa/Windhoek',
  'Africa/Maputo', 'Africa/Gaborone', 'Africa/Harare', 'Africa/Lusaka', 'Africa/Lubumbashi', 'Africa/Blantyre',
  'Africa/Luanda', 'Africa/Dar_es_Salaam', 'Indian/Antananarivo', 'Indian/Mauritius', 'Indian/Reunion',
  'Pacific/Fiji', 'Pacific/Tongatapu', 'Pacific/Noumea', 'Pacific/Apia', 'Pacific/Port_Moresby', 'Pacific/Efate',
  'Pacific/Tahiti', 'Pacific/Rarotonga', 'Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura', 'Asia/Dili',
]);
const SOUTHERN_ZONE_PREFIXES = ['Australia/', 'America/Argentina/', 'Antarctica/'];

const inZones = (zone: string, names: ReadonlySet<string>, prefixes: readonly string[]) => (
  names.has(zone) || prefixes.some((prefix) => zone.startsWith(prefix))
);

const countryOf = (timeZone: string): 'UA' | 'US' | null => {
  if (UKRAINE_ZONES.has(timeZone)) return 'UA';
  if (inZones(timeZone, US_ZONES, US_ZONE_PREFIXES)) return 'US';
  return null;
};

const shifted = (date: Date, days: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, 12);

/** True when the holiday runs on `date` or on the day either side of it. */
const runsAround = (date: Date, holiday: Holiday): boolean => {
  const days = holiday.days ?? 1;
  // The holiday started k days ago, for k from the day after it ends back to the day before it starts.
  for (let k = -1; k <= days; k += 1) {
    if (holiday.startsOn(shifted(date, -k))) return true;
  }
  return false;
};

/**
 * The celebration for this day in the viewer's time zone, or null for plain
 * confetti. Each one runs from the day before to the day after.
 */
export const celebrationOf = (
  date: Date,
  timeZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
): Celebration | null => {
  const country = countryOf(timeZone);
  for (const holiday of HOLIDAYS) {
    if (holiday.country && holiday.country !== country) continue;
    if (runsAround(date, holiday)) return holiday.celebration;
  }
  const southern = inZones(timeZone, SOUTHERN_ZONES, SOUTHERN_ZONE_PREFIXES);
  for (const season of SEASON_STARTS) {
    if (runsAround(date, { celebration: season.north, startsOn: on(season.month, 1) })) {
      return southern ? season.south : season.north;
    }
  }
  return null;
};

/** Friday from 18:00 to midnight. */
export const isFridayEvening = (date: Date): boolean => date.getDay() === 5 && date.getHours() >= 18;

/** Midnight to 05:00: a push here gets the late-night toast. */
export const isSmallHours = (date: Date): boolean => date.getHours() < 5;

/** 01:00 to 05:00: a new chat this late gets the "still up?" heading. */
export const isDeepNight = (date: Date): boolean => date.getHours() >= 1 && date.getHours() < 5;
