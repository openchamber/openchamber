import { expectTypeOf, it } from 'vitest';
import type { ExperimentalGenerateTextInput, ModelDefaultOutput, ModelInfo } from '@opencode/client';
import { getDefaultModelInfo } from './client.js';

it('retains the default envelope without promising a generation model', () => {
  type DefaultModel = Awaited<ReturnType<typeof getDefaultModelInfo>>;
  type DefaultEnvelope = Exclude<DefaultModel, ModelInfo | null>;
  type GenerationModel = NonNullable<ExperimentalGenerateTextInput['model']>;

  expectTypeOf<DefaultEnvelope>().toEqualTypeOf<ModelDefaultOutput & { id: string }>();
  expectTypeOf<DefaultEnvelope>().not.toExtend<GenerationModel>();
});
