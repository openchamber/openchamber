import { describe, expect, test } from 'bun:test';
import { mergeModelMetadataWithLiveModel } from './modelMetadata';

describe('mergeModelMetadataWithLiveModel', () => {
  test('prefers authoritative live limits and capabilities over catalog metadata', () => {
    const result = mergeModelMetadataWithLiveModel('example', {
      id: 'vision-model',
      capabilities: {
        toolcall: false,
        reasoning: true,
        attachment: true,
        input: { text: true, image: true, audio: false },
        output: { text: true, image: false },
      },
      limit: { context: 200_000, output: 32_000 },
    }, {
      id: 'vision-model',
      providerId: 'example',
      tool_call: true,
      reasoning: false,
      attachment: false,
      modalities: { input: ['text'], output: ['text', 'image'] },
      limit: { context: 128_000, output: 8_000 },
    });

    expect(result).toEqual({
      id: 'vision-model',
      providerId: 'example',
      tool_call: false,
      reasoning: true,
      attachment: true,
      modalities: { input: ['text', 'image'], output: ['text'] },
      limit: { context: 200_000, output: 32_000 },
    });
  });

  test('accepts array modalities and tools from the current model API shape', () => {
    const result = mergeModelMetadataWithLiveModel('example', {
      id: 'current-model',
      name: 'Current Model',
      capabilities: {
        tools: true,
        input: ['text', 'image'],
        output: ['text'],
      },
    });

    expect(result).toEqual({
      id: 'current-model',
      providerId: 'example',
      name: 'Current Model',
      tool_call: true,
      modalities: { input: ['text', 'image'], output: ['text'] },
    });
  });
});
