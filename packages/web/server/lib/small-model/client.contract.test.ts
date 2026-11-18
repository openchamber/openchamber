import { expectTypeOf, it } from 'vitest';
import type { ExperimentalGenerateTextInput, ModelDefaultOutput, ModelInfo } from '@opencode/client';
import type { ForwardedGenerationInput } from './contracts.js';
import { getDefaultModelInfo } from './client.js';
import { generateSmallModelText } from './index.js';

it('retains the default envelope without promising a generation model', () => {
  type DefaultModel = Awaited<ReturnType<typeof getDefaultModelInfo>>;
  type DefaultEnvelope = Exclude<DefaultModel, ModelInfo | null>;
  type GenerationModel = NonNullable<ExperimentalGenerateTextInput['model']>;

  expectTypeOf<DefaultEnvelope>().toEqualTypeOf<ModelDefaultOutput & { id: string }>();
  expectTypeOf<DefaultEnvelope>().not.toExtend<GenerationModel>();
});

it('keeps unchecked model identifiers in forwarding and generation results', () => {
  type Model = NonNullable<ForwardedGenerationInput['model']>;
  type Result = Awaited<ReturnType<typeof generateSmallModelText>>;

  expectTypeOf<Model['providerID']>().toEqualTypeOf<unknown>();
  expectTypeOf<Model['id']>().toEqualTypeOf<unknown>();
  expectTypeOf<ExperimentalGenerateTextInput>().toExtend<ForwardedGenerationInput>();
  expectTypeOf<Result['providerID']>().toEqualTypeOf<unknown>();
  expectTypeOf<Result['modelID']>().toEqualTypeOf<unknown>();
});
