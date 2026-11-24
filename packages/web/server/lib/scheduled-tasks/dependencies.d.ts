declare module 'luxon' {
  export class DateTime {
    static local(): DateTime;
    static fromMillis(value: number, options: { zone: string }): DateTime;
    static fromFormat(value: string, format: string, options: { zone: string }): DateTime;
    readonly isValid: boolean;
    readonly zoneName: string;
    readonly weekday: number;
    set(values: { hour: number; minute: number; second: number; millisecond: number }): DateTime;
    plus(values: { milliseconds: number } | { days: number }): DateTime;
    toMillis(): number;
    toFormat(format: string): string;
    valueOf(): number;
  }
}
