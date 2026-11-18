import { expectTypeOf, it } from 'vitest';
import { readCachedWalkthrough, readPointer } from './store.js';
import { normalizeWalkthrough, parseModelJson } from './schema.js';
import { buildPrompt } from './prompt.js';
import type { ModelJson, Walkthrough } from './schema.js';

it('exposes only the fields validated when reading stored JSON', () => {
  type Entry = NonNullable<ReturnType<typeof readCachedWalkthrough>>;
  type Pointer = NonNullable<ReturnType<typeof readPointer>>;
  expectTypeOf<Entry['walkthrough']['chapters']>().toEqualTypeOf<ModelJson[]>();
  expectTypeOf<Entry['model']>().toEqualTypeOf<ModelJson | undefined>();
  expectTypeOf<Entry['generatedAt']>().toEqualTypeOf<ModelJson | undefined>();
  expectTypeOf<Pointer['cacheKey']>().toEqualTypeOf<string>();
  expectTypeOf<Pointer['repoRoot']>().toEqualTypeOf<ModelJson | undefined>();
  expectTypeOf<ReturnType<typeof parseModelJson>>().toEqualTypeOf<ModelJson>();
  expectTypeOf<ReturnType<typeof normalizeWalkthrough>>().toEqualTypeOf<Walkthrough>();
  expectTypeOf<Parameters<typeof buildPrompt>[0]['previousWalkthrough']>().toEqualTypeOf<ModelJson | undefined>();
});
