import type { core } from 'zod';

declare module 'zod' {
  interface ZodType<out Output = unknown, out Input = unknown, out Internals extends core.$ZodTypeInternals<Output, Input> = core.$ZodTypeInternals<Output, Input>> {
    catch(def: false): ZodType<core.output<this> | false, core.input<this>>;
  }
}

declare module 'luxon' {
  export namespace DateTime {
    function fromISO(value: string, options: { zone: string }): DateTime;
  }

  export class IANAZone {
    static isValidZone(zone: string): boolean;
  }
}
