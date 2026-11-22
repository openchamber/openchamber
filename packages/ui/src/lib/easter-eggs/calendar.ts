
export type Occasion = 'halloween' | 'newYearsEve' | 'newYearsDay';

export const occasionOf = (date: Date): Occasion | null => {
  const month = date.getMonth();
  const day = date.getDate();
  if (month === 9 && day === 31) return 'halloween';
  if (month === 11 && day === 31) return 'newYearsEve';
  if (month === 0 && day === 1) return 'newYearsDay';
  return null;
};

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

interface Holiday {
  celebration: Celebration;
  startsOn: (date: Date) => boolean;
  days?: number;
  country?: 'UA' | 'US';
}

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
  { celebration: 'eidAlFitr', startsOn: (date) => monthDayIn(formats().islamic, date) === '10/1' },
  { celebration: 'ukraineIndependence', startsOn: on(8, 24), country: 'UA' },
  { celebration: 'usIndependence', startsOn: on(7, 4), country: 'US' },
  { celebration: 'thanksgiving', startsOn: (date) => date.getMonth() === 10 && date.getDay() === 4 && date.getDate() >= 22 && date.getDate() <= 28, country: 'US' },
  { celebration: 'valentines', startsOn: on(2, 14) },
  { celebration: 'stPatricks', startsOn: on(3, 17) },
];

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
  'America/Indianapolis', 'America/Louisville', 'America/Fort_Wayne', 'America/Knox_IN',
]);
const US_ZONE_PREFIXES = ['America/Indiana/', 'America/Kentucky/', 'America/North_Dakota/', 'US/'];

const SOUTHERN_ZONES = new Set([
  'Pacific/Auckland', 'Pacific/Chatham', 'Pacific/Norfolk', 'America/Santiago', 'America/Punta_Arenas',
  'America/Sao_Paulo', 'America/Montevideo', 'America/Asuncion', 'America/Buenos_Aires',
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

const runsAround = (date: Date, holiday: Holiday): boolean => {
  const days = holiday.days ?? 1;
  for (let k = -1; k <= days; k += 1) {
    if (holiday.startsOn(shifted(date, -k))) return true;
  }
  return false;
};

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

export const isFridayEvening = (date: Date): boolean => date.getDay() === 5 && date.getHours() >= 18;

export const isSmallHours = (date: Date): boolean => date.getHours() < 5;

export const isDeepNight = (date: Date): boolean => date.getHours() >= 1 && date.getHours() < 5;
