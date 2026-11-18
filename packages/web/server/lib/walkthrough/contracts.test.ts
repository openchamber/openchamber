import { expectTypeOf, it } from 'vitest';
import { buildPrompt } from './prompt.js';
import type { ModelJson } from './schema.js';

it('exposes only the fields validated when reading stored JSON', () => {
  expectTypeOf<Parameters<typeof buildPrompt>[0]['previousWalkthrough']>().toEqualTypeOf<ModelJson | undefined>();
});
