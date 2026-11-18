import { expectTypeOf, it } from 'vitest';
import { buildPrompt } from './prompt.js';
import type { ModelJson } from './schema.js';
import type { Json } from '../source-control/provider-contract.js';
import type { getPullRequestDiff, getPullRequestFileContents } from './pull-request.js';

it('exposes only the fields validated when reading stored JSON', () => {
  expectTypeOf<Parameters<typeof buildPrompt>[0]['previousWalkthrough']>().toEqualTypeOf<ModelJson | undefined>();
});

it('keeps provider read results within their checked JSON contract', () => {
  expectTypeOf<Awaited<ReturnType<typeof getPullRequestFileContents>>>().toEqualTypeOf<Json>();
  expectTypeOf<Awaited<ReturnType<typeof getPullRequestDiff>>['patch']>().toEqualTypeOf<Json | undefined>();
  expectTypeOf<Awaited<ReturnType<typeof getPullRequestDiff>>['meta']>().toEqualTypeOf<Json | undefined>();
});
