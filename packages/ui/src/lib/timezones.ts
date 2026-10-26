// Some ICU builds still expose pre-rename IANA timezone ids. Display (and
// persist going forward) the modern names.
const LEGACY_TIMEZONE_ALIASES: Record<string, string> = {
  'Europe/Kiev': 'Europe/Kyiv',
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'America/Godthab': 'America/Nuuk',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'Pacific/Enderbury': 'Pacific/Kanton',
};

export const canonicalizeTimezone = (timezone: string): string => LEGACY_TIMEZONE_ALIASES[timezone] ?? timezone;
