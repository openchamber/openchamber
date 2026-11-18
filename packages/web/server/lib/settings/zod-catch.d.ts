import type { core, ZodType } from 'zod';

declare module 'zod' {
  interface ZodType<
    out Output,
    out Input,
    out Internals extends core.$ZodTypeInternals<Output, Input>,
  > {
    catch(def: undefined): ZodType<
      core.output<this> | undefined,
      core.input<this>,
      core.$ZodTypeInternals<core.output<this> | undefined, core.input<this>> & {
        optin: this['_zod']['optin'];
        optout: 'optional';
      }
    >;
  }
}
