import type { core } from 'zod';

declare module 'zod' {
  interface ZodType<out Output = unknown, out Input = unknown, out Internals extends core.$ZodTypeInternals<Output, Input> = core.$ZodTypeInternals<Output, Input>> {
    catch(def: false): ZodType<core.output<this> | false, core.input<this>>;
  }
}
